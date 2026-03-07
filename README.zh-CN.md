# Codex-ClaudeCode-in-Discord

一个独立运行、让你可以直接在 Discord 里指挥 **Codex CLI** 和 **Claude Code** 的 Discord Bot。

> 这是一个独立运行的 Discord Bot / bridge，**不是** OpenClaw 插件，也**不依赖** OpenClaw 才能运行。

**设计原则：**1 个 Discord **线程/频道 = 1 个 CLI 会话**（按当前 provider 自动续聊）。

## 功能特性

- Slash 命令（不需要 `!` 前缀）
- 按线程持久化会话（重启后可恢复）
- 灵活 workspace 模型：thread 覆盖、provider 默认目录，以及 legacy 每线程回退目录
- 运行时自愈：Discord/运行时出现瞬时故障后自动退避重登
- 两种模式：
  - `safe` -> `codex exec --full-auto`（沙箱模式）
  - `dangerous` -> `--dangerously-bypass-approvals-and-sandbox`（完全访问）
- 可选代理（Clash / 企业代理）：REST 走 `HTTP_PROXY`，Gateway WS 走 `SOCKS_PROXY`
- 轻量交互体验：
  - 开始时反应 `⚡`，成功 `✅`，失败 `❌`，取消 `🛑`
  - 用 `/name` 给会话命名
  - 按频道排队（新消息进入队列，不会被直接拒绝）
  - `/cancel` / `!abort` 可中断当前运行并清空队列
  - 长任务实时进度（阶段/耗时/最新步骤），并支持 `/progress` / `!progress`
  - `/doctor` / `!doctor` 可做运行与安全配置体检
  - `/onboarding` 可用按钮分步引导并可直接配置关键项，`!onboarding` 提供文本版兜底
  - 支持按线程配置 onboarding 开关（on/off/status）与消息提示语言（zh/en，默认 zh）
  - 支持按线程覆盖 security profile（`auto|solo|team|public`）
  - 支持按线程覆盖 codex timeout（`毫秒|off|status`）

## 前置条件

- Node.js 18+
- 安装你计划使用的 CLI
  - Codex：当前 shell 可直接执行 `codex`，或在 `.env` 设置 `CODEX_BIN=/absolute/path/to/codex`
  - Claude：当前 shell 可直接执行 `claude`，或在 `.env` 设置 `CLAUDE_BIN=/absolute/path/to/claude`
- 如果 CLI 自己需要登录，请先在 CLI 内完成；这个项目不通过 `.env` 管 provider auth
- 一个或两个 Discord Application/Bot Token
  - 共享模式：一个 bot token 即可
  - 独立模式：Codex / Claude 分别使用不同 bot token

## 快速开始

```bash
git clone https://github.com/atou42/Codex-ClaudeCode-in-Discord.git
cd Codex-ClaudeCode-in-Discord
cp .env.example .env
npm install
npm run setup-hooks
npm start
```

Git hooks 说明：

- clone 后（或重新 clone 后）执行一次 `npm run setup-hooks`
- pre-commit 原子性检查基于 Node，可在 macOS/Linux/Windows 上工作（不依赖 bash）

然后在你的 Discord 服务器邀请 Bot，并使用以下 slash 命令。下面示例使用的是 Codex / shared 模式默认前缀 `cx_`；独立 Claude bot 默认前缀改为 `cc_`，并且两者都可通过 `SLASH_PREFIX`、`CODEX__SLASH_PREFIX`、`CLAUDE__SLASH_PREFIX` 覆盖：

