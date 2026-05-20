# Codex Side Conversations

This spec defines how Agents in Discord should support Codex CLI `/side` semantics.

The target is not a generic fork shortcut. A side conversation is a transient, low-friction Codex fork for asking questions and doing lightweight inspection while keeping the main Discord thread and main Codex session focused.

## Source Behavior

Codex CLI 0.130 implements `/side` in the TUI as an ephemeral app-server fork. The TUI does not call a dedicated `side` protocol method. It composes the behavior from app-server primitives:

- `thread/fork` from the current parent thread.
- `ephemeral: true` on the fork config.
- side-specific developer instructions that say inherited history is reference-only.
- `thread/inject_items` to append a hidden boundary message after inherited history.
- UI switch into the side thread.
- return/cleanup by interrupting the side thread if needed, unsubscribing it, and removing local side state.

The boundary is the important semantic piece. Without it, the fork can treat the parent thread's unfinished plans, tool calls, approvals, or edits as active work. That would turn `/side` into an unsafe fork, not a side conversation.

Primary upstream references:

- `codex-rs/tui/src/app/side.rs`
- `codex-rs/tui/src/slash_command.rs`
- app-server protocol methods: `thread/fork`, `thread/inject_items`, `thread/unsubscribe`, `turn/interrupt`

## Product Semantics

In Discord, there is no in-place TUI panel, so the side conversation should appear as a separate Discord thread created next to the current thread. The new thread is temporary and linked to its parent. Messages in that side thread run against the ephemeral Codex side thread, not the parent Codex session. In this first Discord implementation, side turns wait until the parent turn is idle because both paths share the same live Codex app-server entry.

The side conversation inherits the parent Codex history as reference context. It must not continue the parent task by default. It should answer questions, inspect files, explain state, compare options, and run non-mutating checks. It may mutate files only when the user explicitly asks for that mutation inside the side conversation.

The main thread must stay stable. Opening a side conversation must not change the parent thread's bound Codex session, active goal, queue, progress card, reply delivery setting, workspace setting, model setting, or final answer behavior.

## User Surface

Add a Codex-only side command surface:

- Slash command: `/cx_side`
- Text command: `!side`
- Close action: `/cx_side action:close` and `!side close`
- Status action: `/cx_side action:status` and `!side status`

When started from a valid parent thread, the bot creates a Discord side thread and posts an origin notice in it. The notice should identify the parent Discord thread, parent Codex thread id, side Codex thread id, and the fact that the inherited history is reference-only.

Starting side from inside an existing side conversation should fail closed for the first version. The official TUI allows only one active side conversation and asks the user to return before starting another. Matching that behavior avoids nested cleanup and accidental context confusion.

## Runtime Requirements

The first version should require Codex long runtime for a side conversation opened while the parent is running. Long runtime has a live app-server entry, so it can fork the currently loaded parent thread in the same way the TUI does.

Even when the parent is idle, the side conversation must stay attached to the parent long-runtime app-server entry. Local smoke testing against Codex CLI 0.130 confirmed that an `ephemeral: true` fork can be created and injected, but it cannot be resumed later from a fresh app-server process (`no rollout found for thread id ...`). This means side start, side turns, side close, interrupt, and unsubscribe all need to route through the parent live app-server entry.

If the parent is running in exec runtime, side start must fail closed with a clear message. Exec has no live app-server handle for the active turn, so pretending to open side would be misleading.

If the current provider is Claude or Antigravity, side start must fail closed. This spec covers Codex CLI `/side` semantics only.

## Protocol Requirements

Extend the Codex app-server client layer with explicit helpers for:

- `thread/fork` with `ephemeral`, config overrides, model, cwd, approval policy, sandbox, developer instructions, and thread source where supported.
- `thread/inject_items` for raw Responses API items.
- `thread/unsubscribe`.
- `turn/interrupt`.
- startup interrupt if the active side thread has no turn id and the protocol exposes the needed method in the installed CLI.

The side fork config must preserve the parent runtime choices that affect model behavior: model, reasoning effort where supported, service tier, cwd, sandbox, approval policy, approvals reviewer, Fast mode, compact settings, and developer/system instructions. It must append the side developer instructions instead of replacing existing project instructions.

