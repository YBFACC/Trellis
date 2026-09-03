# Research: control-plane-phase-1-runtime-map

- Query: Map the canonical paths and integration seams for typed worker/resume IDs, worker lifecycle, role/replacement concurrency, graceful stop, and task-owned prompt-file dispatch.
- Scope: internal
- Date: 2026-09-03

## Findings

### Canonical owners and generated surfaces

This checkout is the canonical package workspace, not a consumer project or a
`node_modules` patch: `packages/cli/package.json` names
`@mindfoldhq/trellis` at `0.6.16` and takes
`@mindfoldhq/trellis-core` through `workspace:*`; `packages/core/package.json`
is the matching `0.6.16` SDK. `pnpm-workspace.yaml` includes `packages/*`.
There is no repository patch-package, pnpm patched-dependency, or override
configuration found.

The source owners are therefore:

| Owner | Files found | Responsibility |
| --- | --- | --- |
| Core channel domain | `packages/core/src/channel/id-codec.ts`, `api/runtime.ts`, `api/spawn.ts`, `api/interrupt.ts`, `internal/store/events.ts`, `internal/store/worker-state.ts`, `index.ts` | Public typed domain API, durable event protocol, event projection, runtime injection boundary. |
| CLI channel runtime | `packages/cli/src/commands/channel/spawn.ts`, `supervisor.ts`, `supervisor/shutdown.ts`, `kill.ts`, `guard.ts`, `adapters/index.ts`, `supervisor/stdout.ts` | Real process creation, provider I/O, OS signalling, supervisor configuration, and live-worker guard. |
| CLI compatibility layer | `packages/cli/src/commands/channel/store/{events,schema,filter,thread-state}.ts` | Current compatibility/re-export modules; the channel spec expressly says not to delete them while callers remain. |
| Template source | `packages/cli/src/templates/trellis/agents/{implement,check}.md` and `packages/cli/src/templates/codex/agents/trellis-*.toml` | Upstream source for generated channel role cards and native Codex role cards. The checkout's `.codex/agents/*` is generated/project-local output, not the source to change for a release. |

The installed-project runtime has a deliberate split. Channel workers load
`.trellis/agents/<name>.md`; native Codex subagents use `.codex/agents/`.
The channel worker gets the active task path only in a later inbox message,
not in its spawn configuration. This is documented by
`packages/cli/src/templates/common/bundled-skills/trellis-meta/references/local-architecture/multi-agent-channel.md:88-92`.

### 1. Typed IDs: codec exists, runtime adoption does not

`id-codec.ts` is the unique owner of the four brands and discriminated JSON
wire objects. It already provides stable mismatch codes and its public exports
are correctly surfaced through `channel/index.ts:3-32`. Existing
`id-codec.test.ts` covers JSON round trips and decoder mismatch cases.

The codec has not reached a runtime boundary:

- `WorkerStartInput.workerId`, `WorkerRuntimeHandle.workerId`,
  `WorkerInterruptInput.workerId`, `WorkerStopInput.workerId`, and
  `SpawnWorkerInput.workerId` are all `string`; `resume` is also `string`
  (`api/runtime.ts:22-85`).
- `spawnWorker` forwards those untagged strings to the injected runtime and
  writes the untagged alias into `spawned.as` (`api/spawn.ts:39-63`).
- `interruptWorker` accepts and forwards an untagged string
  (`api/interrupt.ts:12-18`, `120-143`).
- The CLI's `SpawnOptions.resume` and `SupervisorConfig.resume` are untagged
  strings (`commands/channel/spawn.ts:29-61`, `supervisor.ts:31-83`), and the
  Codex/Claude adapters read them as such (`adapters/index.ts:50-65`,
  `105-185`).
- Repository-wide search found no consumer of `SubmissionId` or `WorkerRunId`
  outside the new codec and its tests. In particular, there is no existing
  submission API, no `waitWorker`, `closeWorker`, `resumeWorker`, or
  `sendInput` API to retrofit.

Implication: the completed codec is necessary but does not yet satisfy the
requested runtime rejection. A brand is erased at runtime, so the runtime API
must accept a tagged `SerializedWorkerId` / `SerializedProviderResumeId` at
its JSON ingress and decode it before dispatch; TypeScript brands alone cannot
produce a runtime mismatch error.

