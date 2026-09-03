# Implementation Plan: Phase-1 Multi-Agent Control Plane

## Invariants

- Work serially. Only one Implementer edits production files at a time.
- Core remains independent of Commander, Chalk, process exits, and provider
  adapters. CLI only translates flags, starts processes, and renders errors.
- Every task-local state or prompt write is atomic and every state mutation is
  serialized by the task-local lock.
- No timeout, silence, missing diff, or wait result can create a terminal
  lifecycle transition.

## Ordered work

1. Preserve and extend the completed ID codec, then type the core runtime
   contracts and add local runtime category guards.
2. Add the core WorkerRun model, transition table, stable errors, state store,
   input/resume guard, observations, and test matrix.
3. Add task-scoped Implementer and replacement checks to the dispatch
   transaction, including full handoff propagation and concurrent lock tests.
4. Add graceful-stop request/acknowledgement/close APIs and wire the managed
   supervisor/kill terminal paths without changing legacy timeout semantics.
5. Add atomic prompt-file creation, SHA-256 verification, structured dispatch
   config, and the CLI/supervisor bridge. Cover hostile and 10 KB+ prompts.

After each numbered item: run targeted tests, request independent Checker
review, repair only confirmed findings, then re-run the relevant tests before
moving to the next item.

## Final verification

```text
pnpm --filter @mindfoldhq/trellis-core lint
pnpm --filter @mindfoldhq/trellis-core typecheck
pnpm --filter @mindfoldhq/trellis-core test
pnpm --filter @mindfoldhq/trellis lint
pnpm --filter @mindfoldhq/trellis typecheck
pnpm --filter @mindfoldhq/trellis test
pnpm build
git diff --check
```

Run GitNexus `detect-changes` before any commit. Do not commit, archive, or
start second-phase persistence/migration work in this task.
