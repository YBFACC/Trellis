# Design: Phase-1 Multi-Agent Control Plane

## Boundary

The existing `WorkerState` reducer remains the durable projection of channel
process and turn events. It is not repurposed as the logical control-plane
state. A new task-local `WorkerRun` record represents one managed dispatch and
is the sole owner of lifecycle, resume, replacement, and graceful-stop rules.

This keeps process liveness (`pid`, supervisor and channel events) separate
from orchestration facts (`report_pending`, a completion acknowledgement, and
handoff context). A quiet process therefore cannot be accidentally projected
as failed or cancelled.

## Ownership and storage

`packages/core/src/channel/` owns:

- branded IDs and JSON codecs;
- `WorkerRun` types, transition validator, operation guards, and typed errors;
- task-local control-plane persistence under
  `<taskPath>/orchestration/worker-runs.json`;
- the task-local advisory lock and atomic state/prompt writes;
- structured dispatch records and SHA-256 prompt verification.

The state envelope is deliberately narrow:

```text
{ version: 1, runs: WorkerRun[], activeImplementerWorkerRunId?: WorkerRunId }
```

It does not contain a canonical finding ledger, snapshots, scope versions, or
task-schema changes. The store lock encloses every read/validate/write cycle so
concurrent spawn attempts cannot both acquire the Implementer slot.

## Worker-run operations

The public core API exposes a small durable control plane:

```text
dispatchWorkerRun  -> writes prompt, creates dispatched record, enforces gates
startWorkerRun     -> dispatched -> running
recordReport       -> running -> report_pending
completeWorkerRun  -> report_pending -> completed|failed|cancelled
resumeWorkerRun    -> completed -> running (explicit only)
requestGracefulStop-> running|report_pending -> stop_requested
acknowledgeStop    -> stop_requested -> completed|failed|cancelled
closeWorkerRun     -> terminal -> closed
sendWorkerInput    -> validates WorkerId, run state, and resume requirement
observeWorkerRun   -> records observation without changing lifecycle
```

`stop_requested` is an operation state between live and terminal states. It is
not a terminal state. The accepted lifecycle adds this one protocol state to
the supplied diagram so the requested graceful-stop audit can be represented
without lying that a live worker is already cancelled.

Each error is `WorkerControlPlaneError` with a stable code. ID category errors
continue to be produced by `ChannelIdCodecError`; control-plane errors include
`worker_not_resumed`, `worker_not_terminal`, `worker_invalid_transition`,
`active_implementer_exists`, and `worker_replacement_blocked`.

## Dispatch and CLI bridge

Managed dispatch is an additive structured mode of existing `channel spawn`.
It provides task path, role, package ID, round ID, write scope, finding IDs,
handoff data, and optional predecessor run ID. The CLI calls the core dispatch
API before it forks the supervisor. The generated config carries only the
structured request: `workerRunId`, `promptPath`, and `promptSha256`; it does
not embed the prompt.

The supervisor reads UTF-8 prompt bytes from `promptPath`, verifies the hash,
and gives the resulting string to the provider adapter. It marks the run
running only after its durable `spawned` event. A managed kill requests a
graceful stop first; supervisor terminal exit acknowledges the stop. Force,
crash, and confirmed-dead paths are the explicit exceptional terminal routes.

Legacy `channel spawn` invocations without managed fields preserve their
current behavior. They do not silently fabricate task control-plane state.

## Replacement and locking

`dispatchWorkerRun` resolves the predecessor within the same task store. It
rejects any replacement whose predecessor is `dispatched`, `running`,
`report_pending`, or `stop_requested`. On an allowed replacement it copies the
handoff bundle exactly. The same locked transaction rejects a second live
`trellis-implement` run and releases the slot only when that run reaches a
terminal or closed state.

## Verification shape

Core unit tests cover codecs, every legal/illegal transition, observations,
locking, handoff propagation, stop/close ordering, and prompt-byte round trips.
CLI tests cover structured spawn config and supervisor prompt-file loading;
existing channel runtime tests protect legacy behavior. A Checker reviews each
completed priority before the next begins.