### 2. Current lifecycle and terminal-event path

`WorkerState` is a legacy channel-worker projection, not the requested
control-plane worker-run state machine. It currently has
`starting | running | done | error | killed | crashed`
(`worker-state.ts:10-26`) and is reduced from channel events only.

The effective path is:

1. CLI `channelSpawn` holds project and worker locks then forks a detached
   supervisor (`spawn.ts:161-231`, `234-322`). The supervisor emits
   `spawned` only after the provider process starts (`supervisor.ts:411-457`).
2. Provider stdout is parsed by the adapter. `applyParseResult` appends
   `done`/`error` and records a turn finish, but an adapter `done` deliberately
   means a turn completed, not that the worker ended
   (`supervisor/stdout.ts:188-247`; verified by
   `core/test/channel/channel-runtime.test.ts:381-398`).
3. The reducer makes `done` terminal only when it is synthesized, and makes
   `error` terminal only when synthesized or issued by `supervisor:`.
   `killed` is terminal (`worker-state.ts:215-258`).
4. On a cold child exit, `ShutdownController.finalizeOnExit` synthesizes
   terminal `done` or `error`; during a shutdown it writes `killed` instead
   (`supervisor/shutdown.ts:172-214`).
5. Core reconciliation may append a synthesized supervisor-dead `error`, but
   only if the caller opts into `appendTerminalEvents`
   (`api/workers.ts:175-238`).

`waiting`, `awake`, and `supervisor_warning` are event kinds, not lifecycle
states (`events.ts:23-68`, `293-307`). They currently do not mutate
`WorkerState`, which is compatible with the requirement that an observation
must not auto-cancel a worker.

### 3. Existing concurrency controls are not role/replacement controls

There are two real process-level locks:

- A project `.worker-guard.lock` serializes a global live-worker budget.
- A per-channel/alias worker lock serializes spawn vs. kill for one alias
  (`spawn.ts:188-229`; `kill.ts:20-35`).

They prevent PID-file races and budget overcommit, but neither knows
`trellis-implement`, task path, worktree, package, round, or replacement.
The budget scan projects `WorkerState` across the project bucket and treats
any non-terminal process with a live supervisor PID as live
(`guard.ts:310-380`). Therefore it cannot distinguish a main research worker
from an implementer, nor can it make a task-scoped active-implementer claim.

`agent-loader.ts` does expose the parsed agent name, labels, provider, model,
and full prompt (`agent-loader.ts:18-31`, `74-119`). The bundled channel role
cards are named `implement` and `check`, not `trellis-implement` and
`trellis-check` (`templates/trellis/agents/implement.md:1-7`,
`check.md:1-7`). Native Codex role files use the `trellis-*` names. Any role
classifier must normalize both surfaces rather than infer role from a worker
alias.

No replacement payload, prior report path, package ID, finding IDs, write
scope, or round ID is presently persisted by the channel runtime. The
`spawned` event only carries alias/provider/PID/agent/context lists
(`events.ts:179-192`) and `SupervisorConfig` contains runtime launch data,
not a task work package (`supervisor.ts:31-83`).

### 4. Existing stop and timeout behavior

`channelWait` only aborts its local event iterator and sets exit code `124`;
it does not alter worker state (`wait.ts:35-74`). This already meets the
specific “wait timeout is an observation” rule.

The active supervisor behavior conflicts with the proposed policy:

- `--timeout` invokes `shutdown.request("SIGTERM", "timeout")`, which
  writes a terminal `killed` event (`supervisor.ts:472-495`; shutdown write at
  `supervisor/shutdown.ts:129-169`).
- Idle cleanup defaults to five minutes. It writes a `shutdown-reason` sidecar
  then signals `SIGTERM` for a non-terminal idle worker
  (`guard.ts:475-553`). `channelSpawn` calls this cleanup before each new
  spawn (`spawn.ts:176-213`), and the supervisor also starts an idle timer
  (`supervisor.ts:459-470`).
