# Agents in Discord

A standalone Discord bot that lets you direct **Codex CLI**, **Claude Code**, and **Gemini CLI** from inside Discord.

> This project is a standalone Discord bot / bridge. It is **not** an OpenClaw plugin, and it does **not** depend on OpenClaw to run.

[简体中文](./README.md)

**Maintainers:** [ATou](https://github.com/atou42) and [Lark](https://github.com/Larkspur-Wang).

**Design:** 1 Discord **thread/channel = 1 CLI session** (auto resume for the active provider).

## Features

- Slash commands (no `!` required)
- Thread-level session persistence (restart-safe)
- Flexible workspace model: thread override, provider default, plus legacy per-thread fallback
- Provider-aware runtime surface:
  - Codex: rollout sessions, global `~/.codex/sessions` history, raw config passthrough, configurable `native_limit`
  - Claude: project sessions, portable resume across workspaces, provider-default native compaction
  - Gemini: chat sessions, workspace-bound resume, provider-default native compaction
- Self-healing runtime: auto relogin with backoff after transient Discord/runtime failures
- Workspace-level serialization so the same workspace is never executed concurrently across channels/bots
- Two modes:
  - `safe` → `codex exec --full-auto` (sandboxed)
  - `dangerous` → `--dangerously-bypass-approvals-and-sandbox` (full access)
- Optional proxies (Clash / corp proxy): REST via `HTTP_PROXY`, Gateway WS via `SOCKS_PROXY`
- Lightweight UX:
  - reacts `⚡` when starting, `✅` on success, `❌` on failure, `🛑` when cancelled
  - `/name` to label a session
  - per-channel prompt queue (messages are queued instead of rejected)
  - `/cancel` / `/abort` / `!cancel` / `!c` / `!abort` to interrupt the current run and clear queued prompts
  - long-run live progress updates (phase/elapsed/latest step), plus `/progress` / `!progress`
  - `/doctor` / `!doctor` for runtime + security diagnostics
  - `/onboarding` interactive onboarding wizard (buttons + direct config), `!onboarding` text fallback
  - per-thread onboarding switch (`on/off/status`) and message language (`zh/en`, default `zh`)
  - per-thread security profile override (`auto|solo|team|public`)
  - per-thread runner timeout override (`ms|off|status`)

## Prerequisites

- Node.js 18+
- Install the CLI(s) you plan to use
  - Codex: `codex` available in shell, or set `CODEX_BIN=/absolute/path/to/codex`
  - Claude: `claude` available in shell, or set `CLAUDE_BIN=/absolute/path/to/claude`
  - Gemini: `gemini` available in shell, or set `GEMINI_BIN=/absolute/path/to/gemini`
- If the CLI itself needs login, complete that in the CLI first; this project does not manage provider auth in `.env`
- One or two Discord Application/Bot tokens
  - Shared mode: one bot token is enough
  - Dedicated mode: use separate tokens for Codex, Claude, and Gemini bots

## Quickstart

```bash
git clone https://github.com/atou42/agents-in-discord.git
cd agents-in-discord
cp .env.example .env
npm install
npm run setup-hooks
npm start
```

Git hooks note:

- Run `npm run setup-hooks` once after clone (or after re-clone).
- The pre-commit atomic check is Node-based and works on macOS/Linux/Windows (no bash required).

Then in your Discord server, invite the bot, and use these slash commands. Examples below use the default Codex/shared prefix `cx_`; a dedicated Claude bot defaults to `cc_`, a dedicated Gemini bot defaults to `gm_`, and all can be overridden with `SLASH_PREFIX`, `CODEX__SLASH_PREFIX`, `CLAUDE__SLASH_PREFIX`, or `GEMINI__SLASH_PREFIX`:

- `/cx_status` — show current thread config
- `/cx_setdir <path|default|status>` — set or clear workspace for current thread
- `/cx_setdefaultdir <path|clear|status>` — set provider default workspace
- `/cx_model <name|default>` — set model override
- `/cx_effort <...>` — set reasoning effort; Codex supports `xhigh|high|medium|low|default`, Claude supports `high|medium|low|default`, and Gemini does not expose this command
- `/cx_compact key:<...> value:<...>` — configure compact for the current channel; all three providers support `strategy|token_limit|enabled|reset|status`, while `native_limit` only works where the provider exposes a native limit override (currently mainly Codex)
- `/cx_mode <safe|dangerous>` — set execution mode
- `/cx_name <label>` — name the session (for display)
- `/cx_new` — switch to a fresh session while keeping current channel settings
- `/cx_reset` — clear current thread session and extra config overrides
- `/cx_resume <session_id>` — bind an existing provider-native session id
- `/cx_sessions` — list recent provider-native sessions from the runtime store
- `/cx_queue` — show running/queued task count in current channel
- `/cx_doctor` — show bot runtime/security diagnostics
- `/cx_onboarding` — interactive onboarding (step-by-step buttons, ephemeral)
- `/cx_onboarding_config <on|off|status>` — configure onboarding availability in current channel
- `/cx_language <中文|English>` — set bot message hint language in current channel
- `/cx_profile <auto|solo|team|public|status>` — set or view current channel security profile override
- `/cx_timeout <ms|off|status>` — set current channel runner timeout override
- `/cx_progress` — show latest progress snapshot for the running task
- `/cx_abort` — interrupt current run and clear queued prompts (legacy alias)
- `/cx_cancel` — interrupt current run and clear queued prompts; text aliases: `!cancel` / `!c`, with `!abort` / `!stop` kept for compatibility

Common text-command aliases:

- `!cancel`, `!c`, `!abort`, and `!stop` all interrupt the current run and clear queued prompts

Provider-native session aliases:

- Codex: `/cx_rollout_sessions`, `/cx_rollout_resume`
- Claude: `/cc_project_sessions`, `/cc_project_resume`
- Gemini: `/gm_chat_sessions`, `/gm_chat_resume`
- The canonical `/cx_sessions`, `/cx_resume`, `!sessions`, and `!resume` still work; dedicated bots narrow the help text to the current provider's native terminology

If you want **separate Discord bots** for Codex, Claude, and Gemini, keep everything in one `.env`, but group provider-specific values with clear prefixes:

```bash
# one-time setup
cp .env.example .env

# start dedicated bots
npm run start:codex
npm run start:claude
npm run start:gemini
```

Use plain keys for shared Discord/runtime settings, then put dedicated bot settings under `CODEX__*`, `CLAUDE__*`, and `GEMINI__*` sections in the same file. In practice, you usually only need `DISCORD_TOKEN`, optional `DEFAULT_MODEL`, optional `DEFAULT_MODE`, and optional CLI path overrides. Each locked instance uses its own state files (`data/sessions.codex.json`, `data/sessions.claude.json`, `data/sessions.gemini.json`) and its own process lock, so channel/session context does not mix across bots.

## Configuration (.env)

See `.env.example`.

Important knobs:

- `ALLOWED_CHANNEL_IDS` / `ALLOWED_USER_IDS`: lock the bot down (recommended); dedicated bots can also use `CODEX__ALLOWED_*` / `CLAUDE__ALLOWED_*` / `GEMINI__ALLOWED_*`
- Shared `.env` keys: Discord/runtime settings only (`ALLOWED_*`, `WORKSPACE_ROOT`, `DEFAULT_WORKSPACE_DIR`, proxy, etc.)
- `CODEX__*`: Codex bot section in the same `.env` (normally `CODEX__DISCORD_TOKEN`, plus optional `CODEX__DEFAULT_MODEL`, `CODEX__DEFAULT_MODE`, `CODEX__DEFAULT_WORKSPACE_DIR`, `CODEX__MAX_INPUT_TOKENS_BEFORE_COMPACT`, `CODEX__CODEX_BIN`)
- `CLAUDE__*`: Claude bot section in the same `.env` (normally `CLAUDE__DISCORD_TOKEN`, plus optional `CLAUDE__DEFAULT_MODEL`, `CLAUDE__DEFAULT_MODE`, `CLAUDE__DEFAULT_WORKSPACE_DIR`, `CLAUDE__CLAUDE_BIN`)
- `GEMINI__*`: Gemini bot section in the same `.env` (normally `GEMINI__DISCORD_TOKEN`, plus optional `GEMINI__DEFAULT_MODEL`, `GEMINI__DEFAULT_MODE`, `GEMINI__DEFAULT_WORKSPACE_DIR`, `GEMINI__GEMINI_BIN`)
- `BOT_PROVIDER`: leave empty for shared mode, or set `codex` / `claude` / `gemini` to lock one bot instance to a single provider; `npm run start:codex` / `npm run start:claude` / `npm run start:gemini` set this automatically
- `ENV_FILE`: optional extra overlay file if you really need one, but the normal setup is now a single grouped `.env`
- `DISCORD_TOKEN_CODEX` / `DISCORD_TOKEN_CLAUDE` / `DISCORD_TOKEN_GEMINI`: legacy fallback for older single-file setups
- Provider auth is outside this project's config surface; keep CLI-specific login or secrets outside this `.env` unless you intentionally need them for your own runtime
- `SECURITY_PROFILE`: `auto | solo | team | public`
  - `auto`: DM -> `solo`; guild channel where `@everyone` can view -> `public`; else `team`
- `MENTION_ONLY`: require bot mention for normal messages (leave empty to use profile default)
- `MAX_QUEUE_PER_CHANNEL`: max queued prompts per channel (`0` = unlimited; leave empty to use profile default)
- `ENABLE_CONFIG_CMD`: enable/disable `!config` command (default `false`)
- `CONFIG_ALLOWLIST`: allowed keys for `!config key=value` (comma-separated, or `*` to allow all)
- `SLASH_PREFIX`: shared/global slash prefix; default `cx` in shared mode (e.g. `/cx_status`)
- `CODEX__SLASH_PREFIX` / `CLAUDE__SLASH_PREFIX` / `GEMINI__SLASH_PREFIX`: dedicated-bot slash prefix overrides; defaults are `cx` for Codex, `cc` for Claude, and `gm` for Gemini
- `DEFAULT_UI_LANGUAGE`: default bot message language for new channels (`zh` or `en`, default `zh`)
- `ONBOARDING_ENABLED_DEFAULT`: onboarding default for new channels (`true` or `false`, default `true`)
- `DEFAULT_MODE`: `safe` or `dangerous`; the example `.env` now uses **`dangerous` by default** so local devs get full power out of the box. For shared / prod servers you should:
  - change `CODEX__DEFAULT_MODE` / `CLAUDE__DEFAULT_MODE` / `GEMINI__DEFAULT_MODE` back to `safe` in `.env`, and only enable `/cx_mode dangerous` in trusted channels; or
  - run the bot in a private guild where you trust all members
- `DEFAULT_WORKSPACE_DIR`: optional shared default workspace for all providers
- `CODEX__DEFAULT_WORKSPACE_DIR` / `CLAUDE__DEFAULT_WORKSPACE_DIR` / `GEMINI__DEFAULT_WORKSPACE_DIR`: provider-specific default workspaces that override the shared default
- `WORKSPACE_ROOT`: legacy fallback root used only when neither thread override nor provider default is configured
- `CODEX_BIN`: codex command/path (default `codex`)
- `CLAUDE_BIN`: claude command/path (default `claude`)
- `CODEX_TIMEOUT_MS`: default runner hard timeout (ms). Today all three providers share this default; `0` disables timeout, and `/cx_timeout` / `!timeout` can still override it per thread.
- `PROGRESS_UPDATES_ENABLED`: enable/disable live progress updates in channel (default `true`)
- `PROGRESS_UPDATE_INTERVAL_MS`: heartbeat refresh interval for progress message
- `PROGRESS_EVENT_FLUSH_MS`: min interval for event-triggered progress edits
- `PROGRESS_EVENT_DEDUPE_WINDOW_MS`: dedupe window for semantically identical progress events (stdout + rollout bridge), in ms (default `2500`)
- `PROGRESS_TEXT_PREVIEW_CHARS`: truncation length for “latest step” preview
- `PROGRESS_INCLUDE_STDOUT`: include non-JSON stdout lines in progress activity (default `true`)
- `PROGRESS_INCLUDE_STDERR`: include raw stderr lines in progress preview (noisy; default `false`)
- `PROGRESS_PLAN_MAX_LINES`: max plan lines shown in progress (default `4`)
- `PROGRESS_DONE_STEPS_MAX`: max completed key steps shown in progress (default `4`)
- `PROGRESS_ACTIVITY_MAX_LINES`: max recent activity lines shown in progress/status (default `4`)
- `PROGRESS_MESSAGE_MAX_CHARS`: max rendered chars per progress message (default `1800`)
- `SELF_HEAL_ENABLED`: enable runtime self-healing (default `true`)
- `SELF_HEAL_RESTART_DELAY_MS`: delay before self-heal restart (default `5000`)
- `SELF_HEAL_MAX_LOGIN_BACKOFF_MS`: max retry backoff for Discord login (default `60000`)
- `MAX_INPUT_TOKENS_BEFORE_COMPACT`: compact threshold
- `COMPACT_STRATEGY`: `hard | native | off`
  - `hard`: bot summarizes then switches to a new session
  - `native`: use provider-native compaction and continue the same session
  - `off`: disable compact behavior
- You can also override compact strategy per channel with `/cx_compact` or `!compact`
- `COMPACT_ON_THRESHOLD`: enable/disable threshold-triggered compact logic
- Channel-level compact config supports: `strategy`, `token_limit`, `native_limit`, `enabled`, `reset`, and `status`

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

- Upgrade service label: `com.atou.agents-in-discord.auto-upgrade` (`LABEL`)
- Bot service label: `com.atou.agents-in-discord` (`BOT_LABEL`)

If you manage bot services manually:

- The runtime now blocks dangerous `launchctl` operations for protected bot labels, or rewrites them to a safe restart helper
- Prefer `scripts/restart-discord-bot-service.sh <codex|claude|gemini|all>`

Check service and logs:

```bash
launchctl print gui/$(id -u)/com.atou.agents-in-discord.auto-upgrade
tail -n 100 logs/agents-in-discord.auto-upgrade.log
tail -n 100 logs/agents-in-discord.auto-upgrade.err.log
```

Remove service:

```bash
launchctl bootout gui/$(id -u)/com.atou.agents-in-discord.auto-upgrade
rm -f ~/Library/LaunchAgents/com.atou.agents-in-discord.auto-upgrade.plist
```

### Windows (`Task Scheduler`)

PowerShell install (equivalent to `npm run install:auto-upgrade`):

```powershell
$env:SCHEDULE_HOUR='5'
$env:SCHEDULE_MINUTE='15'
$env:TASK_NAME='agents-in-discord-auto-upgrade'
$env:BOT_TASK_NAME='agents-in-discord'
node scripts/install-agents-in-discord-auto-upgrade.mjs
```

Defaults:

- Upgrade task name: `agents-in-discord-auto-upgrade` (`TASK_NAME` or `LABEL`)
- Bot restart task: `agents-in-discord` (`BOT_TASK_NAME` or `BOT_LABEL`)

Inspect/remove task:

```powershell
schtasks /Query /TN "agents-in-discord-auto-upgrade" /V /FO LIST
schtasks /Delete /TN "agents-in-discord-auto-upgrade" /F
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

You can also run `/cx_status` (or your active slash prefix + `_status`, such as `/cc_status` on the default Claude bot) to see codex-cli health in bot output.

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

## Standalone runtime notes

This repo is a standalone Discord bot for directing Codex CLI and Claude Code from Discord.

- No OpenClaw installation is required
- No plugin installation is required
- Keep it as a **separate Discord app**
- You can still use any process manager you like (`pm2`, `launchd`, Docker, `systemd`, etc.)

## Security

- `dangerous` means **no sandbox**. Codex will run with your user permissions.
- Don’t commit `.env` / session files. `.gitignore` is set up for that.
- If you ever leaked a bot token, **rotate it immediately** in Discord Developer Portal.

## License

MIT
