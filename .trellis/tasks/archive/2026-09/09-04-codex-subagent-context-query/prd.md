# Add on-demand Codex subagent context query

## Goal

Provide a read-only Trellis query entry that reports the latest persisted context usage for a native Codex subagent by agent/thread id, without real-time monitoring or hook-driven parent injection.

## User Value

Let a Main Agent make an informed continuation or handoff decision from a
child's persisted active-context size without reading its conversation or
monitoring a live process.

## Confirmed Repository Facts

- The existing `trellis mem` surface already provides `list`, `search`,
  `extract`, `context`, and `projects`; `context` is a dialogue-retrieval
  command and cannot be repurposed for token usage.
- The Core Codex adapter discovers current rollouts under
  `~/.codex/sessions/**/rollout-*.jsonl`, deriving the session id from the
  first event payload with the filename as a fallback. It does not currently
  discover `~/.codex/archived_sessions`.
- Core already owns a bounded synchronous JSONL iterator: it reads 256 KiB
  chunks, skips malformed rows, and invokes a consumer once per parsed object.
  The usage projection should use that iterator rather than loading a rollout
  or reimplementing JSONL parsing in the CLI.
- Verified persisted Codex `event_msg` records use
  `payload.type === "token_count"`; their payload contains
  `info.last_token_usage.total_tokens`,
  `info.total_token_usage.total_tokens`, and `info.model_context_window`.
  The first value is the active context size; the second is cumulative session
  usage and must not be used as the context denominator or numerator.
- Existing `MemSessionInfo` includes an internal rollout path. The new public
  result must expose only the requested usage projection, never that path or
  any rollout/transcript payload.

## Public Interface

- Add `trellis mem usage <agent-id> --json`. `agent-id` is the canonical Codex
  thread UUID and `--json` emits exactly one machine-readable result object.
- The command is globally scoped and Codex-only: it must not silently apply
  `mem`'s `--cwd`, `--global`, date, limit, or `--platform` filters. It accepts
  only its required identifier and `--json` / help flags.
- The result always includes `status`, `agent_id`, `used_tokens`,
  `model_context_window`, `used_percentage`, `remaining_percentage`, and a
  `percentage` descriptor. Values that cannot be established are `null`, never
  zero.
- `percentage.mode` is `model_context_window_ratio`; its baseline is the
  persisted `model_context_window`, and percentages are rounded to two decimal
  places after clamping to `0..100`. This is an explicit Trellis calculation,
  not an unverified claim about Codex TUI rounding.
- Expected non-throwing statuses are `available`, `invalid_agent_id`,
  `rollout_not_found`, `token_count_not_found`,
  `last_token_usage_unavailable`, and `model_context_window_unavailable`.

## Requirements

- Provide an explicit, read-only query entry for retrieving context usage for a
  native Codex subagent by its `agent_id` / thread id.
- Resolve the matching active or archived Codex rollout without requiring the
  caller to know the transcript path.
- Read the latest persisted `event_msg` whose payload type is `token_count`.
- Treat `last_token_usage.total_tokens` as the current active context size;
  never substitute the session-accumulated `total_token_usage.total_tokens`.
- Report the agent id, used tokens, model context window, used percentage, and
  remaining percentage. If the percentage follows Codex TUI semantics, expose
  the calculation mode and baseline so the result is not ambiguous.
- Provide machine-readable JSON output suitable for Main Agent decisions; a
  human-readable presentation may be added without replacing the JSON form.
- Return explicit unavailable states when the rollout, token-count event, or
  model context window cannot be found. Missing information must not be
  represented as zero usage.
- Keep the query side-effect free: do not modify the rollout, create runtime
  snapshots, register lifecycle hooks, inject context into the parent, or force
  an additional subagent turn.
- Validate the supplied identifier and do not emit transcript content or other
  conversation payloads.
- Avoid loading an entire potentially large rollout into memory.
- Limit the first version to native Codex subagents. Other providers require
  separately verified usage contracts and are out of scope.

## Out of Scope

- Live telemetry, polling, lifecycle hooks, parent-context injection,
  scheduling thresholds, and Trellis channel worker metrics.
- Reading or returning dialogue, prompts, tool input/output, rollout paths, or
  any other persisted event payloads.
- New configuration, a session index, rollout migration, or support for other
  providers.

## Acceptance Criteria

- [ ] Given a valid Codex child thread id with persisted usage, the query
      returns the latest `last_token_usage.total_tokens` and
      `model_context_window` values from that child rollout.
- [ ] The returned percentages are deterministic, clamped to `0..100`, and
      identify whether Codex's context baseline was applied.
- [ ] A fixture whose accumulated session usage exceeds the context window
      still reports the smaller active-context value from `last_token_usage`.
- [ ] Active-session and archived-session rollouts are both discoverable by
      agent/thread id.
- [ ] Missing rollout, missing `token_count`, malformed JSONL rows, and a null
      context window produce explicit, tested outcomes without a traceback.
- [ ] Querying does not change the rollout or write files under
      `.trellis/.runtime/`.
- [ ] Output contains no transcript messages, prompts, tool payloads, or other
      conversation content.
- [ ] Automated tests cover rollout discovery, latest-event selection, output
      semantics, failure states, and bounded-memory parsing.

## Key Decision

The public command is `trellis mem usage <agent-id> --json`. It remains inside
the persisted-session `mem` surface while avoiding the established dialogue
meaning of `trellis mem context`.
