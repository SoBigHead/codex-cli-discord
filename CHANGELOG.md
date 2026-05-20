# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project follows Semantic Versioning.

## [Unreleased]

### Added
- Added Antigravity CLI provider support with canonical `antigravity` naming, `agy` launch support, legacy Gemini compatibility, settings-backed model updates, and documented reasoning-model choices in the model menu.

### Changed
- Kept `/goal` as one slash command with action choices while opening required modals for `set` and `budget` inputs.

## [0.12.11] - 2026-05-05

### Fixed
- Fell back to channel sends when Discord interaction webhook tokens expire, so delayed replies such as goal completion notices are still delivered.

## [0.12.10] - 2026-05-04

### Changed
- Hardened project upgrades with temporary-worktree validation before touching the main checkout, cached status checks, admin-only apply/mode commands, cross-bot heartbeat idle checks, and `all` as the default restart target.
- Reworked `/goal` into action-specific subcommands so `set` requires an objective and non-text actions no longer expose irrelevant free-text inputs.

### Fixed
- Stopped completed Codex goal continuations from leaving Discord progress cards running when `codex exec` does not exit after SIGTERM.

## [0.12.9] - 2026-05-04

### Added
- Added project upgrade checks for agents-in-discord itself, including `/upgrade`, `!upgrade`, `/status` visibility, notify-by-default mode, and optional safe auto-upgrade.
- Added a project upgrade CLI that refuses dirty, diverged, or non-fast-forward updates and runs verification before requesting a restart.

## [0.12.8] - 2026-05-04

### Fixed
- Stopped Codex goal continuation runs when the official goal state becomes complete, so Discord progress cards finish instead of waiting for a hung `codex exec` process.

## [0.12.7] - 2026-05-04

### Added
- Added fork-origin notices in new Discord fork threads that mention the requester and identify the parent session.
- Added a runtime and busy-prompt modes spec plus channel settings/status output for effective queue-vs-steer behavior.

### Changed
- Runtime settings now use cache-safe `exec` wording and keep busy prompts fail-closed to queue unless a real long-runtime steer path is available.

## [0.12.6] - 2026-05-03

### Added
- Added Claude Code fork support that mirrors Codex fork in Discord while using `--fork-session` on the first child-thread turn.

## [0.12.5] - 2026-05-03

### Changed
- Simplified Codex fork input to one optional Discord thread name; leaving it blank keeps generated fork naming.

## [0.12.4] - 2026-05-03

### Changed
- Made Discord extra info cache-first by removing per-message IDs from the default template and keeping `{msg}` templates out of provider system-prompt layers.

## [0.12.3] - 2026-05-03

### Added
- Added configurable Discord extra info for agent prompts, with status reporting, token estimates, slash/text commands, inheritance, and environment defaults.

### Changed
- Sends Discord extra info through provider system-prompt channels where supported, matching Hermes-style context injection for Codex and normal Claude runs.
- Keeps `/status` compact by showing extra info state and token cost without rendering the full resolved text.

### Fixed
- Preserved compatible per-turn extra info delivery for Gemini and Claude long-runtime sessions when no dynamic system-prompt channel is available.

## [0.12.2] - 2026-05-01

### Fixed
- Aligned Discord Codex goal behavior with official Codex CLI semantics: active goals now enqueue continuation work instead of only saving state.
- Enabled the Codex `goals` feature for normal Codex runner invocations so resumed runs can use native goal runtime behavior.
- Updated goal status text to explain active, paused, budget-limited, and complete states without implying that active is inert.

## [0.12.1] - 2026-05-01

### Changed
- Clarified that Codex goal set/resume operations only update the persisted goal state and do not start a task by themselves.
- Added the current Codex goal, goal query failures, and no-session state to `/status` and `!status`.

## [0.12.0] - 2026-05-01

### Added
- Added native Codex goal controls through `/goal` and `!goal`, backed by Codex app-server `thread/goal/*` APIs with support for status, set, pause, resume, complete, clear, and token budget updates.
- Added Codex app-server client helpers for native thread fork and persisted goal operations.
- Added native Codex image attachment support so Discord image inputs are passed to `codex exec` as CLI image arguments.
- Added compact model/settings controls, including CLI-backed Codex and Claude model catalogs, effort controls, compact threshold editing, and reply delivery settings.
- Added Codex account identity and live rate-limit details to status output.
- Added external signal material pool planning documents under `test-results/`.

