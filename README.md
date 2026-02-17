# WhatsApp-Claude Code Bridge

Send a WhatsApp message to yourself, get [Claude Code](https://docs.anthropic.com/en/docs/claude-code) responses back. Full CLI capabilities — file reading, editing, running commands, tools — all from your phone.

**No MCP server. No Go compiler. No Python. Just `npx` and go.**

## How It Works

```
You (WhatsApp)  →  Bridge  →  Claude Code CLI  →  Your Codebase
       ↑                                               |
       └───────────────  Response  ←────────────────────┘
```

1. You send a message in your WhatsApp **"Message Yourself"** chat
2. The bridge picks it up and spawns Claude Code with your message
3. Claude Code works on your project (reads files, edits code, runs tests)
4. The response is sent back to your WhatsApp

Only messages in your self-chat trigger the bridge. Messages to other people are completely ignored.

## Quick Start

### Prerequisites

- [Node.js 18+](https://nodejs.org)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` command on your PATH)

### Option A: npx (zero install)

```bash
mkdir claude-code-whatsapp && cd claude-code-whatsapp
npx claude-code-whatsapp
```

First run launches an interactive setup wizard:

```
  WhatsApp-Claude Code Bridge — Setup

  Your phone number (international, no +, e.g. 14155551234): 14155551234
  Project directory for Claude Code (/current/dir): /path/to/your/project
  Claude model (claude-opus-4-6):

  Created .env — run the same command again to start the bridge.
```

Then run again to start:

```bash
npx claude-code-whatsapp
```

### Option B: Clone and run

```bash
git clone https://github.com/dashiz91/claude-code-whatsapp.git
cd claude-code-whatsapp
npm install
```

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```env
# Your phone number — international format, no + prefix
ALLOWED_PHONE=14155551234

# The directory Claude Code will work in
PROJECT_DIR=/path/to/your/project

# Claude model (defaults to claude-opus-4-6)
# CLAUDE_MODEL=claude-opus-4-6
```

Start the bridge:

```bash
npm run dev
```

### Scan the QR Code

On first launch, a QR code appears in your terminal:

```
Scan this QR code with WhatsApp on your phone:
█████████████████████████████
█████████████████████████████
████ ▄▄▄▄▄ █ ▀▄█ █ ▄▄▄▄▄ ████
...
```

Open WhatsApp on your phone → **Settings** → **Linked Devices** → **Link a Device** → scan the QR code.

The session persists in `auth_state/` — you only need to scan once. If the session expires (~20 days), a new QR code will appear automatically.

### Send a message

Open the **"Message Yourself"** chat in WhatsApp and type anything:

> What files are in the src directory?

Claude Code processes it and responds right in the chat.

## Commands

| Command | Description |
|---------|-------------|
| `/clear` | Reset conversation session |
| `/session new` | Start a fresh Claude Code session |
| `/project` | Show current working directory |
| `/project <path>` | Change working directory (resets session) |
| `/help` | Show available commands |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ALLOWED_PHONE` | Yes | Your phone number, international format without `+` (e.g. `14155551234`) |
| `PROJECT_DIR` | Yes | Working directory for Claude Code |
| `CLAUDE_MODEL` | No | Claude model to use (defaults to `claude-opus-4-6`) |

## Security

- **Self-chat only** — the bridge only responds to messages you send to yourself. Messages to or from other people are completely ignored.
- **Local execution** — Claude Code runs on your machine (or server). No data is sent to third parties beyond the Anthropic API.
- **No message storage** — the bridge doesn't store or log message content. WhatsApp credentials stay in `auth_state/` (gitignored).

## Deploy to a Server (Cloud)

Run on any VPS with Node.js and Claude Code CLI:

```bash
git clone https://github.com/dashiz91/claude-code-whatsapp.git
cd claude-code-whatsapp
npm install && npm run build
```

Set up your `.env`, then:

```bash
npm start
```

Scan the QR code once (SSH into the server or use the terminal). After that, the session persists and you can control your codebase from anywhere via WhatsApp.

For long-running deployment, use `pm2` or `systemd`:

```bash
npm install -g pm2
pm2 start dist/cli.js --name claude-code-whatsapp
pm2 save
```

## How It's Different from WhatsApp MCP

| | **claude-code-whatsapp** | **WhatsApp MCP** |
|---|---|---|
| **Direction** | Phone → Claude (you control Claude from WhatsApp) | Claude → WhatsApp (Claude reads/sends your chats) |
| **Setup** | `npx claude-code-whatsapp` | Go compiler + Python + C compiler + MCP config |
| **Processes** | Single process | Two (Go bridge + Python server) |
| **Privacy** | Self-chat only, no access to other conversations | Exposes all chats to Claude |
| **Cloud deploy** | Yes, any server with Node.js | No, requires Claude Desktop locally |

## Built by

[Roberto M](https://github.com/dashiz91) / [@dashiz91](https://github.com/dashiz91)

## License

[MIT](LICENSE) - 2026
