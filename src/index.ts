/**
 * WhatsApp-to-Claude Code Bridge
 *
 * Entry point — loads config, initializes Claude Code CLI integration,
 * starts WhatsApp, and handles graceful shutdown.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { init } from './claude-code.js';
import { startWhatsApp, shutdown } from './whatsapp.js';

const LOCK_DIR = path.resolve('./auth_state');
const LOCK_PATH = path.join(LOCK_DIR, 'bridge.lock');
let lockFd: number | null = null;

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [main] ${msg}`);
}

function acquireSingleInstanceLock(): void {
  fs.mkdirSync(LOCK_DIR, { recursive: true });

  try {
    lockFd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeSync(lockFd, `${process.pid}\n`);
    return;
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
  }

  let existingPid: number | null = null;
  try {
    const raw = fs.readFileSync(LOCK_PATH, 'utf8').trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) existingPid = parsed;
  } catch {}

  if (existingPid && !isProcessAlive(existingPid)) {
    try {
      fs.unlinkSync(LOCK_PATH);
    } catch {}
    lockFd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeSync(lockFd, `${process.pid}\n`);
    return;
  }

  const pidText = existingPid ? ` (PID ${existingPid})` : '';
  throw new Error(
    `Another whatsapp-claude instance is already running${pidText}. Stop it before starting a new one.`,
  );
}

function releaseSingleInstanceLock(): void {
  if (lockFd !== null) {
    try {
      fs.closeSync(lockFd);
    } catch {}
    lockFd = null;
  }

  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {}
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  log('Starting WhatsApp-Claude Code bridge...');
  acquireSingleInstanceLock();

  // Validate required env vars
  const allowedPhone = process.env.ALLOWED_PHONE;
  if (!allowedPhone) {
    console.error('ALLOWED_PHONE is required. Set it to your phone number (e.g. 14155551234).');
    process.exit(1);
  }

  const projectDir = process.env.PROJECT_DIR;
  if (!projectDir) {
    console.error('PROJECT_DIR is required. Set it to the directory Claude Code should work in.');
    process.exit(1);
  }

  const model = process.env.CLAUDE_MODEL || undefined;

  // Initialize Claude Code
  init({ projectDir, model });

  // Start WhatsApp
  await startWhatsApp(allowedPhone);

  log('Bridge is running. Send a WhatsApp message to interact with Claude Code.');
  log('Commands: /clear, /session new, /project <path>, /help');

  // Graceful shutdown
  const onShutdown = () => {
    log('Shutting down...');
    shutdown();
    releaseSingleInstanceLock();
    process.exit(0);
  };

  process.on('SIGINT', onShutdown);
  process.on('SIGTERM', onShutdown);
}

main().catch((err) => {
  releaseSingleInstanceLock();
  console.error('Fatal error:', err);
  process.exit(1);
});