### Changed
- Simplified the README and expanded the Codex surface roadmap around native command surfaces.
- Improved Codex permission/profile handling, compact reporting, runtime labels, and provider-scoped configuration surfaces.

### Fixed
- Surfaced Claude API retry errors in Discord instead of hiding them behind generic result handling.
- Covered Codex fork, goal, native image, model panel, compact, provider runtime, and settings flows with regression tests.

## [0.11.4] - 2026-04-16

### Added
- Added Claude long-runner lifecycle logging for spawn, reuse, result, idle close, process close, and turn start events.

### Fixed
- Workspace locks now clean up partial files if writing the lock body fails, archive stale malformed locks before retrying, and record acquisition time when the lock is actually acquired.

## [0.10.2] - 2026-03-31

### Fixed
- Codex Fast mode now follows the effective Discord setting in non-interactive `codex exec` runs even when the result is off, by explicitly passing `features.fast_mode=false` instead of relying on the CLI default.
- Fast mode status text now explains that both off states and inherited channel overrides are forwarded to match Codex `/fast`.

## [0.10.0] - 2026-03-25

### Added
- Added a dedicated Codex defaults section in `/settings` so global model, reasoning effort, and Fast mode can be edited directly in `~/.codex/config.toml`.
- Resume/bind flows for workspace-bound providers now resolve the session's real workspace from provider state, switch the channel to that workspace, and clear duplicate bindings in other threads.

### Changed
- Codex status, settings, and runtime surfaces now distinguish true `config.toml` overrides from provider defaults, and the status report labels token usage as the previous run's input instead of the current live context size.
- Native compact messaging is now fact-based: the bot only discloses compact-related notices when a session id actually switches, including retry paths that continue on the new session automatically.

### Fixed
- Binding a Codex or Gemini session whose workspace no longer exists now fails explicitly instead of silently keeping a broken session binding.

## [0.9.5] - 2026-03-24

### Fixed
- Restored Codex native compact to keep working as a provider-native compact plus automatic continue flow instead of stopping for a manual follow-up command.
- Native compact replies and compact help text now explicitly disclose that the run keeps going automatically and that any rollout session switch will be shown in the bot reply.
- When a native compact retry rolls to a new rollout session, later retries now stay on that new session instead of silently drifting again.

## [0.9.4] - 2026-03-24

### Fixed
- Stopped failed and successful Codex runs from silently taking over a new rollout session; the pinned session now stays unchanged unless users explicitly resume another session.
- Suppressed Codex native compact handoff for already-bound sessions so crossing the compact threshold no longer triggers an implicit session switch behind the scenes.
- Replies now explicitly disclose any unexpected new session ID instead of hiding it.

## [0.9.3] - 2026-03-22

### Fixed
- Auto retry now keeps the current Codex rollout session instead of silently resetting it before the next attempt, so drawing and other session-sensitive work can continue in the same context.
- Resuming a Codex or Gemini session now reattaches the thread to the session's original workspace and clears duplicate cross-thread bindings, preventing stale session IDs from reviving in the wrong thread.

## [0.9.2] - 2026-03-17

### Changed
- Codex Fast mode now defaults to on when `~/.codex/config.toml` is missing or does not explicitly set `[features].fast_mode = false`, while preserving thread-level and parent-channel overrides.
- Updated help, settings, and documentation text to explain that "follow global" now inherits the config value and stays on unless explicitly disabled.

## [0.9.1] - 2026-03-17

### Fixed
- Restored the progress-card hint to the intended minimal `!c` wording instead of showing legacy cancel aliases and extra command noise.
- Added the effective Fast mode state to the running progress/status message flow so thread conversations can see whether Fast mode is on and where it is inherited from.

## [0.9.0] - 2026-03-17

### Added
- Thread sessions can now inherit parent-channel defaults for provider-scoped runtime knobs such as model, reasoning effort, Fast mode, and compact settings while still allowing thread-local overrides.