- `/cx_status` - 查看当前线程配置
- `/cx_setdir <path|default|status>` - 设置或清除当前线程的 workspace
- `/cx_setdefaultdir <path|clear|status>` - 设置当前 provider 的默认 workspace
- `/cx_model <name|default>` - 设置模型覆盖
- `/cx_effort <high|medium|low|default>` - 设置推理强度
- `/cx_effort <xhigh|high|medium|low|default>` - 设置 reasoning effort
- `/cx_compact key:<status|strategy|token_limit|native_limit|enabled|reset> value:<...>` - 配置当前频道 compact（仅 Codex）
- `/cx_mode <safe|dangerous>` - 设置执行模式
- `/cx_name <label>` - 命名会话（用于显示）
- `/cx_reset` - 清空当前线程会话
- `/cx_resume <session_id>` - 绑定已有 Codex 会话 ID
- `/cx_sessions` - 列出本地最近 Codex 会话
- `/cx_queue` - 查看当前频道运行中/排队任务数量
- `/cx_doctor` - 查看 Bot 运行/安全体检信息
- `/cx_onboarding` - 交互式新用户引导（分步按钮，ephemeral）
- `/cx_onboarding_config <on|off|status>` - 配置当前频道 onboarding 是否可用
- `/cx_language <中文|English>` - 设置当前频道消息提示语言
- `/cx_profile <auto|solo|team|public|status>` - 设置或查看当前频道 security profile 覆盖
- `/cx_timeout <毫秒|off|status>` - 设置当前频道 codex timeout 覆盖
- `/cx_progress` - 查看当前运行任务的最新进度快照
- `/cx_cancel` - 中断当前运行并清空队列

如果你希望 **Codex 和 Claude 绑定不同 Discord bot**，现在改成只用一个 `.env`，但在文件里分段分组：

```bash
# 首次准备
cp .env.example .env

# 启动两个独立 bot
npm run start:codex
npm run start:claude
```

共享配置继续用普通 key，只放 Discord / 运行时配置；Codex / Claude 专属配置放在同一个 `.env` 里的 `CODEX__*` / `CLAUDE__*` 段落里。实际通常只需要各自的 `DISCORD_TOKEN`，以及按需填写 `DEFAULT_MODEL`、`DEFAULT_MODE`、CLI 路径。锁定实例后会自动使用独立状态文件（`data/sessions.codex.json`、`data/sessions.claude.json`）和独立进程锁，因此不会串频道/串会话上下文。

## 配置（.env）

见 `.env.example`。

关键项：

- `ALLOWED_CHANNEL_IDS` / `ALLOWED_USER_IDS`：限制可用范围（推荐）
- 共享 `.env` key：只放 Discord / 运行时配置（`ALLOWED_*`、`WORKSPACE_ROOT`、`DEFAULT_WORKSPACE_DIR`、代理等）
- `CODEX__*`：同一个 `.env` 里的 Codex bot 分组（通常只需要 `CODEX__DISCORD_TOKEN`，以及按需填写 `CODEX__DEFAULT_MODEL`、`CODEX__DEFAULT_MODE`、`CODEX__DEFAULT_WORKSPACE_DIR`、`CODEX__MAX_INPUT_TOKENS_BEFORE_COMPACT`、`CODEX__CODEX_BIN`）
- `CLAUDE__*`：同一个 `.env` 里的 Claude bot 分组（通常只需要 `CLAUDE__DISCORD_TOKEN`，以及按需填写 `CLAUDE__DEFAULT_MODEL`、`CLAUDE__DEFAULT_MODE`、`CLAUDE__DEFAULT_WORKSPACE_DIR`、`CLAUDE__CLAUDE_BIN`）
- `BOT_PROVIDER`：留空表示共享模式；设为 `codex` / `claude` 可把当前 bot 实例锁到单一 provider；`npm run start:codex` / `npm run start:claude` 会自动设置
- `ENV_FILE`：仍可选配额外 overlay 文件，但常规使用现在就是单个分组 `.env`
- `DISCORD_TOKEN_CODEX` / `DISCORD_TOKEN_CLAUDE`：旧的单文件回退方案，保留兼容
- provider 登录/鉴权不属于这个项目的配置面；除非你明确需要，否则不要把 CLI 自己的 secret 塞进这个 `.env`
- `SECURITY_PROFILE`：`auto | solo | team | public`
  - `auto`：DM -> `solo`；服务器内若 `@everyone` 可见频道则 `public`；否则 `team`