- Normal `channelKill` sends SIGTERM and waits; if the grace expires it sends
  SIGKILL and appends `killed` itself (`kill.ts:37-139`). It has no durable
  `stop_requested`, acknowledgement, or terminal-report phase.

The existing `ShutdownController` is useful for the *exceptional* force path:
it is idempotent and owns the stdin-close -> SIGTERM -> SIGKILL ladder
(`supervisor/shutdown.ts:101-170`). It cannot itself satisfy graceful-stop
because it records terminal `killed` before an agent acknowledgement or final
report. The new normal stop protocol must sit above it; force kill / confirmed
dead-runtime / safety abort can retain this controller.

### 5. Prompt construction, provider configuration, and persistence

The current channel path is data-safe with respect to JavaScript parsing:
`buildSystemPrompt` concatenates runtime strings (`spawn.ts:124-150`), writes
the config through `JSON.stringify` (`supervisor.ts:602-612`), and launches
with `child_process.spawn(command, string[])` (`supervisor.ts:242-250`). It
does not use `eval`, `Function`, generated JavaScript source, shell command
concatenation, or a template literal compiled from prompt text. Thus backticks
and `${...}` will not produce the described spawn SyntaxError in this path.

There is partial prompt-file support, but it is not task-owned structured
dispatch:

- The supervisor writes `<worker>.system-prompt.md` only once the prompt is
  over the Claude inline threshold (`supervisor.ts:195-221`).
- Only the Claude adapter consumes that path via
  `--append-system-prompt-file`; tests cover its large-prompt argv escape
  hatch (`channel-claude-adapter.test.ts:23-37`).
- Codex calls `thread/start` with the in-memory prompt value
  (`adapters/index.ts:142-172`).
- Cleanup deletes the prompt file (`supervisor.ts:547-579`), so no durable
  prompt path or SHA-256 exists for a later replacement/audit.

The desired `<TASK_DIR>/orchestration/prompts/<workerRunId>.md` is therefore a
new persistence contract. It must be written before dispatch, atomically
claimed alongside the control record, read UTF-8 by the runtime, and retained
through a closed run so the SHA/path can prove what was sent.

### Existing tests to extend or add

| Requirement | Existing test anchor | Recommended coverage |
| --- | --- | --- |
| ID codec and actual runtime ingress | `packages/core/test/channel/id-codec.test.ts`; `channel-runtime.test.ts:237-351` | Keep codec round trips; add compile-time `@ts-expect-error` fixtures plus runtime tagged-ID mismatch tests which assert the runtime was not called. |
| State machine | `packages/core/test/channel/worker-state.test.ts` | Add a separate `control-plane.test.ts` for legal/illegal run transitions and observations. Do not reinterpret legacy `done` as worker exit. |
| Implementer lock/replacement gate | `packages/cli/test/commands/channel-guard.test.ts:379-451` is closest lock/FS test harness | New CLI control-dispatch integration test: concurrent task-scoped implementer claim, check replacement rejection, terminal predecessor acceptance, inherited package/scope/finding/report/evidence/round fields. |
| Graceful stop | `packages/core/test/channel/channel-runtime.test.ts:276-351`; `packages/cli/test/commands/channel.test.ts` supervisor helpers | Unit-test stop request -> acknowledgement/terminal -> close, direct live close rejection, and wait timeout no state transition. Retain force-path tests separately. Convert/remove idle cleanup tests only after policy change. |
| Prompt file / structured dispatch | `packages/cli/test/commands/channel-claude-adapter.test.ts`; `channel-codex-adapter.test.ts` | New dispatch-store tests for special characters and a 10KB+ prompt, exact SHA-256/path persistence, UTF-8 readback, and provider receives the exact string without generated-source evaluation. |

## Minimal integration design

Implement one new public core control-plane module (for example
`packages/core/src/channel/control-plane.ts`) rather than repurposing
`WorkerState`. Keep `WorkerState` as the backwards-compatible projection of
channel events. The new module should own:

1. `WorkerRunRecord` keyed by `WorkerRunId`, with a tagged `WorkerId`, role,
   task path, worktree identity, optional tagged provider-resume ID, structured
   work-package inheritance, prompt path/hash, lifecycle timestamps/reasons,
   and an observation list separate from lifecycle.
