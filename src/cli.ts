#!/usr/bin/env node
/**
 * CLI entrypoint for `npx whatsapp-claude`.
 *
 * If no .env exists, runs an interactive setup wizard.
 * Otherwise, launches the bridge directly.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const ENV_PATH = path.resolve(process.cwd(), '.env');
const ENV_EXAMPLE_PATH = path.resolve(process.cwd(), '.env.example');

function ask(rl: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

async function setup(): Promise<void> {
  console.log('\n  WhatsApp-Claude Code Bridge — Setup\n');
  console.log('  This will create a .env file in the current directory.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const phone = await ask(rl, '  Your phone number (international, no +, e.g. 14155551234)');
    if (!phone || !/^\d{7,15}$/.test(phone)) {
      console.error('\n  Invalid phone number. Must be 7-15 digits, no spaces or dashes.');
      process.exit(1);
    }

    const projectDir = await ask(rl, '  Project directory for Claude Code', process.cwd());
    const model = await ask(rl, '  Claude model', 'claude-opus-4-6');

    const lines = [
      `ALLOWED_PHONE=${phone}`,
      '',
      `PROJECT_DIR=${projectDir}`,
      '',
      `CLAUDE_MODEL=${model}`,
      '',
    ];

    fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');
    console.log(`\n  Created .env — run the same command again to start the bridge.\n`);
  } finally {
    rl.close();
  }
}

async function run(): Promise<void> {
  if (!fs.existsSync(ENV_PATH)) {
    await setup();
    return;
  }

  // .env exists — load it and start the bridge.
  await import('./index.js');
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