The injected boundary item must be a hidden model-visible user message equivalent to upstream's side boundary. It must say that inherited history before the boundary is reference-only, not the current task; only instructions after the boundary are active; file, git, config, permission, and workspace mutations are forbidden unless the user explicitly asks for them in the side conversation.

The side thread must not call `turn/start` until after `thread/inject_items` has succeeded. If injection fails, the implementation must cleanup the fork and report failure.

## State Model

Persist side metadata separately from normal fork metadata:

- parent Discord channel/thread id
- side Discord thread id
- parent Codex thread id
- side Codex thread id
- workspace directory
- provider
- open/closed state
- created timestamp
- requester id

Side threads should be recognizable in status output and session listings. They should not look like ordinary durable forks. The default status should say side conversations are temporary.

Closing a side conversation should mark the side metadata closed, interrupt any active side turn, unsubscribe the side Codex thread, stop the side app-server entry if one exists, and archive or lock the Discord side thread if permissions allow. If Discord archive fails, the provider cleanup should still happen and the user-facing message should say that only Discord archive failed.

Do not delete or overwrite parent state during side cleanup. If cleanup partially fails, keep enough metadata to retry close instead of silently forgetting the side thread.

## Discord Behavior

Starting side should respond in the parent thread with a link to the side Discord thread. The side thread should receive the origin notice before it accepts user work.

Messages in the side Discord thread should use the same progress-card and process-message settings as the side thread's effective session settings, inherited from the parent unless explicitly overridden. The final reply must not post back into the parent thread.

The parent progress card must not be edited by side activity. The parent queue must not receive side messages. The side queue must be independent.

If the parent task changes state while the side is open, the first version only needs status visibility through `/cx_side status`. It does not need to live-update a TUI-style label such as "main needs approval".

## Safety Rules

Side must default to non-mutating behavior at the instruction layer. It can read files, search files, inspect state, and run checks that do not modify repo-tracked files. It must not edit files, change git state, install dependencies, alter config, request broader permissions, or approve risky actions unless the side user explicitly asks for that mutation inside the side thread.

The implementation must not rely only on prompt text for all safety. The command surface and runtime should preserve existing sandbox, approval, and workspace protections. Prompt boundaries reduce accidental continuation; they are not a replacement for provider permission controls.

Workspace locking should treat side turns like ordinary turns for mutation safety. In this implementation, side questions fail closed while the parent turn is running because both use the same live app-server entry. If the side request explicitly asks for mutation while the parent is active in the same workspace, it should fail closed rather than write concurrently.

## Non-Goals

Do not implement generic multi-agent delegation under the name side.

Do not make side an alias for durable `/fork`.

Do not support Claude/Antigravity side until their providers have equivalent native semantics.

Do not allow nested side conversations in the first version.

Do not keep side sessions as normal recent sessions unless they are clearly labeled temporary.

## Acceptance Matrix

Each row must be covered by automated tests or a documented manual verification command before the feature is considered done.