### Changed
- Workspace resolution for threads now prefers an explicit thread override, then the parent channel workspace, then the provider default workspace, and finally the legacy fallback.
- Settings, status, and runtime execution now consistently surface when a thread is inheriting effective values from its parent channel instead of only from global defaults.

## [0.8.1] - 2026-03-16

### Changed
- Simplified queue and progress card hints so user-facing messaging now points to `!c` and `/status` only, while keeping legacy cancel aliases available for compatibility.

## [0.8.0] - 2026-03-16

### Added
- Added `/settings`, an interactive per-channel settings panel that groups provider, model, fast mode, reasoning effort, compact strategy, execution mode, language, and workspace controls behind one slash entry point.

### Changed
- Reframed Fast mode and model tuning around the new settings panel so users can choose explicit options such as "follow global" or open a model modal instead of guessing command-only defaults.

## [0.7.0] - 2026-03-16

### Added
- Added channel-scoped Codex Fast mode controls via `/fast` and `!fast`, with `on|off|status|default` actions and fallback to `~/.codex/config.toml` when no thread override is set.

### Changed
- Status, doctor, and help output now surface whether Codex Fast mode is inherited from config or overridden for the current channel.

## [0.6.2] - 2026-03-16

### Changed
- Reworked `/onboarding` into an ordinary-user first-run guide focused on language, provider, workspace, and the first task instead of admin-oriented security and timeout setup.
- The onboarding workspace step can now open the existing workspace browser directly, and the text fallback now mirrors the same user-facing quick-start flow.
- Slash command replies no longer attach the generic shortcut button bar; users rely on explicit commands while buttons stay reserved for finite-choice flows such as guided setup.

## [0.6.1] - 2026-03-16

### Added
- Added `!c` as a short text-command alias for `cancel`.

### Changed
- Queue, onboarding, help, and live progress messaging now point users to `!cancel` / `!c` while keeping `/abort`, `!abort`, and `!stop` compatibility.
- Running progress cards no longer attach an inline Cancel button and instead stay text-only with explicit command hints.

## [0.6.0] - 2026-03-15

### Added
- Provider-native runtime surface metadata for Codex, Claude, and Gemini, including session vocabulary, compact capabilities, reasoning-effort support, and runtime-store descriptions.
- Provider-specific session aliases and help surfaces such as `rollout_sessions` / `project_sessions` / `chat_sessions` and matching `resume` aliases.
- Provider-scoped session persistence buckets so model, effort, compact config, raw config overrides, and bound session IDs survive provider switches instead of clobbering each other.
- macOS `launchctl` guard + safe restart helper for protected bot services, with regression coverage for blocked and rewritten service operations.

### Changed
- Compact defaults now prefer provider-native compaction where supported, and status/help/doctor output now explains which compact knobs are actually available on the active provider.
- Session, workspace, and resume messaging now uses provider-native terminology such as rollout session, project session, and chat session.
- README, English README, and `.env.example` now document provider-specific aliases, access controls, runtime behavior, and safer local service operations.

### Fixed
- Retried Discord interaction reply/edit/follow-up/defer flows to reduce transient network failures and interaction timeout regressions.
- Stopped Claude assistant snapshots and structured stream deltas from leaking into the public progress card as fake "process content".
- Final progress cards now end in a stable `done` phase with a clearer terminal latest-step message.

## [0.5.0] - 2026-03-14

### Added
- Gemini CLI provider support, including dedicated bot mode, provider-aware CLI health checks, and provider-specific session/runtime handling.
- Workspace browser flows for selecting directories from Discord, plus recent/favorite workspace navigation helpers.
- Dedicated startup paths for shared, Codex, Claude, and Gemini bot instances with provider-scoped env overrides.

### Changed
- Refactored the runtime into smaller modules for app composition, orchestrator/progress/reporting, Discord lifecycle/entry handlers, and provider/runtime helpers.
- Renamed the project and operational surfaces from `Codex-ClaudeCode-in-Discord` to `agents-in-discord`, including package metadata, repo/docs references, and local service labels/scripts.
- Auto-upgrade scripts and local launchd/task-scheduler defaults now use the new `agents-in-discord` naming.

