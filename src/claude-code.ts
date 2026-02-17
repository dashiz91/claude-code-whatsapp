/**
 * Claude Code CLI integration.
 *
 * Spawns `claude` CLI as a child process per message, using --resume
 * for conversation continuity and --output-format json for structured output.
 * One process at a time per chat — additional messages are queued.
 *
 * Key: stdin must be "ignore" (not "pipe") or claude hangs waiting for input.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours max per response
const PROGRESS_INTERVAL_MS = 30_000; // "Still working..." every 30s
const SESSIONS_FILE = path.resolve('./auth_state/claude_sessions.json');

interface QueuedMessage {
  message: string;
  resolve: (result: string) => void;
  reject: (err: Error) => void;
  onProgress?: (msg: string) => void;
  sessionRecoveryTried?: boolean;
}

interface ClaudeResult {
  type: string;
  result: string;
  session_id: string;
}

interface ClaudeRuntime {
  command: string;
  prefixArgs: string[];
  shell: boolean;
}

let projectDir: string;
let model: string | undefined;
let claudeRuntime: ClaudeRuntime | null = null;

// Per-chat state
const sessions = new Map<string, string>(); // chatId -> sessionId
const busy = new Map<string, boolean>();
const queues = new Map<string, QueuedMessage[]>();

export function init(options: { projectDir: string; model?: string }): void {
  projectDir = options.projectDir;
  model = options.model;
  claudeRuntime = resolveClaudeRuntime();
  loadSessionsFromDisk();
  log(`Loaded ${sessions.size} saved session(s) from disk.`);
  log(`Initialized — projectDir: ${projectDir}, model: ${model || '(default)'}`);
  log(
    `Runtime command: ${claudeRuntime.command} ${formatArgsForLog(claudeRuntime.prefixArgs)} ` +
      `(shell=${claudeRuntime.shell})`,
  );
}

export function sendMessage(
  chatId: string,
  message: string,
  onProgress?: (msg: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const item: QueuedMessage = { message, resolve, reject, onProgress, sessionRecoveryTried: false };

    if (busy.get(chatId)) {
      let queue = queues.get(chatId);
      if (!queue) {
        queue = [];
        queues.set(chatId, queue);
      }
      queue.push(item);
      log(`Queued message for ${chatId} (queue size: ${queue.length})`);
      return;
    }

    processMessage(chatId, item);
  });
}

export function clearSession(chatId: string): void {
  removeSession(chatId);
  log(`Cleared session for ${chatId}`);
}

export function setProjectDir(dir: string): void {
  projectDir = dir;
  log(`Project directory changed to: ${dir}`);
}

export function getProjectDir(): string {
  return projectDir;
}

// ---------------------------------------------------------------------------

function processMessage(chatId: string, item: QueuedMessage): void {
  busy.set(chatId, true);

  const args = buildArgs(chatId, item.message);
  const runtime = claudeRuntime || resolveClaudeRuntime();
  const spawnArgs = [...runtime.prefixArgs, ...args];
  log(`Spawning: ${runtime.command} ${formatArgsForLog(spawnArgs)}`);

  const env = { ...process.env };
  delete env.CLAUDECODE;

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  const proc = spawn(runtime.command, spawnArgs, {
    cwd: projectDir,
    env,
    shell: runtime.shell,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], // stdin IGNORE — critical!
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
    log(`Timeout for ${chatId}, killing`);
  }, TIMEOUT_MS);

  const progressTimer = setInterval(() => {
    item.onProgress?.('Still working on it...');
  }, PROGRESS_INTERVAL_MS);

  proc.stdout.on('data', (data: Buffer) => {
    const chunk = data.toString();
    stdout += chunk;
    log(`[stdout chunk] ${chunk.slice(0, 150)}`);
  });

  proc.stderr.on('data', (data: Buffer) => {
    const chunk = data.toString();
    stderr += chunk;
    log(`[stderr] ${chunk.slice(0, 150)}`);
  });

  proc.on('error', (err) => {
    clearTimeout(timeout);
    clearInterval(progressTimer);
    busy.set(chatId, false);

    // Windows fallback: if ENOENT, try with shell
    if (err.message.includes('ENOENT')) {
      log('ERROR: `claude` not found on PATH');
      item.reject(new Error('Claude Code CLI not found.'));
    } else {
      log(`Spawn error: ${err.message}`);
      item.reject(err);
    }
    drainQueue(chatId);
  });

  proc.on('close', (code) => {
    clearTimeout(timeout);
    clearInterval(progressTimer);

    if (timedOut) {
      busy.set(chatId, false);
      item.reject(new Error('Claude Code timed out after 4 hours.'));
      drainQueue(chatId);
      return;
    }

    log(`Process exited with code ${code}, stdout length: ${stdout.length}`);

    if (code !== 0) {
      const errMsg = stderr.trim() || `Process exited with code ${code}`;
      if (isSessionInUseError(errMsg) && sessions.has(chatId) && !item.sessionRecoveryTried) {
        item.sessionRecoveryTried = true;
        const oldSession = sessions.get(chatId);
        removeSession(chatId);
        log(
          `Session ${oldSession} is locked/in-use. Clearing cached session for ${chatId} and retrying once.`,
        );
        processMessage(chatId, item);
        return;
      }

      busy.set(chatId, false);
      log(`Claude CLI error: ${errMsg}`);
      item.reject(new Error(errMsg));
      drainQueue(chatId);
      return;
    }

    // Parse JSON output
    try {
      const result = parseOutput(stdout);
      if (result.session_id) {
        setSession(chatId, result.session_id);
      }
      busy.set(chatId, false);
      item.resolve(result.result);
    } catch (err: any) {
      log(`Parse failed: ${err.message}`);
      log(`Raw stdout: ${stdout.slice(0, 500)}`);
      busy.set(chatId, false);
      if (stdout.trim()) {
        item.resolve(stdout.trim().slice(0, 2000));
      } else {
        item.reject(new Error(`No response from Claude CLI`));
      }
    }

    drainQueue(chatId);
  });
}

function buildArgs(chatId: string, message: string): string[] {
  const args: string[] = [];

  const sessionId = sessions.get(chatId);
  if (sessionId) {
    args.push('--resume', sessionId);
  }

  args.push('--output-format', 'json');
  args.push('--dangerously-skip-permissions');

  if (model) {
    args.push('--model', model);
  }

  args.push('-p', message);
  return args;
}

function isSessionInUseError(errMsg: string): boolean {
  return /session id .* is already in use/i.test(errMsg);
}

function setSession(chatId: string, sessionId: string): void {
  sessions.set(chatId, sessionId);
  saveSessionsToDisk();
}

function removeSession(chatId: string): void {
  if (!sessions.delete(chatId)) return;
  saveSessionsToDisk();
}

function loadSessionsFromDisk(): void {
  if (!fs.existsSync(SESSIONS_FILE)) return;

  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, string>;
    sessions.clear();
    for (const [chatId, sessionId] of Object.entries(parsed)) {
      if (typeof sessionId === 'string' && sessionId.trim()) {
        sessions.set(chatId, sessionId);
      }
    }
  } catch (err: any) {
    log(`Failed loading saved sessions: ${err?.message || err}`);
  }
}

function saveSessionsToDisk(): void {
  try {
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    const snapshot = Object.fromEntries(sessions.entries());
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (err: any) {
    log(`Failed saving sessions: ${err?.message || err}`);
  }
}

function resolveClaudeRuntime(): ClaudeRuntime {
  if (process.platform !== 'win32') {
    return { command: 'claude', prefixArgs: [], shell: false };
  }

  const explicitCliPath = process.env.CLAUDE_CLI_JS?.trim();
  if (explicitCliPath && fs.existsSync(explicitCliPath)) {
    return {
      command: process.execPath,
      prefixArgs: [explicitCliPath],
      shell: false,
    };
  }

  const candidates: string[] = [];
  if (process.env.APPDATA) {
    candidates.push(
      path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    );
  }

  const prefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX;
  if (prefix) {
    candidates.push(path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return {
        command: process.execPath,
        prefixArgs: [candidate],
        shell: false,
      };
    }
  }

  // Fallback for unusual setups.
  return { command: 'claude', prefixArgs: [], shell: true };
}

function formatArgsForLog(args: string[]): string {
  return args
    .map((arg) => (/[\s"]/u.test(arg) ? JSON.stringify(arg) : arg))
    .join(' ');
}

function parseOutput(stdout: string): ClaudeResult {
  const trimmed = stdout.trim();
  const lines = trimmed.split('\n');

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'result') {
        return {
          type: parsed.type,
          result: parsed.result || '',
          session_id: parsed.session_id || '',
        };
      }
    } catch {}
  }

  try {
    const parsed = JSON.parse(trimmed);
    return {
      type: parsed.type || 'result',
      result: parsed.result || parsed.text || JSON.stringify(parsed),
      session_id: parsed.session_id || '',
    };
  } catch {
    throw new Error('No valid JSON result found');
  }
}

function drainQueue(chatId: string): void {
  const queue = queues.get(chatId);
  if (!queue || queue.length === 0) return;
  const next = queue.shift()!;
  if (queue.length === 0) queues.delete(chatId);
  log(`Draining queue for ${chatId} (${queue?.length || 0} remaining)`);
  processMessage(chatId, next);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [claude-code] ${msg}`);
}