| Case | Setup | Expected result |
| --- | --- | --- |
| Start side from idle Codex long thread | Parent has a bound Codex thread id and a live long-runtime app-server entry | Bot creates a side Discord thread, forks the Codex thread with `ephemeral: true`, injects the boundary, binds side metadata, and posts origin notices in parent and side |
| Start side after parent app-server was evicted or restarted | Parent has only a persisted Codex thread id, no live app-server entry | Bot refuses with a clear unavailable message; it must not create an ephemeral side that will later fail to resume |
| Start side from running Codex long thread | Parent has an active long-runtime turn | Bot opens side without queueing behind the parent, parent progress card and active turn keep running, and side prompts fail closed until the parent turn is idle |
| Start side from Codex exec running thread | Parent active runtime is exec | Bot refuses with a clear unsupported-runtime message and creates no side metadata |
| Start side before first Codex user turn | No persisted parent Codex thread id exists | Bot refuses with the equivalent of "send a message first, then try side again" |
| Start side on Claude/Antigravity | Provider is not Codex | Bot refuses and does not create Discord or provider state |
| Start nested side | Current Discord thread is already a side thread | Bot refuses and points to closing or returning to the parent first |
| Duplicate open side | Parent already has an open side | Bot refuses or returns the existing side link; it must not create a second hidden side by accident |
| Fork succeeds but boundary injection fails | Mock `thread/inject_items` failure | Bot interrupts/unsubscribes the side fork, marks no usable side session, and reports the preparation failure |
| Discord side thread creation fails | Missing thread permission or unsupported channel | Bot does not fork Codex, reports that Discord cannot create the side thread |
| Origin notice send fails | Side Discord thread exists but send fails | Bot reports the failure and cleans provider side state, unless retryable handling is explicitly implemented |
| Side asks a read-only question while parent idle | User asks "what files are relevant?" | Side answer uses side Codex thread, parent session id does not change, parent final reply does not include side answer |
| Side asks a read-only question while parent active | Parent is active in the same live app-server entry | Bot refuses the side prompt until the parent turn is idle, so it does not fail later in the runner |
| Side asks to modify while parent active | Parent is active in same workspace and side asks for code edit | Bot queues or refuses mutation; it must not allow concurrent writes against the same workspace |
| Side explicitly asks to mutate while parent idle | Parent idle, side asks for a small edit | Existing sandbox/approval/workspace protections apply; mutation stays in the same workspace and is attributed to side thread progress |
| Close idle side | No active side turn | Bot unsubscribes side thread, marks metadata closed, archives/locks Discord side thread where possible |
| Close running side | Side has active turn id | Bot interrupts the turn, then unsubscribes, then closes metadata |
| Close cleanup partially fails | `thread/unsubscribe` or Discord archive fails | Bot reports exact failed step and keeps metadata retryable; it does not pretend side is closed |
| Parent state after side close | Side opened, used, then closed | Parent session id, active goal, queue, reply delivery, workspace, model, and progress card are unchanged |
| Side status | Parent has open side | Status shows parent thread, side thread, provider ids, created time, and whether a side turn is running |
| Normal fork regression | Existing `/cx_fork` flow | Durable fork behavior remains unchanged and still creates a normal Discord thread/session |
| Steer regression | Codex long thread with `steer_if_possible` | Existing steer behavior still routes busy prompts into parent active turn, not into side |
| Process-message regression | Side and parent both use stream reply mode | Side process messages stay in side thread; parent process/final messages are not duplicated |

## Required Automated Tests

Add focused tests around these modules:

- `codex-app-server` for `thread/inject_items`, `thread/unsubscribe`, and interrupt helpers.
- `codex-app-server-runner` for forking from a live long entry, running side turns through the parent app-server entry, preserving the parent thread id, and cleaning side entries.
- command surface tests for `/cx_side` and text `!side`.
- side-flow tests for start, close, status, duplicate open, nested side, provider unsupported, exec unsupported, and injection failure cleanup.
- session-store tests for side metadata persistence and retryable partial cleanup.
- queue/runtime tests proving parent and side queues are independent.
- regression tests proving ordinary fork, steer, compact, process-message streaming, and status output are unchanged.

The minimum final verification command is:

```bash
npm run test:progress
```

If implementation touches command registration, settings/status rendering, or app-server protocol helpers, run the narrower changed-file test set first, then `npm run test:progress`.

## Manual Verification

Manual verification is still required because Discord thread creation, Discord archive permissions, and the installed Codex app-server behavior are integration points.

Run against a real Codex bot after tests pass:

- In a Codex long-runtime thread with an existing session, start `/cx_side`.
- Confirm the parent receives a side link and the side thread receives an origin notice.
- Ask the side thread a read-only question about the repo.
- Confirm the parent thread gets no side answer and its session/status remain unchanged.
- While a parent task is running, start side and confirm side prompts fail closed until the parent is idle.
- Close side and confirm no further side messages are accepted as an active provider session.
- Try `/cx_side` from a Claude/Antigravity thread and from an exec-running Codex thread and confirm both fail closed.

Manual verification is not a substitute for automated tests. It is the final integration check after automated coverage proves the edge cases.

## Completion Criteria

The feature is done only when the command surface, provider protocol, state model, cleanup path, and status/reporting behavior all match this spec; the acceptance matrix is covered; `npm run test:progress` passes; and a real Discord/Codex integration run confirms side starts, answers, isolates parent state, and closes cleanly.

Do not mark the work complete if any cleanup path can silently lose state, if side can accidentally continue the parent task, if parent output is polluted by side output, or if the implementation depends on the user to discover edge-case failures manually.
