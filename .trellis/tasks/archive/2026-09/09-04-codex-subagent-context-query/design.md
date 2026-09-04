# Design: on-demand Codex subagent usage query

## Boundaries

`@mindfoldhq/trellis-core/mem` owns all persisted-rollout discovery, identifier
validation, JSONL decoding, status projection, and percentage calculation. It
must have no terminal output, process exits, hook calls, writes, or CLI imports.

`packages/cli/src/commands/mem.ts` owns the `usage` subcommand's argument
allowlist, help text, human rendering, and the stable snake_case JSON shape. It
imports Core only through `@mindfoldhq/trellis-core/mem`.

The existing `codexListSessions` and shared `readJsonl` are intentionally not
changed. Their impact reports are HIGH because current search, context, and
extract flows depend on them; the new reader reuses `readJsonl` without changing
its contract.

## Data Flow

```
agent UUID
  -> Core UUID validation and lowercase canonicalization
  -> scan ~/.codex/sessions and ~/.codex/archived_sessions for rollout JSONL
  -> identify matching rollout from first-event id (filename id only as fallback)
  -> stream that rollout and retain only the final token_count projection
  -> validate active tokens and context-window fields
  -> Core status result
  -> CLI JSON or concise human rendering
```

Both roots are walked lazily. If the same id is found in both roots, Core uses
the newest file modification time, then streams only that selected rollout.
Malformed rows and files that disappear during discovery are skipped. The
selected rollout is scanned once with the existing 256 KiB chunked iterator; no
dialogue, tool payload, or array of events is retained.

## Core Contract

Expose a new read-only `readCodexContextUsage(agentId)` function plus public
discriminated result types from the existing `@mindfoldhq/trellis-core/mem`
subpath. The result's common fields are:

```ts
{
  status: "available" | "invalid_agent_id" | "rollout_not_found"
    | "token_count_not_found" | "last_token_usage_unavailable"
    | "model_context_window_unavailable";
  agentId: string | null;
  usedTokens: number | null;
  modelContextWindow: number | null;
  usedPercentage: number | null;
  remainingPercentage: number | null;
  percentage: {
    mode: "model_context_window_ratio";
    baselineTokens: number | null;
    decimalPlaces: 2;
  };
}
```

The identifier is accepted only when it is UUID-shaped; Core lowercases it
before matching. It is not used as a path segment. A rollout matches its first
event's `payload.id`, falling back to the existing `rollout-<timestamp>-<id>`
filename convention only when the header lacks an id.

During the selected file's streaming pass, every event whose top-level type is
`event_msg` and whose `payload.type` is `token_count` replaces the prior scalar
candidate. At EOF, Core evaluates that *last* candidate; it never falls back to
an older token-count event when the latest one is incomplete. The active size
is only `info.last_token_usage.total_tokens`. A finite non-negative active size
is required; a finite positive `info.model_context_window` is required for
percentages. Cumulative `total_token_usage` is ignored.

For an available result, calculate
`round(clamp(usedTokens / modelContextWindow * 100, 0, 100), 2)` and set
`remainingPercentage` to `round(100 - usedPercentage, 2)`. The descriptor
names the persisted context-window baseline, so consumers do not mistake it for
session-accumulated usage or undocumented TUI formatting.

## CLI Contract

`trellis mem usage <agent-id> --json` prints one object with snake_case versions
of the Core fields and nothing else on stdout. Expected unavailable statuses are
data results rather than a traceback or a synthetic zero. A missing positional
argument or unsupported flag remains a normal usage error (exit 2).

Without `--json`, print the status and only established scalar fields. Do not
render a rollout path, raw event, model prompt, or tool content. The help text
identifies this as a Codex-only, globally discovered query.

## Compatibility, Safety, and Rollback

- Existing `mem` subcommands, their filtering behavior, session metadata, and
  JSONL iterator stay unchanged.
- The new archive-root constant is private to Core's internal paths module;
  the only public addition is the focused read-only API and CLI subcommand.
- The query neither creates an index nor writes under a rollout root or
  `.trellis/.runtime/`; concurrent file removal degrades to an explicit
  unavailable result.
- Rollback is removal of the new Core API, CLI branch, and tests; no persisted
  state or generated files require migration.

## Deferred Risk

The persisted `token_count` event is an observed Codex storage contract rather
than a versioned public API. Field/type guards and explicit unavailable states
contain format drift; adding other providers requires its own verified contract.
