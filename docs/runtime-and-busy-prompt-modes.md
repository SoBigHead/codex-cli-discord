# Runtime and Busy Prompt Modes

This spec keeps the cache-friendly rule first: a message should not change how an already started provider turn was built unless the provider has an explicit same-turn steering API.

Runtime mode is channel-scoped and provider-scoped. `exec` means one provider process per request. `long` means a persistent provider runtime for the Discord thread. A configured value is only allowed to affect execution when that provider path is implemented; otherwise the effective mode stays `exec`.

Busy prompt mode decides what to do when another Discord message arrives while the channel already has an active turn. `queue` appends the message behind the active turn. `steer_if_possible` may inject the message into the active turn only when the effective runtime is `long` and the provider runner exposes a real steering method. If either condition is false, the effective behavior is `queue`.

The invariant is simple: `exec` cannot steer. Unsupported or not-yet-wired providers cannot steer. A requested `steer_if_possible` must report why it was forced to `queue` instead of pretending it took effect.

Current capability matrix:

| Provider | Runtime today | Busy prompt today |
| --- | --- | --- |
| Codex | `exec` or `long` | `queue` |
| Claude Code | `exec` or `long` | `queue` |
| Antigravity | `exec` | `queue` |

Target matrix after runner work:

| Provider | Long runtime | Steer path |
| --- | --- | --- |
| Codex | implemented with `codex app-server` | `turn/steer` with `expectedTurnId` |
| Claude Code | stream-json hot process | realtime stream-json user input while a turn is active |
| Antigravity | not specified | queue only |

Codex 0.130 adds app-server pagination for thread turns through `thread/turns/list`, including an `itemsView` option (`notLoaded`, `summary`, `full`). Use that path for reading large Codex long-thread history instead of loading whole threads up front. The generated `thread/turns/items/list` protocol entry is not wired in the current 0.130 app-server build, so callers must not depend on it yet.

Workspace locking does not conflict with this model. A queued prompt waits for the next turn and acquires the workspace lock then. A steered prompt, when implemented, belongs to the same active turn and inherits the same workspace lock instead of competing for it.

Status and settings must always show effective behavior, not just the requested value. The requested value may be stored so users can preselect `steer_if_possible`, but execution must stay fail-closed until the provider path is real.
