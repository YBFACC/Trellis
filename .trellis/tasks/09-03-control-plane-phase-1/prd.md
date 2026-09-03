# Trellis multi-agent control-plane phase 1

## Goal

Implement the five approved control-plane reliability priorities in strict order: typed IDs, lifecycle state machine, implementer and replacement gates, graceful stop, and prompt-file structured dispatch.

## Requirements

- Preserve the established Main / Research / Implementer / Checker role split.
  A shared worktree must never have more than one active `trellis-implement`
  worker for one task.
- Make worker aliases, provider resume handles, submissions, and worker-run
  handles distinct at TypeScript and JSON boundaries. Runtime entry points must
  return stable typed errors before they can call a provider with the wrong ID.
- Add one control-plane-owned worker-run lifecycle:
  `dispatched → running → report_pending → completed|failed|cancelled → closed`.
  `waiting`, `needs_observation`, `silent`, and a wait timeout are observations,
  never lifecycle transitions or terminal states.
- Enforce the single-Implementer and replacement rules transactionally for a
  task. A replacement must inherit package, write scope, finding IDs, prior
  report path, last evidence, and round ID; non-terminal predecessors block it.
- Replace direct stop/close behavior for managed runs with graceful-stop intent,
  terminal acknowledgement, then close. Record stop and terminal timestamps and
  reasons. Immediate interruption remains limited to force, safety, dead
  runtime, and unrecoverable process failures.
- Dispatch managed workers through a UTF-8 prompt file and a structured request
  carrying prompt path and SHA-256. Prompt bytes are data, never JavaScript or
  shell source. Existing unstructured channels remain compatible but are not
  promoted to managed worker runs automatically.
- Integrate the managed path into the existing channel spawn / supervisor / kill
  boundaries without introducing a second orchestration CLI, a finding database,
  snapshot hashing, scope versions, task schema migration, or sandbox policy.

## Acceptance Criteria

- [ ] A `SubmissionId` or `WorkerRunId` cannot be supplied to a worker-run API;
      the runtime rejects it with a stable mismatch error before provider I/O.
- [ ] Valid worker-run transitions succeed; `running → closed` and
      `completed → running` fail. A completed run cannot receive input until an
      explicit resume transition succeeds.
- [ ] A wait timeout and a no-diff observation leave a running lifecycle intact.
- [ ] A second active Implementer for the same task is rejected. A replacement
      is rejected until the predecessor is terminal, and then preserves every
      required handoff field.
- [ ] Graceful stop records intent, does not close a live run, reaches a
      terminal state only after acknowledgement, and only then permits close.
- [ ] Structured dispatch creates and hashes a UTF-8 prompt file. Prompts with
      backticks, `${value}`, fenced Markdown, Chinese, JSON, shell syntax, and
      more than 10 KB round-trip byte-for-byte without dynamic evaluation.
- [ ] Existing channel worker-state projection and legacy spawn behavior remain
      covered by their current tests.
- [ ] Core and CLI lint, typecheck, build, full tests, diff check, and an
      independent Checker review pass.

## Notes

- The original user-supplied control-plane document is the source requirement.
- This task is intentionally serial: typed IDs are the prerequisite for all
  later operations; no two Implementers may modify the shared worktree.
