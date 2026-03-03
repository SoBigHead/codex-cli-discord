# codex-cli-discord

一个轻量的 Discord Bot，用于把 **Codex CLI**（`codex exec --json`）桥接到 Discord 中。

**设计原则：**1 个 Discord **线程/频道 = 1 个 Codex 会话**（自动 `exec resume`）。

## 功能特性

- Slash 命令（不需要 `!` 前缀）
- 按线程持久化会话（重启后可恢复）
- 每线程独立 workspace 目录（隔离文件操作）
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
- 已安装并可在当前 shell 中执行 `codex` CLI
  - 如果通过 pm2/launchd/systemd 运行，可能需要在 `.env` 里设置 `CODEX_BIN=/absolute/path/to/codex`
- 一个**独立的** Discord Application/Bot Token（不要复用 OpenClaw 的 token）

## 快速开始

```bash
git clone <YOUR_REPO_URL>
cd codex-cli-discord
cp .env.example .env
npm install
npm run setup-hooks
npm start
```

Git hooks 说明：

- clone 后（或重新 clone 后）执行一次 `npm run setup-hooks`
- pre-commit 原子性检查基于 Node，可在 macOS/Linux/Windows 上工作（不依赖 bash）

然后在你的 Discord 服务器邀请 Bot，并使用以下 slash 命令：

- `/cx_status` - 查看当前线程配置
- `/cx_setdir <path>` - 设置当前线程的 workspace 目录
- `/cx_model <name|default>` - 设置模型覆盖
- `/cx_effort <high|medium|low|default>` - 设置推理强度
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

## 配置（.env）

见 `.env.example`。

关键项：

- `ALLOWED_CHANNEL_IDS` / `ALLOWED_USER_IDS`：限制可用范围（推荐）
- `SECURITY_PROFILE`：`auto | solo | team | public`
  - `auto`：DM -> `solo`；服务器内若 `@everyone` 可见频道则 `public`；否则 `team`
- `MENTION_ONLY`：普通消息是否必须 @Bot（留空则使用 profile 默认）
- `MAX_QUEUE_PER_CHANNEL`：每频道最大排队数（`0` 表示无限制；留空则使用 profile 默认）
- `ENABLE_CONFIG_CMD`：是否启用 `!config`（默认 `false`）
- `CONFIG_ALLOWLIST`：`!config key=value` 允许的 key（逗号分隔，或 `*` 表示全部允许）
- `SLASH_PREFIX`：slash 前缀，默认 `cx`（例如 `/cx_status`）
- `DEFAULT_UI_LANGUAGE`：新频道默认提示语言（`zh` 或 `en`，默认 `zh`）
- `ONBOARDING_ENABLED_DEFAULT`：新频道 onboarding 默认开关（`true` 或 `false`，默认 `true`）
- `DEFAULT_MODE`：`safe` 或 `dangerous`
- `WORKSPACE_ROOT`：按线程创建目录的根路径
- `CODEX_BIN`：codex 命令/路径（默认 `codex`）
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
- `COMPACT_ON_THRESHOLD`：是否启用阈值触发的 compact 逻辑

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

你也可以执行 `/cx_status`（或你自定义前缀 + `_status`）查看 Bot 输出中的 codex-cli 健康状态。

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

## OpenClaw 说明

很多人会把这个 Bot 和自己的 OpenClaw 一起运行：

- 保持为**独立的 Discord 应用**
- 你可以用 OpenClaw 管理/监控进程（pm2/launchd/docker）
- Bot 本身是刻意保持自包含：只需 `.env + npm start`

## 安全

- `dangerous` 表示**无沙箱**。Codex 将以你的用户权限执行。
- 不要提交 `.env` / 会话文件。`.gitignore` 已做好相关忽略。
- 如果 Bot token 泄漏，请在 Discord Developer Portal **立即轮换**。

## 许可证

MIT
