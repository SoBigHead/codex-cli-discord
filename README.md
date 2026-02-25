# codex-cli-discord

A tiny Discord bot that bridges **Codex CLI** (`codex exec --json`) into Discord.

**Design:** 1 Discord **thread/channel = 1 Codex session** (auto `exec resume`).

## Features

- Slash commands (no `!` required)
- Thread-level session persistence (restart-safe)
- Per-thread workspace directory (keeps file ops isolated)
- Two modes:
  - `safe` → `codex exec --full-auto` (sandboxed)
  - `dangerous` → `--dangerously-bypass-approvals-and-sandbox` (full access)
- Optional proxies (Clash / corp proxy): REST via `HTTP_PROXY`, Gateway WS via `SOCKS_PROXY`
- Lightweight UX:
  - reacts `⚡` when starting, `✅` on success, `❌` on failure
  - `/name` to label a session

## Prerequisites

- Node.js 18+
- `codex` CLI installed and working in your shell
  - If running under pm2/launchd/systemd, you may need `CODEX_BIN=/absolute/path/to/codex` in `.env`
- A **separate** Discord Application/Bot token (don’t reuse OpenClaw’s token)

## Quickstart

```bash
git clone <YOUR_REPO_URL>
cd codex-cli-discord
cp .env.example .env
npm install
npm start
```

Then in your Discord server, invite the bot, and use these slash commands:

- `/cx_status` — show current thread config
- `/cx_setdir <path>` — set workspace dir for current thread
- `/cx_model <name|default>` — set model override
- `/cx_effort <high|medium|low|default>` — set reasoning effort
- `/cx_mode <safe|dangerous>` — set execution mode
- `/cx_name <label>` — name the session (for display)
- `/cx_reset` — clear current thread session
- `/cx_resume <session_id>` — bind an existing Codex session id
- `/cx_sessions` — list recent local Codex sessions

## Configuration (.env)

See `.env.example`.

Important knobs:

- `ALLOWED_CHANNEL_IDS` / `ALLOWED_USER_IDS`: lock the bot down (recommended)
- `SLASH_PREFIX`: slash prefix, default `cx` (e.g. `/cx_status`)
- `DEFAULT_MODE`: `safe` or `dangerous`
- `WORKSPACE_ROOT`: where per-thread folders are created
- `CODEX_BIN`: codex command/path (default `codex`)

## Troubleshooting

### `spawn codex ENOENT`

This means the bot process cannot find the Codex CLI executable in its runtime environment.

1. Check the installed path on that machine:
```bash
which codex
```
2. Put the absolute path into `.env`:
```env
CODEX_BIN=/opt/homebrew/bin/codex
```
3. Restart the bot process.

You can also run `/cx_status` (or your custom slash prefix + `_status`) to see codex-cli health in bot output.

## Proxy / Clash setup (optional)

If you are behind a proxy:

- Discord REST API: set `HTTP_PROXY=http://127.0.0.1:7890`
- Discord Gateway WebSocket: set `SOCKS_PROXY=socks5h://127.0.0.1:7891`

This repo includes a **best-effort patch script** for `@discordjs/ws` (run automatically on `npm install`) so the Gateway can use a custom agent:

```bash
npm run patch-ws
```

If your HTTP proxy does TLS MITM and you *must* bypass verification:

```env
INSECURE_TLS=1
```

(Strongly discouraged. Prefer a clean SOCKS tunnel.)

## OpenClaw notes

Many people run this bot alongside their own OpenClaw:

- Keep it as a **separate Discord app**
- Use OpenClaw to manage/monitor the process (pm2/launchd/docker) if you like
- The bot is intentionally self-contained: just `.env + npm start`

## Security

- `dangerous` means **no sandbox**. Codex will run with your user permissions.
- Don’t commit `.env` / session files. `.gitignore` is set up for that.
- If you ever leaked a bot token, **rotate it immediately** in Discord Developer Portal.

## License

MIT
