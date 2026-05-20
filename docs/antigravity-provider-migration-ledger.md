# Antigravity Provider Migration Ledger

## 2026-05-20 Start

Objective source: `docs/antigravity-provider-migration-spec.md`.

Observed facts before implementation:

- `docs/antigravity-provider-migration-spec.md` exists and defines the migration boundary.
- `docs/antigravity-provider-migration-ledger.md` did not exist before this entry.
- `package.json` still exposes `start:gemini` and `dev:gemini`, but not `start:antigravity` or `dev:antigravity`.
- The worktree already contains earlier Antigravity-related changes across source, tests, docs, and `.env.example`.

Decision:

- Treat `antigravity` as the canonical provider identity.
- Keep `gemini`, `google`, and `agy` as legacy aliases that normalize to `antigravity`.
- Preserve Google-owned local paths under `.gemini`.
- Do not implement hot runtime or add an unsupported `--model` runner argument in this migration.

Next action:

- Audit the remaining code paths, then implement missing canonical provider, env, script, command, session, docs, and test changes.

## 2026-05-20 Implementation

Changed provider identity:

- Canonical provider metadata key is now `antigravity`.
- `gemini`, `google`, and `agy` still normalize to `antigravity`.
- Added `src/providers/antigravity.js`.
- Kept `src/providers/gemini.js` as a legacy shim that re-exports the Antigravity adapter.

Changed startup and config:

- Added `npm run start:antigravity` and `npm run dev:antigravity`.
- Kept `npm run start:gemini` and `npm run dev:gemini` as legacy compatibility paths.
- `scripts/start-instance.mjs antigravity --dry-run` reports `BOT_PROVIDER=antigravity`.
- `scripts/start-instance.mjs gemini --dry-run` reports `BOT_PROVIDER=antigravity` and `SLASH_PREFIX=gm`.
- `ANTIGRAVITY__*`, `ANTIGRAVITY_BIN`, and `DISCORD_TOKEN_ANTIGRAVITY` are preferred.
- `GEMINI__*`, `GEMINI_BIN`, and `DISCORD_TOKEN_GEMINI` remain legacy fallbacks.
- New Antigravity scoped env keys shadow legacy Gemini scoped keys.

Changed command and UI surface:

- Provider picker and slash provider choice now advertise `antigravity`.
- `!provider gemini` remains accepted through provider alias normalization.
- Native Antigravity session aliases are now `conversation_sessions` and `conversation_resume`.
- Legacy `chat_sessions` and `chat_resume` remain accepted aliases.
- Model settings still read/write Antigravity `~/.gemini/antigravity-cli/settings.json`.
- No Antigravity `--model` runner flag was added.

Changed session and state handling:

- Loaded session records with `provider: "gemini"` migrate to `provider: "antigravity"`.
- `providers.gemini` migrates into `providers.antigravity`.
- If both buckets exist, non-empty canonical Antigravity values win, empty canonical fields may be filled from legacy, and conflicts are recorded in `providerMigrationWarnings`.
- Malformed session DB files now throw a clear load error instead of returning an empty DB.
- For an Antigravity locked bot, missing `data/sessions.antigravity.json` imports existing valid `data/sessions.gemini.json` without deleting the legacy file. Malformed legacy JSON is not copied.

Changed docs:

- `.env.example`, `README.md`, and `README.en.md` now prefer `ANTIGRAVITY__*`, `ANTIGRAVITY_BIN`, `start:antigravity`, `sessions.antigravity.json`, `ag_`, and `conversation_*`.
- Legacy Gemini names are documented only as compatibility names.

## 2026-05-20 Verification

Check: Legacy provider input does not fork a second provider identity.

Command run:

```bash
node --test test/provider-metadata.test.mjs test/session-store.test.mjs test/session-command-actions.test.mjs
```

Output observed:

```text
tests 38
pass 38
fail 0
```

Result: PASS.

Check: New env keys shadow legacy env keys.

Command run:

```bash
node --test test/runtime-env.test.mjs test/bot-instance-utils.test.mjs test/provider-runtime.test.mjs
```

Output observed:

```text
tests 18
pass 18
fail 0
```

Result: PASS.

Check: Bad legacy state is not hidden by fallback.

Command run:

```bash
node --test test/session-store.test.mjs
```

Output observed:

```text
createSessionStore surfaces malformed state instead of replacing it with empty DB: PASS
```

Result: PASS.

Check: Dedicated bot scripts do not split locks or state files.

Command run:

```bash
node scripts/start-instance.mjs antigravity --dry-run
node scripts/start-instance.mjs gemini --dry-run
```

Output observed:

```json
{
  "input": "antigravity",
  "provider": "antigravity",
  "botProvider": "antigravity",
  "slashPrefix": ""
}
{
  "input": "gemini",
  "provider": "antigravity",
  "botProvider": "antigravity",
  "slashPrefix": "gm"
}
```

Result: PASS.

Check: Help and settings do not leak old Gemini product identity.

Command run:

```bash
node --test test/report-formatters.test.mjs test/settings-panel.test.mjs test/slash-command-surface.test.mjs test/text-command-handler.test.mjs
```

Output observed:

```text
tests 84
pass 84
fail 0
```

Result: PASS.

Check: Static scans.

Command run:

```bash
rg -n --glob '!node_modules' --glob '!package-lock.json' 'Gemini CLI|gemini CLI|Gemini provider|provider key.*gemini' README.md README.en.md docs src test .env.example
rg -n --glob '!node_modules' --glob '!package-lock.json' '(provider === .gemini.|provider: .gemini.|BOT_PROVIDER=gemini|start:gemini|GEMINI__)' src test README.md README.en.md docs .env.example package.json scripts
find src test docs scripts -iname '*gemini*'
```

Output observed:

```text
Remaining hits are limited to the migration spec, the migration ledger, legacy compatibility docs, legacy compatibility tests, explicit legacy env fallback code, Google-owned .gemini cache paths, and the legacy provider shim src/providers/gemini.js.
find output: src/providers/gemini.js
```

Result: PASS.

Check: Full regression suite.

Command run:

```bash
npm run test:progress
```

Output observed:

```text
tests 502
pass 502
fail 0
```

Result: PASS.

Check: Real Antigravity CLI still runs.

Command run:

```bash
agy --sandbox --prompt "Reply with exactly: AID_AGY_PROVIDER_OK" --print-timeout 30s
```

Output observed:

```text
AID_AGY_PROVIDER_OK
```

Result: PASS.

Check: Patch hygiene.

Command run:

```bash
git diff --check
```

Output observed:

```text
no output
```

Result: PASS.

Current blocker status: none.
