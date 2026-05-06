# Agents in Discord

在 Discord 线程里运行 Codex CLI、Claude Code 和 Gemini CLI 的 bot。

它是一个独立 bridge，不是 OpenClaw 插件，也不需要 OpenClaw。

[English](./README.en.md)

维护者：[ATou](https://github.com/atou42) 与 [Lark](https://github.com/Larkspur-Wang)

## 核心模型

一个 Discord 频道或线程，对应一条 provider 会话。

你可以在同一个 Discord 服务器里使用共享 bot，也可以把 Codex、Claude、Gemini 拆成三个独立 bot。每个 provider 有自己的 session、workspace、模型和运行配置，不会混在一起。

长任务不会一直刷屏。bot 会更新进度卡，也可以按频道设置成持续发送过程消息。最终回复是否 @ 发起人，也可以在设置里选。

Codex 的安全模式现在使用 workspace-write 沙盒，并将审批策略设为 on-request。危险模式仍然是完全绕过 sandbox 和 approval，只适合受控的个人环境。

## 你能做什么

- 在 Discord 里发任务，让 CLI agent 在指定 workspace 里工作
- 按频道保存会话，下次继续同一条上下文
- 用设置面板切换 provider、model、effort、fast、compact、reply、workspace
- 查看实时进度、队列、运行状态、quota、账号和当前配置来源
- 对同一个 workspace 做串行保护，避免多个频道同时改同一份代码
- 通过 `/cancel` 或文本命令中断当前任务并清空队列
- 在长任务里选择只看进度卡，或让过程消息持续流出

## 准备

需要 Node.js 18+，一个 Discord Bot Token，以及你要使用的 CLI。

本项目不管理 Codex、Claude、Gemini 自己的登录状态。请先在本机 CLI 里完成登录，并确认命令能直接运行。

```bash
codex --version
claude --version
gemini --version
```

如果 CLI 不在 bot 进程的 PATH 里，可以在 `.env` 里写绝对路径。

```env
CODEX_BIN=/opt/homebrew/bin/codex
CLAUDE_BIN=/opt/homebrew/bin/claude
GEMINI_BIN=/opt/homebrew/bin/gemini
```

## 安装

```bash
git clone https://github.com/atou42/agents-in-discord.git
cd agents-in-discord
cp .env.example .env
npm install
npm run setup-hooks
npm start
```

`npm run setup-hooks` 只需要在 clone 后执行一次。它会启用本仓库的提交前检查。

## Discord 里怎么用

默认 shared bot 的 slash 前缀是 `cx_`。独立 Claude bot 默认是 `cc_`，独立 Gemini bot 默认是 `gm_`。

最常用的入口是这些。

```text
/cx_onboarding     首次引导，设置语言、provider、workspace
/cx_settings       打开交互式设置面板
/cx_status         查看当前配置、运行状态、quota、账号信息
/cx_progress       查看当前任务进度
/cx_queue          查看当前频道队列
/cx_cancel         中断当前任务并清空队列
/cx_new            开一个新会话，但保留频道配置
/cx_resume         绑定已有 provider 会话
/cx_sessions       查看最近会话
/cx_setdir         设置当前频道 workspace
/cx_compact        配置 compact 策略和阈值
/cx_goal          查看或设置当前 Codex session 的持久目标
```

文本命令主要作为兜底。常用的是 `!cancel`、`!c`、`!progress`、`!status`、`!resume`、`!sessions`、`!goal status`。

`/cx_goal action:set` 或 `!goal <目标>` 会把当前 Codex session 的目标设为 active，并在 runner 空闲时继续执行。`/cx_status` 和 `!status` 会显示当前 goal；只查 goal 可以用 `/cx_goal action:status` 或 `!goal status`。`pause` 会停止续跑，`resume` 会恢复续跑，`clear` 会清除 goal。

## 设置面板

推荐优先用 `/cx_settings`。它比记命令更稳，也会显示当前值来自哪里。

设置有继承关系。线程里的显式设置优先，其次是父频道默认，再其次是 provider 或环境默认。`/cx_status` 会显示当前实际生效值和来源。

Codex 默认设置会直接修改 `~/.codex/config.toml`。频道或线程里的覆盖仍然优先，只有在跟随默认时才会吃到这里。

## Workspace

workspace 是 CLI 真正执行任务的目录。

推荐给每个 provider 设置一个默认 workspace。线程可以继续继承默认，也可以单独覆盖。子线程默认继承父频道 workspace，也可以配置成独立 workspace。

同一个 workspace 同一时间只允许一个任务执行。其他任务会排队或提示 workspace 正忙，避免并发改同一份代码。

## 运行模式

本地开发可以直接跑 shared bot。

```bash
npm start
```

如果想把三家 provider 拆成独立 bot，可以在同一个 `.env` 里写分组配置，然后分别启动。

```bash
npm run start:codex
npm run start:claude
npm run start:gemini
```

分组配置使用 `CODEX__*`、`CLAUDE__*`、`GEMINI__*`。通常只需要各自的 `DISCORD_TOKEN`，再按需填默认模型、默认 workspace 和 CLI 路径。

## 关键配置

完整配置看 `.env.example`。README 只列最常改的项。

```env
DISCORD_TOKEN=...
ALLOWED_CHANNEL_IDS=...
ALLOWED_USER_IDS=...
WORKSPACE_ROOT=/Users/you/workspaces
DEFAULT_WORKSPACE_DIR=/Users/you/project
DEFAULT_MODE=safe
DEFAULT_UI_LANGUAGE=zh
```

常见 provider 分组配置如下。

```env
CODEX__DISCORD_TOKEN=...
CODEX__DEFAULT_WORKSPACE_DIR=/Users/you/codex-work
CODEX__SLASH_PREFIX=cx

CLAUDE__DISCORD_TOKEN=...
CLAUDE__DEFAULT_WORKSPACE_DIR=/Users/you/claude-work
CLAUDE__SLASH_PREFIX=cc

GEMINI__DISCORD_TOKEN=...
GEMINI__DEFAULT_WORKSPACE_DIR=/Users/you/gemini-work
GEMINI__SLASH_PREFIX=gm
```

访问控制建议至少设置 `ALLOWED_CHANNEL_IDS` 或 `ALLOWED_USER_IDS`。多人服务器里不要默认使用 dangerous mode。

compact 相关配置可以在 `.env` 里设默认，也可以在 Discord 里按频道覆盖。

```env
COMPACT_STRATEGY=native
COMPACT_ON_THRESHOLD=true
MAX_INPUT_TOKENS_BEFORE_COMPACT=272000
```

## 代理

如果 Discord 或 CLI 需要走代理，可以设置：

```env
HTTP_PROXY=http://127.0.0.1:7890
SOCKS_PROXY=socks5h://127.0.0.1:7891
```

`npm install` 会自动运行 `npm run patch-ws`，让 Discord Gateway WebSocket 可以使用自定义 agent。

## 本地服务

macOS 上推荐用仓库自带脚本重启 bot 服务。

```bash
scripts/restart-discord-bot-service.sh codex
scripts/restart-discord-bot-service.sh claude
scripts/restart-discord-bot-service.sh gemini
scripts/restart-discord-bot-service.sh all
```

这个脚本会使用受保护的 launchd label，避免误用危险的 `launchctl` 操作。

## 项目升级

Bot 会检查 `agents-in-discord` 自己是否落后远端，默认只提示，不会自动改文件。可以在 Discord 里用 `/cx_upgrade action:status` 或 `!upgrade status` 查看本地版本、远端版本、落后提交数和更新说明。

手动升级：

```bash
npm run upgrade:project -- status
npm run upgrade:project -- apply
```

Discord 里也可以用 `/cx_upgrade action:apply` 或 `!upgrade apply`。升级只会在工作区干净、当前分支能 fast-forward 到远端时执行；本地有改动、分支分叉、远端不可达都会停止。执行前会先在临时 worktree 里安装依赖并跑验证，验证通过后才修改主工作区。

升级模式：

```bash
npm run upgrade:project -- notify
npm run upgrade:project -- auto
npm run upgrade:project -- off
```

`notify` 是默认值，只提示。`auto` 会在检测到安全升级且所有活跃 bot 进程都空闲时自动执行验证并请求重启。项目升级默认重启 `all`，因为多个 provider bot 通常共用同一个仓库。Discord 里的 `apply` 和 `mode` 需要 `AGENTS_IN_DISCORD_UPGRADE_ADMIN_USER_IDS`，未配置时只能查状态。常用环境变量：

```bash
AGENTS_IN_DISCORD_UPGRADE_MODE=notify
AGENTS_IN_DISCORD_UPGRADE_ADMIN_USER_IDS=123,456
AGENTS_IN_DISCORD_UPGRADE_NOTIFY_CHANNEL_IDS=123,456
AGENTS_IN_DISCORD_UPGRADE_CHECK_INTERVAL_MS=21600000
AGENTS_IN_DISCORD_UPGRADE_STATUS_CACHE_MS=600000
AGENTS_IN_DISCORD_UPGRADE_VERIFY_COMMAND="npm run test:progress"
AGENTS_IN_DISCORD_UPGRADE_RESTART_TARGET=all
```

## Codex CLI 自动升级

仓库内置一个可选的 Codex CLI 升级器。它可以定时检查 Codex 更新，升级成功后重启 bot 服务。

```bash
npm run install:auto-upgrade
npm run run:auto-upgrade
```

只想 dry-run：

```bash
CODEX_UPGRADE_DRY_RUN=1 npm run run:auto-upgrade
```

## 发布

常规改动先跑测试。

```bash
npm run test:progress
```

切版本使用项目脚本。

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

## 故障排查

如果 `/cx_status` 显示 CLI 不存在，先在同一个机器上确认路径。

```bash
which codex
which claude
which gemini
```

然后把绝对路径写进 `.env`，重启 bot。

如果 settings 里看到某个值和预期不同，先看 `/cx_status`。status 会显示当前生效值，也会显示它来自当前线程、父频道、全局配置还是环境默认。

如果任务一直不开始，先看 `/cx_queue` 和 `/cx_progress`。同一个 workspace 正在被其他频道使用时，任务会等待锁释放。

## 本地主动发消息

可以用 bot token 从本机向指定频道发消息。

```bash
npm run send:channel -- --channel 1487823042121040036 --content "部署完成"
cat notice.md | npm run send:channel -- --channel 1487823042121040036 --stdin
```
