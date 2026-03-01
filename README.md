# codex-cli-discord

A tiny Discord bot that bridges **Codex CLI** (`codex exec --json`) into Discord.

[中文文档](./README.zh-CN.md)

**Design:** 1 Discord **thread/channel = 1 Codex session** (auto `exec resume`).

## Features

- Slash commands (no `!` required)
- Thread-level session persistence (restart-safe)
- Per-thread workspace directory (keeps file ops isolated)
- Self-healing runtime: auto relogin with backoff after transient Discord/runtime failures
- Two modes:
  - `safe` → `codex exec --full-auto` (sandboxed)
  - `dangerous` → `--dangerously-bypass-approvals-and-sandbox` (full access)
- Optional proxies (Clash / corp proxy): REST via `HTTP_PROXY`, Gateway WS via `SOCKS_PROXY`
- Lightweight UX:
  - reacts `⚡` when starting, `✅` on success, `❌` on failure, `🛑` when cancelled
  - `/name` to label a session
  - per-channel prompt queue (messages are queued instead of rejected)
  - `/cancel` / `!abort` to interrupt the current run and clear queued prompts
  - long-run live progress updates (phase/elapsed/latest step), plus `/progress` / `!progress`
  - `/doctor` / `!doctor` for runtime + security diagnostics
  - `/onboarding` interactive step-by-step onboarding (buttons), `!onboarding` text fallback

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
npm run setup-hooks
npm start
```

Git hooks note:

- Run `npm run setup-hooks` once after clone (or after re-clone).
- The pre-commit atomic check is Node-based and works on macOS/Linux/Windows (no bash required).

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
- `/cx_queue` — show running/queued task count in current channel
- `/cx_doctor` — show bot runtime/security diagnostics
- `/cx_onboarding` — interactive onboarding (step-by-step buttons, ephemeral)
- `/cx_progress` — show latest progress snapshot for the running task
- `/cx_cancel` — interrupt current run and clear queued prompts

## Configuration (.env)

See `.env.example`.

Important knobs:

- `ALLOWED_CHANNEL_IDS` / `ALLOWED_USER_IDS`: lock the bot down (recommended)
- `SECURITY_PROFILE`: `auto | solo | team | public`
  - `auto`: DM -> `solo`; guild channel where `@everyone` can view -> `public`; else `team`
- `MENTION_ONLY`: require bot mention for normal messages (leave empty to use profile default)
- `MAX_QUEUE_PER_CHANNEL`: max queued prompts per channel (`0` = unlimited; leave empty to use profile default)
- `ENABLE_CONFIG_CMD`: enable/disable `!config` command (default `false`)
- `CONFIG_ALLOWLIST`: allowed keys for `!config key=value` (comma-separated, or `*` to allow all)
- `SLASH_PREFIX`: slash prefix, default `cx` (e.g. `/cx_status`)
- `DEFAULT_MODE`: `safe` or `dangerous`
- `WORKSPACE_ROOT`: where per-thread folders are created
- `CODEX_BIN`: codex command/path (default `codex`)
- `CODEX_TIMEOUT_MS`: hard timeout per codex run (ms). `0` disables timeout.
- `PROGRESS_UPDATES_ENABLED`: enable/disable live progress updates in channel (default `true`)
- `PROGRESS_UPDATE_INTERVAL_MS`: heartbeat refresh interval for progress message
- `PROGRESS_EVENT_FLUSH_MS`: min interval for event-triggered progress edits
- `PROGRESS_TEXT_PREVIEW_CHARS`: truncation length for “latest step” preview
- `PROGRESS_INCLUDE_STDERR`: include raw stderr lines in progress preview (noisy; default `false`)
- `PROGRESS_PLAN_MAX_LINES`: max plan lines shown in progress (default `4`)
- `PROGRESS_DONE_STEPS_MAX`: max completed key steps shown in progress (default `4`)
- `PROGRESS_MESSAGE_MAX_CHARS`: max rendered chars per progress message (default `1800`)
- `SELF_HEAL_ENABLED`: enable runtime self-healing (default `true`)
- `SELF_HEAL_RESTART_DELAY_MS`: delay before self-heal restart (default `5000`)
- `SELF_HEAL_MAX_LOGIN_BACKOFF_MS`: max retry backoff for Discord login (default `60000`)
- `MAX_INPUT_TOKENS_BEFORE_COMPACT`: compact threshold
- `COMPACT_STRATEGY`: `hard | native | off`
  - `hard`: bot summarizes then switches to a new session
  - `native`: pass `model_auto_compact_token_limit` to Codex CLI and continue same session
  - `off`: disable compact behavior
- `COMPACT_ON_THRESHOLD`: enable/disable threshold-triggered compact logic

## Auto-upgrade Codex CLI (Optional Scheduler Adapter)

This repo includes a cross-platform updater for `codex` that can:

- check for updates on a schedule
- auto-upgrade `codex`
- restart your bot service after a successful upgrade

Install (auto-select scheduler by OS: macOS=`launchd`, Windows=`Task Scheduler`, others=`none`):

```bash
npm run install:auto-upgrade
```

Custom schedule (example: every day at `03:40`):

```bash
SCHEDULE_HOUR=3 SCHEDULE_MINUTE=40 npm run install:auto-upgrade
```

Disable scheduler but keep manual updater:

```bash
AUTO_UPGRADE_SCHEDULER=none npm run install:auto-upgrade
```

Manual run (for smoke test):

```bash
npm run run:auto-upgrade
```

Manual run (dry-run; no package/service changes):

```bash
CODEX_UPGRADE_DRY_RUN=1 npm run run:auto-upgrade
```

### macOS (`launchd`)

Default IDs:

- Upgrade service label: `com.atou.codex-cli-auto-upgrade` (`LABEL`)
- Bot service label: `com.atou.codex-discord-bot` (`BOT_LABEL`)

Check service and logs:

```bash
launchctl print gui/$(id -u)/com.atou.codex-cli-auto-upgrade
tail -n 100 logs/codex-auto-upgrade.log
tail -n 100 logs/codex-auto-upgrade.err.log
```

Remove service:

```bash
launchctl bootout gui/$(id -u)/com.atou.codex-cli-auto-upgrade
rm -f ~/Library/LaunchAgents/com.atou.codex-cli-auto-upgrade.plist
```

### Windows (`Task Scheduler`)

PowerShell install (equivalent to `npm run install:auto-upgrade`):

```powershell
$env:SCHEDULE_HOUR='5'
$env:SCHEDULE_MINUTE='15'
$env:TASK_NAME='codex-cli-auto-upgrade'
$env:BOT_TASK_NAME='codex-discord-bot'
node scripts/install-codex-auto-upgrade.mjs
```

Defaults:

- Upgrade task name: `codex-cli-auto-upgrade` (`TASK_NAME` or `LABEL`)
- Bot restart task: `codex-discord-bot` (`BOT_TASK_NAME` or `BOT_LABEL`)

Inspect/remove task:

```powershell
schtasks /Query /TN "codex-cli-auto-upgrade" /V /FO LIST
schtasks /Delete /TN "codex-cli-auto-upgrade" /F
```

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
Windows example (PowerShell path):
```env
CODEX_BIN=C:\\Users\\<you>\\AppData\\Local\\Programs\\Codex\\codex.exe
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
