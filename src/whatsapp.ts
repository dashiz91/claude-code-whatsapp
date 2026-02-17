/**
 * WhatsApp connection via Baileys.
 *
 * Handles QR authentication, credential persistence, reconnection
 * with exponential backoff, and message routing.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  proto,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import path from 'path';
import { sendMessage, clearSession, setProjectDir, getProjectDir } from './claude-code.js';
import { markdownToWhatsApp, chunkMessage } from './formatter.js';

const AUTH_DIR = path.resolve('./auth_state');
const logger = pino({ level: 'silent' });
const MAX_440_RETRIES = 10;
const MAX_SEND_RETRIES = 8;
const SEND_RETRY_DELAY_MS = 2000;
const SEND_WAIT_FOR_SOCKET_TIMEOUT_MS = 10_000;
const STABLE_CONNECTION_RESET_MS = 20_000;

let sock: WASocket | null = null;
let allowedJid: string;
let selfLid: string | null = null; // user's @lid JID for self-chat
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let activeConnectPromise: Promise<void> | null = null;
let isSocketOpen = false;
let shuttingDown = false;
let socketGeneration = 0;
let lastOpenAt = 0;

export async function startWhatsApp(allowedPhone: string): Promise<void> {
  shuttingDown = false;
  allowedJid = `${allowedPhone}@s.whatsapp.net`;
  log(`Allowed JID: ${allowedJid}`);
  await connect();
}

async function connect(): Promise<void> {
  if (shuttingDown) return;

  if (activeConnectPromise) {
    log('Connect already in progress, skipping duplicate call.');
    return activeConnectPromise;
  }

  activeConnectPromise = (async () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const generation = ++socketGeneration;
    teardownSocket();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const nextSocket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: ['WhatsApp-Claude', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      logger,
      generateHighQualityLinkPreview: false,
    });

    sock = nextSocket;
    isSocketOpen = false;

    nextSocket.ev.on('creds.update', saveCreds);

    nextSocket.ev.on('connection.update', async (update) => {
      // Ignore stale events from older sockets.
      if (generation !== socketGeneration || nextSocket !== sock) return;

      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        log('Scan this QR code with WhatsApp on your phone:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        isSocketOpen = true;
        lastOpenAt = Date.now();

        // Capture the user's LID for self-chat detection.
        const user = nextSocket.user;
        if (user?.lid) {
          // Strip device suffix (e.g. "91470002450517:5@lid" → "91470002450517@lid")
          selfLid = user.lid.replace(/:.*@/, '@');
          log(`Self LID: ${selfLid}`);
        } else {
          selfLid = null;
          log('Warning: could not resolve self LID from socket user.');
        }

        log('Connected to WhatsApp!');
        return;
      }

      if (connection !== 'close') return;

      isSocketOpen = false;
      const wasStable = lastOpenAt > 0 && Date.now() - lastOpenAt >= STABLE_CONNECTION_RESET_MS;
      lastOpenAt = 0;
      if (wasStable) {
        reconnectAttempts = 0;
      }
      if (shuttingDown) return;

      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        log('Session logged out (401). Clearing credentials. Scan QR again.');
        const fs = await import('fs');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        reconnectAttempts = 0;
        scheduleReconnect(3000);
        return;
      }

      if (statusCode === 440) {
        reconnectAttempts += 1;
        if (reconnectAttempts > MAX_440_RETRIES) {
          log(`Too many 440 disconnects (${reconnectAttempts}). Stopping reconnect loop.`);
          return;
        }
        const delay = Math.min(10_000 * reconnectAttempts, 60_000);
        log(
          `Connection replaced (440). Likely another active instance/session is using this auth state. ` +
            `Waiting ${delay / 1000}s (attempt ${reconnectAttempts})...`,
        );
        scheduleReconnect(delay);
        return;
      }

      reconnectAttempts += 1;
      const delay = Math.min(2000 * Math.pow(2, reconnectAttempts - 1), 60_000);
      log(`Disconnected (code ${statusCode}). Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
      scheduleReconnect(delay);
    });

    // Handle incoming messages: only "notify" (real-time), ignore "append" (history).
    nextSocket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (generation !== socketGeneration || nextSocket !== sock) return;
      if (type !== 'notify') return;

      for (const msg of messages) {
        await handleMessage(msg);
      }
    });
  })();

  try {
    await activeConnectPromise;
  } finally {
    activeConnectPromise = null;
  }
}

function scheduleReconnect(delay: number): void {
  if (shuttingDown) return;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect().catch((err: any) => {
      log(`Reconnect failed: ${err?.message || err}`);
    });
  }, delay);
}

function teardownSocket(): void {
  if (!sock) return;

  try {
    sock.ev.removeAllListeners('connection.update');
    sock.ev.removeAllListeners('messages.upsert');
    sock.ev.removeAllListeners('creds.update');
    sock.end(undefined);
  } catch {}

  sock = null;
  isSocketOpen = false;
  lastOpenAt = 0;
}

async function handleMessage(msg: proto.IWebMessageInfo): Promise<void> {
  if (!sock || !msg.key) return;
  if (msg.key.remoteJid === 'status@broadcast') return;

  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith('@g.us')) return;

  // Only respond to messages in "self chat" (Message Yourself).
  // Self-chat JID can be your number@s.whatsapp.net or your specific @lid.
  const isSelfJid = jid === allowedJid || (selfLid !== null && jid === selfLid);

  if (!msg.key.fromMe || !isSelfJid) {
    return;
  }

  const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
  if (!text.trim()) return;

  const preview = text.slice(0, 50).replace(/\n/g, ' ');
  log(`Incoming from ${jid}: "${preview}${text.length > 50 ? '...' : ''}"`);

  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Commands
  if (lower === '/clear') {
    clearSession(jid);
    await safeSend(jid, 'Session cleared. Next message starts a fresh conversation.');
    return;
  }

  if (lower === '/session new' || lower === '/session reset') {
    clearSession(jid);
    await safeSend(jid, 'Started a new Claude Code session.');
    return;
  }

  if (lower.startsWith('/project ')) {
    const newDir = trimmed.slice('/project '.length).trim();
    if (!newDir) {
      await safeSend(jid, `Current project directory: ${getProjectDir()}`);
      return;
    }
    setProjectDir(newDir);
    clearSession(jid);
    await safeSend(jid, `Project directory changed to: ${newDir}\nSession reset for new context.`);
    return;
  }

  if (lower === '/project') {
    await safeSend(jid, `Current project directory: ${getProjectDir()}`);
    return;
  }

  if (lower === '/help') {
    await safeSend(
      jid,
      '*Commands:*\n' +
        '/clear -- Reset conversation session\n' +
        '/session new -- Start a fresh session\n' +
        '/project -- Show current working directory\n' +
        '/project <path> -- Change working directory (resets session)\n' +
        '/help -- Show this help message',
    );
    return;
  }

  // Show typing indicator.
  try {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate('composing', jid);
  } catch {}

  const workingTimer = setTimeout(async () => {
    try {
      await safeSend(jid, 'Working on it...');
    } catch {}
  }, 3000);

  try {
    const response = await sendMessage(jid, trimmed, async (progressMsg: string) => {
      try {
        await safeSend(jid, progressMsg);
      } catch {}
    });

    clearTimeout(workingTimer);

    const formatted = markdownToWhatsApp(response);
    const chunks = chunkMessage(formatted);

    for (const chunk of chunks) {
      await safeSend(jid, chunk);
      log(`Sent to ${jid}: "${chunk.slice(0, 50).replace(/\n/g, ' ')}${chunk.length > 50 ? '...' : ''}"`);
    }
  } catch (err: any) {
    clearTimeout(workingTimer);
    log(`Error processing message: ${err.message}`);
    try {
      await safeSend(jid, `Error: ${err.message?.slice(0, 500)}`);
    } catch {}
  } finally {
    try {
      await sock?.sendPresenceUpdate('paused', jid);
    } catch {}
  }
}

/**
 * Send with retry: waits for reconnection if socket is temporarily down.
 */
async function safeSend(jid: string, text: string): Promise<void> {
  for (let attempt = 1; attempt <= MAX_SEND_RETRIES; attempt++) {
    try {
      const ready = await waitForSocketOpen(SEND_WAIT_FOR_SOCKET_TIMEOUT_MS);
      if (!ready) {
        log(`Send waiting for reconnect timed out (attempt ${attempt}/${MAX_SEND_RETRIES}).`);
      } else if (sock) {
        await sock.sendMessage(jid, { text });
        return;
      }
    } catch (err: any) {
      log(`Send failed (attempt ${attempt}/${MAX_SEND_RETRIES}): ${err?.message || err}`);
    }

    await sleep(SEND_RETRY_DELAY_MS);
  }

  log('Failed to send after retries.');
}

async function waitForSocketOpen(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shuttingDown) return false;
    if (sock && isSocketOpen) return true;
    await sleep(250);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (sock) {
    log('Closing WhatsApp connection...');
  }
  teardownSocket();
}

// Prevent crashes.
process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}`);
});
process.on('unhandledRejection', (err: any) => {
  log(`Unhandled rejection: ${err?.message || err}`);
});

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [whatsapp] ${msg}`);
}