- `MENTION_ONLY`：普通消息是否必须 @Bot（留空则使用 profile 默认）
- `MAX_QUEUE_PER_CHANNEL`：每频道最大排队数（`0` 表示无限制；留空则使用 profile 默认）
- `ENABLE_CONFIG_CMD`：是否启用 `!config`（默认 `false`）
- `CONFIG_ALLOWLIST`：`!config key=value` 允许的 key（逗号分隔，或 `*` 表示全部允许）
- `SLASH_PREFIX`：shared / 全局 slash 前缀；shared 模式默认 `cx`（例如 `/cx_status`）
- `CODEX__SLASH_PREFIX` / `CLAUDE__SLASH_PREFIX`：独立 bot 的 slash 前缀覆盖；默认分别是 Codex=`cx`、Claude=`cc`
- `DEFAULT_UI_LANGUAGE`：新频道默认提示语言（`zh` 或 `en`，默认 `zh`）
- `ONBOARDING_ENABLED_DEFAULT`：新频道 onboarding 默认开关（`true` 或 `false`，默认 `true`）
- `DEFAULT_MODE`：`safe` 或 `dangerous`；独立 bot 建议分别写成 `CODEX__DEFAULT_MODE` / `CLAUDE__DEFAULT_MODE`
- `DEFAULT_WORKSPACE_DIR`：两个 provider 共用的默认 workspace（可选）
- `CODEX__DEFAULT_WORKSPACE_DIR` / `CLAUDE__DEFAULT_WORKSPACE_DIR`：provider 级默认 workspace
- `WORKSPACE_ROOT`：仅在未配置 thread 覆盖与 provider 默认目录时，作为 legacy 回退目录根路径
- `CODEX_BIN`：codex 命令/路径（默认 `codex`）
- `CLAUDE_BIN`：claude 命令/路径（默认 `claude`）
- `CODEX_TIMEOUT_MS`：单次 codex 运行硬超时（毫秒），`0` 表示禁用超时
- `PROGRESS_UPDATES_ENABLED`：是否启用频道实时进度更新（默认 `true`）
- `PROGRESS_UPDATE_INTERVAL_MS`：进度消息心跳刷新间隔
- `PROGRESS_EVENT_FLUSH_MS`：事件触发进度编辑的最小间隔
- `PROGRESS_EVENT_DEDUPE_WINDOW_MS`：语义相同进度事件（stdout + rollout bridge）的去重窗口（毫秒，默认 `2500`）
- `PROGRESS_TEXT_PREVIEW_CHARS`："最新步骤" 预览截断长度
- `PROGRESS_INCLUDE_STDERR`：进度预览中是否包含原始 stderr（噪声较大，默认 `false`）
- `PROGRESS_PLAN_MAX_LINES`：进度中展示的 plan 条目上限（默认 `4`）
- `PROGRESS_DONE_STEPS_MAX`：进度中展示的“已完成关键步骤”上限（默认 `4`）
- `PROGRESS_MESSAGE_MAX_CHARS`：每次进度消息渲染的总字符上限（默认 `1800`）
- `SELF_HEAL_ENABLED`：是否启用运行时自愈（默认 `true`）
- `SELF_HEAL_RESTART_DELAY_MS`：自愈重启前延迟（默认 `5000`）
- `SELF_HEAL_MAX_LOGIN_BACKOFF_MS`：Discord 登录重试最大退避（默认 `60000`）
- `MAX_INPUT_TOKENS_BEFORE_COMPACT`：触发 compact 的阈值
- `COMPACT_STRATEGY`：`hard | native | off`
  - `hard`：Bot 先总结，再切换到新会话
  - `native`：给 Codex CLI 传 `model_auto_compact_token_limit`，继续同一会话
  - `off`：关闭 compact 行为
- 也可以通过 `/cx_compact` 或 `!compact` 在频道级覆盖 compact strategy
- `COMPACT_ON_THRESHOLD`：是否启用阈值触发的 compact 逻辑
- 频道级 compact 配置支持：`strategy`、`token_limit`、`native_limit`、`enabled`、`reset`、`status`

## Codex CLI 自动升级（可选调度适配器）

这个仓库内置了跨平台 `codex` 升级器，可实现：

- 定时检查更新
- 自动升级 `codex`
- 升级成功后重启你的 bot 服务

安装（按系统自动选择调度器：macOS=`launchd`、Windows=`Task Scheduler`、其他=`none`）：

```bash
npm run install:auto-upgrade
```

自定义调度（示例：每天 `03:40`）：

