# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project follows Semantic Versioning.

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