2. `transitionWorkerState(record, next, evidence)` with the requested state
   graph: `dispatched -> running -> report_pending -> completed|failed|cancelled
   -> closed`, plus `running|report_pending -> failed|cancelled` and
   `running|report_pending -> stop_requested -> completed|failed|cancelled`.
   `waiting`, timeout, silence, and needs-observation remain append-only
   observations. Reject every other edge with a stable control-plane error.
3. Atomic task-local persistence at
   `<task>/orchestration/control-plane.json` plus a sibling exclusive lock;
   prompt data at `<task>/orchestration/prompts/<workerRunId>.md`. This is a
   bounded control-plane record, not a finding/snapshot database or a new CLI.
4. `claimDispatch` under that same lock. It performs the typed-ID decode before
   calling a provider, the one-active-implementer check per task/worktree, and
   the terminal-predecessor/replacement inheritance check. It returns stable
   errors: `active_implementer_exists`, `worker_replacement_blocked`,
   `worker_not_resumed`, `worker_not_terminal`, and
   `worker_state_transition_invalid`.
5. A thin CLI bridge in `channelSpawn`/supervisor config that uses the module
   only for structured task dispatches. Generic channel workers stay
   compatible. The bridge must derive a canonical role from the loaded agent
   definition (normalizing `implement`/`check` and `trellis-implement`/
   `trellis-check`) and require a task reference for a controlled role rather
   than guessing from an alias.
6. A normal stop API that appends/persists `stop_requested` with reason and
   timestamp, sends a non-interrupting request through the inbox, waits for a
   terminal report, then permits `close`. Preserve `ShutdownController` only
   for user-explicit force, safety, confirmed dead process, or unrecoverable
   process failure. Change ordinary timeout/idle paths to observations; they
   must not call the shutdown ladder or free the implementer lock.

This allows the five priorities to be delivered without a broad orchestration
CLI, schema migration, finding database, snapshot hash subsystem, or changes
to the legacy `WorkerState` API.

## Related specs

- `.trellis/spec/core/backend/index.md` — core owns reusable domain APIs;
  CLI must import the public `@mindfoldhq/trellis-core/channel` subpath.
- `.trellis/spec/cli/backend/commands-channel.md` — core/CLI split, event-log
  ownership, compatibility wrappers, and supervisor boundaries.
- `.trellis/spec/cli/backend/trellis-core-sdk.md` — public export and
  package-boundary contract.
- `.trellis/spec/cli/backend/filesystem-safety.md` — required before adding
  task-local prompt/state persistence and lock files.
- `.trellis/spec/cli/unit-test/{conventions,integration-patterns}.md` —
  Vitest temp-directory and full-flow coverage expectations.

## External references / versions

- Workspace package versions verified locally: `@mindfoldhq/trellis` and
  `@mindfoldhq/trellis-core` are both `0.6.16`.
- No external dependency/documentation was needed for this code-path map.

## Caveats / Not Found

- The requested `SubmissionId`, `WorkerRunId`, `waitWorker`, `resumeWorker`,
  `closeWorker`, and `sendInput` APIs do not yet exist outside the codec. They
  cannot be “wired through” without introducing a deliberately bounded
  control-plane API.
- Native Codex subagent dispatch is a host/App capability, not a call path in
  the Trellis CLI. The CLI cannot enforce a lock for native subagents unless a
  dispatch hook/wrapper explicitly calls the new control-plane API. The
  channel-runtime bridge only covers `trellis channel spawn` workers.
- Current bundled channel `check` role permits small production self-fixes
  (`templates/trellis/agents/check.md:35-48`), while the supplied requirement
  says Checker may modify tests only. This is a real semantic mismatch. Do not
  silently alter every generated role card as part of the five runtime
  features; decide separately whether the desired Checker rule applies only to
  native Codex, only to channel workers, or to every platform template.
- The current default five-minute idle cleanup and explicit `--timeout` kill
  directly violate the new “silence/timeout is observation only” requirement.
  Leaving either enabled for controlled worker runs would make the acceptance
  tests nondeterministic and could permit premature replacement.