```bash
SCHEDULE_HOUR=3 SCHEDULE_MINUTE=40 npm run install:auto-upgrade
```

禁用调度器但保留手动升级器：

```bash
AUTO_UPGRADE_SCHEDULER=none npm run install:auto-upgrade
```

手动运行（用于 smoke test）：

```bash
npm run run:auto-upgrade
```

手动运行（dry-run，不做包/服务变更）：

```bash
CODEX_UPGRADE_DRY_RUN=1 npm run run:auto-upgrade
```

### macOS（`launchd`）

默认 ID：

- 升级服务 label：`com.atou.codex-cli-auto-upgrade`（`LABEL`）
- Bot 服务 label：`com.atou.codex-discord-bot`（`BOT_LABEL`）

查看服务与日志：

```bash
launchctl print gui/$(id -u)/com.atou.codex-cli-auto-upgrade
tail -n 100 logs/codex-auto-upgrade.log
tail -n 100 logs/codex-auto-upgrade.err.log
```

移除服务：

```bash
launchctl bootout gui/$(id -u)/com.atou.codex-cli-auto-upgrade
rm -f ~/Library/LaunchAgents/com.atou.codex-cli-auto-upgrade.plist
```

### Windows（`Task Scheduler`）

PowerShell 安装（等价于 `npm run install:auto-upgrade`）：

```powershell
$env:SCHEDULE_HOUR='5'
$env:SCHEDULE_MINUTE='15'
$env:TASK_NAME='codex-cli-auto-upgrade'
$env:BOT_TASK_NAME='codex-discord-bot'
node scripts/install-codex-auto-upgrade.mjs
```

默认值：

- 升级任务名：`codex-cli-auto-upgrade`（`TASK_NAME` 或 `LABEL`）
- Bot 重启任务：`codex-discord-bot`（`BOT_TASK_NAME` 或 `BOT_LABEL`）

查看/删除任务：

```powershell
schtasks /Query /TN "codex-cli-auto-upgrade" /V /FO LIST
schtasks /Delete /TN "codex-cli-auto-upgrade" /F
```

## 故障排查

### `spawn codex ENOENT`

这表示 Bot 进程在当前运行环境中找不到 Codex CLI 可执行文件。

1. 检查该机器上的安装路径：
```bash
which codex
```
2. 把绝对路径写入 `.env`：
```env
CODEX_BIN=/opt/homebrew/bin/codex
```
Windows 示例（PowerShell 路径）：
```env
CODEX_BIN=C:\\Users\\<you>\\AppData\\Local\\Programs\\Codex\\codex.exe
```
3. 重启 Bot 进程。

你也可以执行 `/cx_status`（或当前生效前缀 + `_status`，例如默认 Claude bot 用 `/cc_status`）查看 Bot 输出中的 codex-cli 健康状态。

## 代理 / Clash 配置（可选）

如果你在代理环境下：

- Discord REST API：设置 `HTTP_PROXY=http://127.0.0.1:7890`
- Discord Gateway WebSocket：设置 `SOCKS_PROXY=socks5h://127.0.0.1:7891`

本仓库包含一个给 `@discordjs/ws` 的**尽力而为补丁脚本**（`npm install` 时会自动运行），让 Gateway 能使用自定义 agent：

```bash
npm run patch-ws
```

如果你的 HTTP 代理做了 TLS MITM，且你**必须**绕过校验：

```env
INSECURE_TLS=1
```

（强烈不推荐。优先使用干净的 SOCKS 隧道。）

## 独立运行说明

这个仓库本身就是一个独立运行的 Discord Bot，用来在 Discord 里指挥 Codex CLI 和 Claude Code。

- 不需要安装 OpenClaw
- 不需要安装任何插件
- 保持为**独立的 Discord 应用**
- 你仍然可以按自己习惯使用任意进程管理方式（`pm2`、`launchd`、Docker、`systemd` 等）

## 安全

- `dangerous` 表示**无沙箱**。Codex 将以你的用户权限执行。
- 不要提交 `.env` / 会话文件。`.gitignore` 已做好相关忽略。
- 如果 Bot token 泄漏，请在 Discord Developer Portal **立即轮换**。

## 许可证

MIT