### Fixed
- Claude final answers now render correctly in Discord instead of falling back to "no visible text", and final-answer payloads no longer pollute progress "process content".
- Restored the missing slash registration import in the index bootstrap path.

## [0.3.1] - 2026-03-07

### Added
- Provider-level default workspace support via `DEFAULT_WORKSPACE_DIR`, `CODEX__DEFAULT_WORKSPACE_DIR`, and `CLAUDE__DEFAULT_WORKSPACE_DIR`.
- Runtime workspace controls for both text and slash commands: `!setdir`, `!setdefaultdir`, `/setdir`, and `/setdefaultdir`.
- Cross-process workspace serialization using lock files, so the same workspace is no longer executed concurrently from multiple channels/bots.
- Regression tests for workspace resolution, provider default migration, and workspace lock behavior.

### Changed
- Workspace resolution now prefers thread override → provider default → legacy `WORKSPACE_ROOT/<threadId>` fallback.
- Claude runs now receive the provider default workspace as an extra `--add-dir` when different from the current working directory, making parent/sibling navigation less restrictive.
- Status/help/doctor output now shows effective workspace, workspace source, and serialization state.
- `WORKSPACE_ROOT` is now documented as a legacy fallback root rather than the primary recommended workspace model.

### Fixed
- Stop auto-creating or auto-initializing Git repositories when the effective workspace is an existing shared directory such as `~/GitHub`.
- Keep Claude sessions when switching workspace where possible, while still resetting Codex sessions when a real workspace change makes resume unsafe.
- Allow cancellation while a task is blocked waiting on a busy workspace lock.

## [0.3.0] - 2026-03-07

### Added
- Shared and dedicated startup flows for Discord bot instances via `npm run start:shared`, `npm run start:codex`, and `npm run start:claude`.
- Provider-scoped single-file `.env` loading with `CODEX__*` and `CLAUDE__*` sections plus new utility coverage for provider/env resolution.
- Provider-aware state isolation for locked bot instances, including per-provider session/lock files and default slash prefixes.

### Changed
- Expanded the standalone Discord bot from Codex-only wording to first-class Codex + Claude support across docs, config examples, and runtime helpers.
- Progress/event parsing now understands additional assistant and stream event shapes used by Claude-style runtimes.

### Fixed
- Prefer provider-scoped Discord token and runtime overrides without clobbering higher-priority shell environment values.
- Preserve progress milestones from tool-style response items that omit explicit completion status.

## [0.2.3] - 2026-03-04

### Changed
- `splitForDiscord` now performs markdown-aware chunking and keeps fenced code blocks balanced across message parts.
- Extracted Discord output chunking into `src/discord-message-splitter.js` for isolated testing and safer iteration.

### Fixed
- Avoid splitting inside fenced blocks without reopening/closing markers, preventing broken rendering in long final answers.
- Added regression tests for long plain text, fenced code block chunking, and unclosed-fence auto-healing.

## [0.2.2] - 2026-03-04

### Fixed
- Preserve Markdown line breaks, paragraphs, and fenced code blocks when extracting final answer text from Codex events.
- Add regression tests for Markdown structure preservation in `codex-event-utils`.

## [0.2.1] - 2026-03-03

### Added
- Audience-facing progress stream with a fixed process window and commentary capture from Codex events.
- Configurable process window lines command and event dedupe controls.

### Changed
- Progress rendering now uses raw Codex event text and incremental streaming behavior.
- Added semver release automation (`scripts/cut-release.mjs`) and npm release scripts.

### Fixed
- Acknowledge slash interactions earlier to reduce timeout errors.
- Retry transient Discord send/reply failures.
- Fallback to `channel.send` for system messages when direct replies fail.

## [0.2.0] - 2026-03-01

### Added
- Configurable onboarding wizard for language, security profile, and timeout.
- Per-thread slash commands for onboarding and runtime overrides.
- Text commands for onboarding, language, profile, and timeout management.
- Localized onboarding and help output in Chinese and English.

### Changed
- Persist and migrate session-level settings: language, onboarding, security profile, timeout.
- Progress reporting now follows session language for phases, labels, and hints.
- Documentation and `.env.example` updated for new onboarding controls.
