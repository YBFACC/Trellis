# Implementation Plan: on-demand Codex subagent usage query

## Scope and Ownership

The implementation changes the Core Codex adapter/public `mem` API and the
thin CLI wrapper. It does not modify hooks, Python task scripts, rollout files,
or runtime state.

## Ordered Work

1. Before editing source, load `trellis-before-dev` for the affected Core and
   CLI layers and re-check symbol impact. Preserve the already identified
   HIGH-risk boundaries: do not alter `codexListSessions` or `readJsonl`.
2. In Core, add the private archived Codex-root constant and a focused
   `readCodexContextUsage` implementation in the Codex adapter. Reuse `walkDir`,
   `readJsonlFirst`, and `readJsonl`; add local loose event shapes and guards
   rather than parsing raw fields in the CLI.
3. Add public result/status types in `packages/core/src/mem/types.ts` and export
   the function/types through `packages/core/src/mem/index.ts`. Keep the public
   API within the declared `@mindfoldhq/trellis-core/mem` subpath.
4. Add Core fixtures beside the existing Codex adapter tests for: active and
   archived discovery; newest matching file selection; final-event selection;
   cumulative usage greater than the window; malformed JSONL; no matching
   rollout; no token-count event; invalid/missing active token field; null or
   invalid context window; clamping/rounding; and no returned raw content.
5. Add `usage` to `packages/cli/src/commands/mem.ts`: accept one UUID and only
   `--json`/help, render the stable snake_case object, render a concise human
   result, update dispatch and help, and keep expected unavailable states as
   structured results.
6. Extend the existing `mem` CLI integration fixture to seed active and archived
   rollouts. Assert exact JSON semantics, command/help registration, usage-error
   handling, absence of sentinel transcript/path text, and a before/after
   filesystem snapshot proving no session or `.trellis/.runtime/` write.
7. Review public exports and command documentation for Core/CLI boundary drift.
   Run `trellis-check` after implementation before considering task completion.

## Validation Matrix

| Area | Validation |
| --- | --- |
| Core focused tests | `pnpm --filter @mindfoldhq/trellis-core test -- mem` or the exact affected test files |
| CLI focused tests | `pnpm --filter @mindfoldhq/trellis test -- mem-integration` |
| Package quality | `pnpm --filter @mindfoldhq/trellis-core lint`, `pnpm --filter @mindfoldhq/trellis-core typecheck`, `pnpm --filter @mindfoldhq/trellis lint`, `pnpm --filter @mindfoldhq/trellis typecheck` |
| Cross-package contract | `pnpm typecheck` and `pnpm build` |
| Full regression | `pnpm test`, then `git diff --check` |
| Scope review | `git status --short`, GitNexus `detect_changes`, and a manual JSON output audit |

## Risk Gates and Rollback

- Stop before broadening the change into existing session listing/search/context
  behavior; that boundary has HIGH impact and is not necessary for this query.
- Treat changes to the JSON output field names or status enum as public-contract
  changes; update fixtures before considering them.
- If an implementation needs a rollout index, hook, live API, or runtime write,
  return to planning rather than extending this task.
- Roll back only the new additive Core/CLI/test changes; no data cleanup is
  required because the feature creates no state.
