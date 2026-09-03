/**
 * Durable, task-local lifecycle control for managed worker runs.
 *
 * This deliberately does not replace the channel `WorkerState` projection:
 * process/turn events remain channel facts, while report acknowledgement and
 * explicit resume are orchestration facts owned by this module.
 */

import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  createProviderResumeId,
  createWorkerId,
  createWorkerRunId,
  deserializeProviderResumeId,
  deserializeWorkerId,
  deserializeWorkerRunId,
  serializeProviderResumeId,
  serializeWorkerId,
  serializeWorkerRunId,
  type ProviderResumeId,
  type SerializedChannelId,
  type WorkerId,
  type WorkerRunId,
} from "./id-codec.js";
import { withLock } from "./internal/store/lock.js";

export const WORKER_RUN_LIFECYCLES = [
  "dispatched",
  "running",
  "report_pending",
  "stop_requested",
  "completed",
  "failed",
  "cancelled",
  "closed",
] as const;

export type WorkerRunLifecycle = (typeof WORKER_RUN_LIFECYCLES)[number];

export type WorkerRunTerminalLifecycle =
  | "completed"
  | "failed"
  | "cancelled";

export const WORKER_RUN_OBSERVATION_KINDS = [
  "waiting",
  "needs_observation",
  "silent",
  "wait_timeout",
  "no_diff",
] as const;

export type WorkerRunObservationKind =
  (typeof WORKER_RUN_OBSERVATION_KINDS)[number];

export interface WorkerRunObservation {
  kind: WorkerRunObservationKind;
  observedAt: string;
  detail?: Record<string, unknown>;
}

/** The durable record for one managed worker dispatch. */
export interface WorkerRun {
  workerRunId: WorkerRunId;
  workerId: WorkerId;
  taskPath: string;
  role: string;
  lifecycle: WorkerRunLifecycle;
  createdAt: string;
  startedAt?: string;
  resumedAt?: string;
  reportRecordedAt?: string;
  reportPath?: string;
  packageId?: string;
  writeScope?: string[];
  findingIds?: string[];
  previousReportPath?: string;
  lastEvidence?: string;
  roundId?: string;
  predecessorWorkerRunId?: WorkerRunId;
  promptPath?: string;
  promptSha256?: string;
  providerResumeId?: ProviderResumeId;
  stopRequestedAt?: string;
  stopReason?: string;
  terminalAt?: string;
  terminalReason?: string;
  closedAt?: string;
  observations: WorkerRunObservation[];
}

/** Narrow task-local envelope; no finding/snapshot ledger belongs here. */
export interface WorkerRunState {
  version: 1;
  runs: WorkerRun[];
  activeImplementerWorkerRunId?: WorkerRunId;
}

export type WorkerControlPlaneErrorCode =
  | "worker_run_exists"
  | "worker_run_not_found"
  | "worker_state_invalid"
  | "worker_invalid_transition"
  | "worker_not_resumed"
  | "worker_not_terminal"
  | "worker_id_mismatch"
  | "active_implementer_exists"
  | "worker_replacement_blocked"
  | "worker_prompt_hash_mismatch"
  | "worker_prompt_mismatch";

/** Stable errors for logical worker-run operations and persisted state. */
export class WorkerControlPlaneError extends Error {
  readonly code: WorkerControlPlaneErrorCode;

  constructor(code: WorkerControlPlaneErrorCode, message?: string) {
    super(message ?? messageFor(code));
    this.name = "WorkerControlPlaneError";
    this.code = code;
  }
}

function messageFor(code: WorkerControlPlaneErrorCode): string {
  switch (code) {
    case "worker_run_exists":
      return "Worker run already exists";
    case "worker_run_not_found":
      return "Worker run was not found";
    case "worker_state_invalid":
      return "Worker-run state is invalid";
    case "worker_invalid_transition":
      return "Worker-run lifecycle transition is invalid";
    case "worker_not_resumed":
      return "Worker run must be explicitly resumed before accepting input";
    case "worker_not_terminal":
      return "Worker run must be terminal before it can be closed";
    case "worker_id_mismatch":
      return "Worker ID does not belong to this worker run";
    case "active_implementer_exists":
      return "An active trellis-implement worker run already exists for this task";
    case "worker_replacement_blocked":
      return "Worker replacement requires a terminal predecessor";
    case "worker_prompt_hash_mismatch":
      return "Worker-run prompt SHA-256 does not match its stored bytes";
    case "worker_prompt_mismatch":
      return "Worker-run prompt reference does not match the durable dispatch record";
  }
}

export type WorkerRunIdReference = WorkerRunId | SerializedChannelId;
export type WorkerIdReference = WorkerId | SerializedChannelId;
export type ProviderResumeIdReference =
  | ProviderResumeId
  | SerializedChannelId;

export interface WorkerRunStoreInput {
  taskPath: string;
}

export interface CreateWorkerRunInput extends WorkerRunStoreInput {
  workerRunId: WorkerRunIdReference;
  workerId: WorkerIdReference;
  role: string;
  providerResumeId?: ProviderResumeIdReference;
  now?: () => Date;
}

export interface WorkerRunOperationInput extends WorkerRunStoreInput {
  workerRunId: WorkerRunIdReference;
  now?: () => Date;
}

export interface RecordWorkerReportInput extends WorkerRunOperationInput {
  reportPath?: string;
  lastEvidence?: string;
}

export interface CompleteWorkerRunInput extends WorkerRunOperationInput {
  outcome: WorkerRunTerminalLifecycle;
  reason?: string;
}

export interface ObserveWorkerRunInput extends WorkerRunOperationInput {
  kind: WorkerRunObservationKind;
  detail?: Record<string, unknown>;
}

export interface SendWorkerInput extends WorkerRunOperationInput {
  workerId: WorkerIdReference;
  text: string;
}

export interface WorkerRunWorkPackage {
  packageId: string;
  writeScope: string[];
  findingIds: string[];
  previousReportPath?: string;
  lastEvidence?: string;
  roundId: string;
}

export interface DispatchWorkerRunInput
  extends WorkerRunStoreInput,
    WorkerRunWorkPackage {
  workerRunId: WorkerRunIdReference;
  workerId: WorkerIdReference;
  role: string;
  prompt: string;
  providerResumeId?: ProviderResumeIdReference;
  predecessorWorkerRunId?: WorkerRunIdReference;
  now?: () => Date;
}

export interface DispatchedWorkerRun {
  run: WorkerRun;
  promptPath: string;
  promptSha256: string;
}

export interface RequestGracefulStopInput extends WorkerRunOperationInput {
  reason: string;
}

export interface AcknowledgeStopInput extends WorkerRunOperationInput {
  outcome: WorkerRunTerminalLifecycle;
  reason?: string;
}

/** Exceptional launch failure before a dispatched worker reaches runtime. */
export interface AbortDispatchedWorkerRunInput extends WorkerRunOperationInput {
  reason: string;
}

export interface VerifyWorkerRunPromptInput extends WorkerRunOperationInput {
  promptPath: string;
  promptSha256: string;
}

export interface WorkerRunInputDelivery {
  taskPath: string;
  workerRunId: WorkerRunId;
  workerId: WorkerId;
  text: string;
}

interface WorkerRunPaths {
  taskPath: string;
  orchestrationPath: string;
  statePath: string;
  lockPath: string;
  promptsPath: string;
}

interface SerializedWorkerRun {
  workerRunId: SerializedChannelId;
  workerId: SerializedChannelId;
  taskPath: string;
  role: string;
  lifecycle: WorkerRunLifecycle;
  createdAt: string;
  startedAt?: string;
  resumedAt?: string;
  reportRecordedAt?: string;
  reportPath?: string;
  packageId?: string;
  writeScope?: string[];
  findingIds?: string[];
  previousReportPath?: string;
  lastEvidence?: string;
  roundId?: string;
  predecessorWorkerRunId?: SerializedChannelId;
  promptPath?: string;
  promptSha256?: string;
  providerResumeId?: SerializedChannelId;
  stopRequestedAt?: string;
  stopReason?: string;
  terminalAt?: string;
  terminalReason?: string;
  closedAt?: string;
  observations: WorkerRunObservation[];
}

interface SerializedWorkerRunState {
  version: 1;
  runs: SerializedWorkerRun[];
  activeImplementerWorkerRunId?: SerializedChannelId;
}

const TERMINAL_LIFECYCLES: ReadonlySet<WorkerRunTerminalLifecycle> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

const TRANSITIONS: Readonly<
  Record<WorkerRunLifecycle, ReadonlySet<WorkerRunLifecycle>>
> = {
  dispatched: new Set(["running"]),
  running: new Set(["report_pending", "stop_requested", "failed", "cancelled"]),
  report_pending: new Set(["completed", "failed", "cancelled", "stop_requested"]),
  stop_requested: new Set(["completed", "failed", "cancelled"]),
  completed: new Set(["closed"]),
  failed: new Set(["closed"]),
  cancelled: new Set(["closed"]),
  closed: new Set(),
};

export function isTerminalWorkerRunLifecycle(
  lifecycle: WorkerRunLifecycle,
): lifecycle is WorkerRunTerminalLifecycle {
  return TERMINAL_LIFECYCLES.has(lifecycle as WorkerRunTerminalLifecycle);
}

/** Return the canonical task-local state file location. */
export function workerRunStatePath(taskPath: string): string {
  return pathsFor(taskPath).statePath;
}

/** Return the lock that serializes task-local worker-run mutations. */
export function workerRunLockPath(taskPath: string): string {
  return pathsFor(taskPath).lockPath;
}

export async function readWorkerRunState(
  input: WorkerRunStoreInput,
): Promise<WorkerRunState> {
  return readState(pathsFor(input.taskPath));
}

/** Normalize role names shared by channel and native agent surfaces. */
export function normalizeWorkerRunRole(role: string): string {
  const normalized = requireNonEmpty(role).trim().toLowerCase();
  if (normalized === "implement" || normalized === "trellis-implement") {
    return "trellis-implement";
  }
  if (normalized === "check" || normalized === "trellis-check") {
    return "trellis-check";
  }
  return normalized;
}

/** Create a dispatched run. Dispatch gates and prompt creation are later APIs. */
export async function createWorkerRun(input: CreateWorkerRunInput): Promise<WorkerRun> {
  const paths = pathsFor(input.taskPath);
  const workerRunId = asWorkerRunId(input.workerRunId);
  const workerId = asWorkerId(input.workerId);
  const providerResumeId =
    input.providerResumeId === undefined
      ? undefined
      : asProviderResumeId(input.providerResumeId);
  const now = timestamp(input.now);

  return mutateState(paths, async (state) => {
    if (state.runs.some((run) => run.workerRunId === workerRunId)) {
      throw new WorkerControlPlaneError("worker_run_exists");
    }
    const run: WorkerRun = {
      workerRunId,
      workerId,
      taskPath: paths.taskPath,
      role: requireNonEmpty(input.role),
      lifecycle: "dispatched",
      createdAt: now,
      ...(providerResumeId !== undefined ? { providerResumeId } : {}),
      observations: [],
    };
    state.runs.push(run);
    return run;
  });
}

/**
 * Create a managed dispatch under the task-local state lock. The prompt is
 * durable UTF-8 data, never source for shell or JavaScript evaluation.
 */
export async function dispatchWorkerRun(
  input: DispatchWorkerRunInput,
): Promise<DispatchedWorkerRun> {
  const paths = pathsFor(input.taskPath);
  const workerRunId = asWorkerRunId(input.workerRunId);
  const workerId = asWorkerId(input.workerId);
  const providerResumeId =
    input.providerResumeId === undefined
      ? undefined
      : asProviderResumeId(input.providerResumeId);
  const predecessorWorkerRunId =
    input.predecessorWorkerRunId === undefined
      ? undefined
      : asWorkerRunId(input.predecessorWorkerRunId);
  const role = normalizeWorkerRunRole(input.role);
  const now = timestamp(input.now);

  return mutateState(paths, async (state) => {
    if (state.runs.some((run) => run.workerRunId === workerRunId)) {
      throw new WorkerControlPlaneError("worker_run_exists");
    }
    if (role === "trellis-implement") {
      assertImplementerSlotAvailable(state);
    }

    const workPackage = predecessorWorkerRunId === undefined
      ? workPackageFromInput(input)
      : workPackageFromPredecessor(
          state.runs[findRunIndex(state, predecessorWorkerRunId)],
        );
    const promptPath = promptPathFor(paths, workerRunId);
    const promptSha256 = sha256(input.prompt);
    await writeTextAtomic(promptPath, input.prompt);

    const run: WorkerRun = {
      workerRunId,
      workerId,
      taskPath: paths.taskPath,
      role,
      lifecycle: "dispatched",
      createdAt: now,
      ...workPackage,
      ...(predecessorWorkerRunId !== undefined ? { predecessorWorkerRunId } : {}),
      promptPath,
      promptSha256,
      ...(providerResumeId !== undefined ? { providerResumeId } : {}),
      observations: [],
    };
    state.runs.push(run);
    if (role === "trellis-implement") {
      state.activeImplementerWorkerRunId = workerRunId;
    }
    return { run, promptPath, promptSha256 };
  });
}

/** Read the task-owned prompt only when it matches the durable dispatch. */
export async function verifyWorkerRunPrompt(
  input: VerifyWorkerRunPromptInput,
): Promise<string> {
  const paths = pathsFor(input.taskPath);
  const workerRunId = asWorkerRunId(input.workerRunId);
  const state = await readState(paths);
  const run = state.runs[findRunIndex(state, workerRunId)];
  if (run.promptPath !== input.promptPath || run.promptSha256 !== input.promptSha256) {
    throw new WorkerControlPlaneError("worker_prompt_mismatch");
  }
  const prompt = await fsp.readFile(run.promptPath, "utf8");
  if (sha256(prompt) !== run.promptSha256) {
    throw new WorkerControlPlaneError("worker_prompt_hash_mismatch");
  }
  return prompt;
}

export async function startWorkerRun(
  input: WorkerRunOperationInput,
): Promise<WorkerRun> {
  return transitionStoredRun(input, "running", "start");
}

/** Release a dispatched claim only for an unrecoverable pre-start failure. */
export async function abortDispatchedWorkerRun(
  input: AbortDispatchedWorkerRunInput,
): Promise<WorkerRun> {
  const paths = pathsFor(input.taskPath);
  const workerRunId = asWorkerRunId(input.workerRunId);
  const now = timestamp(input.now);
  return mutateState(paths, async (state) => {
    const index = findRunIndex(state, workerRunId);
    const run = transitionWorkerRun(state.runs[index], "failed", {
      now,
      operation: "abort_dispatched",
      terminalReason: requireNonEmpty(input.reason),
    });
    state.runs[index] = run;
    releaseImplementerSlotIfTerminal(state, run);
    return run;
  });
}

export async function recordReport(
  input: RecordWorkerReportInput,
): Promise<WorkerRun> {
  const paths = pathsFor(input.taskPath);
  const workerRunId = asWorkerRunId(input.workerRunId);
  const now = timestamp(input.now);
  return mutateState(paths, async (state) => {
    const index = findRunIndex(state, workerRunId);
    const run = transitionWorkerRun(state.runs[index], "report_pending", {
      now,
      operation: "report",
    });
    state.runs[index] = {
      ...run,
      ...(input.reportPath !== undefined
        ? { reportPath: requireNonEmpty(input.reportPath) }
        : {}),
      ...(input.lastEvidence !== undefined
        ? { lastEvidence: requireNonEmpty(input.lastEvidence) }
        : {}),
    };
    return state.runs[index];
  });
}

export async function completeWorkerRun(
  input: CompleteWorkerRunInput,
): Promise<WorkerRun> {
  const paths = pathsFor(input.taskPath);
  const workerRunId = asWorkerRunId(input.workerRunId);
  const now = timestamp(input.now);
  return mutateState(paths, async (state) => {
    const index = findRunIndex(state, workerRunId);
    const run = transitionWorkerRun(state.runs[index], input.outcome, {
      now,
      operation: "complete",
      ...(input.reason !== undefined ? { terminalReason: input.reason } : {}),
    });
    state.runs[index] = run;
    releaseImplementerSlotIfTerminal(state, run);
    return run;
  });
}

/** Record cooperative stop intent without closing or terminalizing the run. */
export async function requestGracefulStop(
  input: RequestGracefulStopInput,
): Promise<WorkerRun> {
  const paths = pathsFor(input.taskPath);
  const workerRunId = asWorkerRunId(input.workerRunId);
  const now = timestamp(input.now);
  return mutateState(paths, async (state) => {
    const index = findRunIndex(state, workerRunId);
    const run = transitionWorkerRun(state.runs[index], "stop_requested", {
      now,
      operation: "request_stop",
    });
    const updated = {
      ...run,
      stopRequestedAt: now,
      stopReason: requireNonEmpty(input.reason),
    };
    state.runs[index] = updated;
    return updated;
  });
}

/** Terminal acknowledgement for a previously requested cooperative stop. */
export async function acknowledgeStop(
  input: AcknowledgeStopInput,
): Promise<WorkerRun> {
  const paths = pathsFor(input.taskPath);
  const workerRunId = asWorkerRunId(input.workerRunId);
  const now = timestamp(input.now);
  return mutateState(paths, async (state) => {
    const index = findRunIndex(state, workerRunId);
    const run = transitionWorkerRun(state.runs[index], input.outcome, {
      now,
      operation: "acknowledge_stop",
      ...(input.reason !== undefined ? { terminalReason: input.reason } : {}),
    });
    state.runs[index] = run;
    releaseImplementerSlotIfTerminal(state, run);
    return run;
  });
}

export async function resumeWorkerRun(
  input: WorkerRunOperationInput,
): Promise<WorkerRun> {
  return transitionStoredRun(input, "running", "resume");
}

export async function closeWorkerRun(
  input: WorkerRunOperationInput,
): Promise<WorkerRun> {
  const paths = pathsFor(input.taskPath);
  const workerRunId = asWorkerRunId(input.workerRunId);
  const now = timestamp(input.now);
  return mutateState(paths, async (state) => {
    const index = findRunIndex(state, workerRunId);
    const current = state.runs[index];
    if (!isTerminalWorkerRunLifecycle(current.lifecycle)) {
      throw new WorkerControlPlaneError("worker_not_terminal");
    }
    const run = transitionWorkerRun(current, "closed", {
      now,
      operation: "close",
    });
    state.runs[index] = run;
    releaseImplementerSlotIfTerminal(state, run);
    return run;
  });
}

/**
 * Record an observation without changing logical lifecycle. Timeouts and
 * no-diff results are intentionally observations, never terminal outcomes.
 */
export async function observeWorkerRun(
  input: ObserveWorkerRunInput,
): Promise<WorkerRun> {
  const paths = pathsFor(input.taskPath);
  const workerRunId = asWorkerRunId(input.workerRunId);
  const now = timestamp(input.now);
  return mutateState(paths, async (state) => {
    const index = findRunIndex(state, workerRunId);
    const run = state.runs[index];
    const observation: WorkerRunObservation = {
      kind: input.kind,
      observedAt: now,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    };
    const updated = { ...run, observations: [...run.observations, observation] };
    state.runs[index] = updated;
    return updated;
  });
}

/**
 * Validate a run's logical input guard, then hand it to an injected sender.
 * The sender is intentionally injected: core has no provider adapter and the
 * ID/state checks therefore happen before any provider I/O.
 */
export async function sendWorkerInput<T>(
  input: SendWorkerInput,
  deliver: (input: WorkerRunInputDelivery) => Promise<T> | T,
): Promise<T> {
  const paths = pathsFor(input.taskPath);
  const workerRunId = asWorkerRunId(input.workerRunId);
  const workerId = asWorkerId(input.workerId);
  const state = await readState(paths);
  const run = state.runs[findRunIndex(state, workerRunId)];

  if (run.workerId !== workerId) {
    throw new WorkerControlPlaneError("worker_id_mismatch");
  }
  if (run.lifecycle !== "running") {
    throw new WorkerControlPlaneError("worker_not_resumed");
  }
  return deliver({
    taskPath: paths.taskPath,
    workerRunId,
    workerId,
    text: input.text,
  });
}

/**
 * Single transition validator. `resume` is the only operation allowed to
 * return a completed record to running, while stop acknowledgement is the
 * only operation allowed to terminalize a cooperative stop.
 */
export function transitionWorkerRun(
  run: WorkerRun,
  next: WorkerRunLifecycle,
  options: {
    now?: string;
    operation?:
      | "start"
      | "resume"
      | "report"
      | "complete"
      | "request_stop"
      | "acknowledge_stop"
      | "abort_dispatched"
      | "close";
    terminalReason?: string;
  } = {},
): WorkerRun {
  const operation = options.operation ?? "start";
  const allowed =
    run.lifecycle === "stop_requested" && isTerminalWorkerRunLifecycle(next)
      ? operation === "acknowledge_stop"
      : operation === "resume"
        ? run.lifecycle === "completed" && next === "running"
        : operation === "acknowledge_stop"
          ? false
          : operation === "abort_dispatched"
            ? run.lifecycle === "dispatched" && next === "failed"
            : TRANSITIONS[run.lifecycle].has(next);
  if (!allowed) {
    throw new WorkerControlPlaneError("worker_invalid_transition");
  }

  const now = options.now ?? new Date().toISOString();
  const transitioned: WorkerRun = { ...run, lifecycle: next };
  if (next === "running") {
    if (operation === "resume") {
      transitioned.resumedAt = now;
    } else {
      transitioned.startedAt = now;
    }
  }
  if (next === "report_pending") transitioned.reportRecordedAt = now;
  if (isTerminalWorkerRunLifecycle(next)) {
    transitioned.terminalAt = now;
    if (options.terminalReason !== undefined) {
      transitioned.terminalReason = options.terminalReason;
    }
  }
  if (next === "closed") transitioned.closedAt = now;
  return transitioned;
}

async function transitionStoredRun(
  input: WorkerRunOperationInput,
  next: WorkerRunLifecycle,
  operation: "start" | "resume",
): Promise<WorkerRun> {
  const paths = pathsFor(input.taskPath);
  const workerRunId = asWorkerRunId(input.workerRunId);
  const now = timestamp(input.now);
  return mutateState(paths, async (state) => {
    const index = findRunIndex(state, workerRunId);
    const run = transitionWorkerRun(state.runs[index], next, { now, operation });
    state.runs[index] = run;
    return run;
  });
}

function pathsFor(taskPath: string): WorkerRunPaths {
  const normalizedTaskPath = path.resolve(requireNonEmpty(taskPath));
  const orchestrationPath = path.join(normalizedTaskPath, "orchestration");
  return {
    taskPath: normalizedTaskPath,
    orchestrationPath,
    statePath: path.join(orchestrationPath, "worker-runs.json"),
    lockPath: path.join(orchestrationPath, ".worker-runs.lock"),
    promptsPath: path.join(orchestrationPath, "prompts"),
  };
}

function promptPathFor(paths: WorkerRunPaths, workerRunId: WorkerRunId): string {
  if (!/^[A-Za-z0-9._-]+$/.test(workerRunId)) {
    throw new WorkerControlPlaneError("worker_state_invalid");
  }
  return path.join(paths.promptsPath, `${workerRunId}.md`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function workPackageFromInput(input: WorkerRunWorkPackage): WorkerRunWorkPackage {
  return {
    packageId: requireNonEmpty(input.packageId),
    writeScope: requireStringArray(input.writeScope),
    findingIds: requireStringArray(input.findingIds),
    ...(input.previousReportPath !== undefined
      ? { previousReportPath: requireNonEmpty(input.previousReportPath) }
      : {}),
    ...(input.lastEvidence !== undefined
      ? { lastEvidence: requireNonEmpty(input.lastEvidence) }
      : {}),
    roundId: requireNonEmpty(input.roundId),
  };
}

function workPackageFromPredecessor(run: WorkerRun): WorkerRunWorkPackage {
  if (!isTerminalWorkerRunLifecycle(run.lifecycle) && run.lifecycle !== "closed") {
    throw new WorkerControlPlaneError("worker_replacement_blocked");
  }
  if (
    run.packageId === undefined ||
    run.writeScope === undefined ||
    run.findingIds === undefined ||
    run.roundId === undefined
  ) {
    throw new WorkerControlPlaneError("worker_replacement_blocked");
  }
  return {
    packageId: run.packageId,
    writeScope: [...run.writeScope],
    findingIds: [...run.findingIds],
    ...(run.reportPath !== undefined
      ? { previousReportPath: run.reportPath }
      : run.previousReportPath !== undefined
        ? { previousReportPath: run.previousReportPath }
        : {}),
    ...(run.lastEvidence !== undefined ? { lastEvidence: run.lastEvidence } : {}),
    roundId: run.roundId,
  };
}

function assertImplementerSlotAvailable(state: WorkerRunState): void {
  const active = state.activeImplementerWorkerRunId;
  if (active === undefined) return;
  const run = state.runs.find((candidate) => candidate.workerRunId === active);
  if (!run || isTerminalWorkerRunLifecycle(run.lifecycle) || run.lifecycle === "closed") {
    state.activeImplementerWorkerRunId = undefined;
    return;
  }
  throw new WorkerControlPlaneError("active_implementer_exists");
}

function releaseImplementerSlotIfTerminal(
  state: WorkerRunState,
  run: WorkerRun,
): void {
  if (
    state.activeImplementerWorkerRunId === run.workerRunId &&
    (isTerminalWorkerRunLifecycle(run.lifecycle) || run.lifecycle === "closed")
  ) {
    state.activeImplementerWorkerRunId = undefined;
  }
}

function asWorkerRunId(value: WorkerRunIdReference): WorkerRunId {
  return typeof value === "string"
    ? createWorkerRunId(value)
    : deserializeWorkerRunId(value);
}

function asWorkerId(value: WorkerIdReference): WorkerId {
  return typeof value === "string" ? createWorkerId(value) : deserializeWorkerId(value);
}

function asProviderResumeId(
  value: ProviderResumeIdReference,
): ProviderResumeId {
  return typeof value === "string"
    ? createProviderResumeId(value)
    : deserializeProviderResumeId(value);
}

function timestamp(now?: () => Date): string {
  return (now?.() ?? new Date()).toISOString();
}

function requireNonEmpty(value: string): string {
  if (value.length === 0) {
    throw new WorkerControlPlaneError("worker_state_invalid");
  }
  return value;
}

function requireStringArray(value: string[]): string[] {
  if (!Array.isArray(value)) {
    throw new WorkerControlPlaneError("worker_state_invalid");
  }
  return value.map(requireNonEmpty);
}

function findRunIndex(state: WorkerRunState, workerRunId: WorkerRunId): number {
  const index = state.runs.findIndex((run) => run.workerRunId === workerRunId);
  if (index === -1) throw new WorkerControlPlaneError("worker_run_not_found");
  return index;
}

async function mutateState<T>(
  paths: WorkerRunPaths,
  mutate: (state: WorkerRunState) => Promise<T> | T,
): Promise<T> {
  await fsp.mkdir(paths.orchestrationPath, { recursive: true, mode: 0o700 });
  return withLock(paths.lockPath, async () => {
    const state = await readState(paths);
    const result = await mutate(state);
    await writeStateAtomic(paths.statePath, state);
    return result;
  });
}

async function readState(paths: WorkerRunPaths): Promise<WorkerRunState> {
  let content: string;
  try {
    content = await fsp.readFile(paths.statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, runs: [] };
    }
    throw error;
  }
  try {
    return deserializeState(JSON.parse(content));
  } catch (error) {
    if (error instanceof WorkerControlPlaneError) throw error;
    throw new WorkerControlPlaneError("worker_state_invalid");
  }
}

async function writeStateAtomic(
  statePath: string,
  state: WorkerRunState,
): Promise<void> {
  await writeTextAtomic(
    statePath,
    `${JSON.stringify(serializeState(state), null, 2)}\n`,
  );
}

async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fsp.writeFile(tempPath, text, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function serializeState(state: WorkerRunState): SerializedWorkerRunState {
  return {
    version: 1,
    runs: state.runs.map((run) => ({
      workerRunId: serializeWorkerRunId(run.workerRunId),
      workerId: serializeWorkerId(run.workerId),
      taskPath: run.taskPath,
      role: run.role,
      lifecycle: run.lifecycle,
      createdAt: run.createdAt,
      ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      ...(run.resumedAt !== undefined ? { resumedAt: run.resumedAt } : {}),
      ...(run.reportRecordedAt !== undefined
        ? { reportRecordedAt: run.reportRecordedAt }
        : {}),
      ...(run.reportPath !== undefined ? { reportPath: run.reportPath } : {}),
      ...(run.packageId !== undefined ? { packageId: run.packageId } : {}),
      ...(run.writeScope !== undefined ? { writeScope: run.writeScope } : {}),
      ...(run.findingIds !== undefined ? { findingIds: run.findingIds } : {}),
      ...(run.previousReportPath !== undefined
        ? { previousReportPath: run.previousReportPath }
        : {}),
      ...(run.lastEvidence !== undefined ? { lastEvidence: run.lastEvidence } : {}),
      ...(run.roundId !== undefined ? { roundId: run.roundId } : {}),
      ...(run.predecessorWorkerRunId !== undefined
        ? {
            predecessorWorkerRunId: serializeWorkerRunId(
              run.predecessorWorkerRunId,
            ),
          }
        : {}),
      ...(run.promptPath !== undefined ? { promptPath: run.promptPath } : {}),
      ...(run.promptSha256 !== undefined
        ? { promptSha256: run.promptSha256 }
        : {}),
      ...(run.providerResumeId !== undefined
        ? { providerResumeId: serializeProviderResumeId(run.providerResumeId) }
        : {}),
      ...(run.stopRequestedAt !== undefined
        ? { stopRequestedAt: run.stopRequestedAt }
        : {}),
      ...(run.stopReason !== undefined ? { stopReason: run.stopReason } : {}),
      ...(run.terminalAt !== undefined ? { terminalAt: run.terminalAt } : {}),
      ...(run.terminalReason !== undefined
        ? { terminalReason: run.terminalReason }
        : {}),
      ...(run.closedAt !== undefined ? { closedAt: run.closedAt } : {}),
      observations: run.observations,
    })),
    ...(state.activeImplementerWorkerRunId !== undefined
      ? {
          activeImplementerWorkerRunId: serializeWorkerRunId(
            state.activeImplementerWorkerRunId,
          ),
        }
      : {}),
  };
}

function deserializeState(value: unknown): WorkerRunState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.runs)) {
    throw new WorkerControlPlaneError("worker_state_invalid");
  }
  const runs = value.runs.map(deserializeRun);
  const ids = new Set<string>();
  for (const run of runs) {
    if (ids.has(run.workerRunId)) {
      throw new WorkerControlPlaneError("worker_state_invalid");
    }
    ids.add(run.workerRunId);
  }
  const active = value.activeImplementerWorkerRunId;
  return {
    version: 1,
    runs,
    ...(active === undefined
      ? {}
      : { activeImplementerWorkerRunId: deserializeWorkerRunId(active) }),
  };
}

function deserializeRun(value: unknown): WorkerRun {
  if (!isRecord(value)) throw new WorkerControlPlaneError("worker_state_invalid");
  const lifecycle = value.lifecycle;
  if (!isWorkerRunLifecycle(lifecycle)) {
    throw new WorkerControlPlaneError("worker_state_invalid");
  }
  const observations = deserializeObservations(value.observations);
  return {
    workerRunId: deserializeWorkerRunId(value.workerRunId),
    workerId: deserializeWorkerId(value.workerId),
    taskPath: requireString(value.taskPath),
    role: requireString(value.role),
    lifecycle,
    createdAt: requireString(value.createdAt),
    ...(value.startedAt === undefined ? {} : { startedAt: requireString(value.startedAt) }),
    ...(value.resumedAt === undefined ? {} : { resumedAt: requireString(value.resumedAt) }),
    ...(value.reportRecordedAt === undefined
      ? {}
      : { reportRecordedAt: requireString(value.reportRecordedAt) }),
    ...(value.reportPath === undefined ? {} : { reportPath: requireString(value.reportPath) }),
    ...(value.packageId === undefined ? {} : { packageId: requireString(value.packageId) }),
    ...(value.writeScope === undefined
      ? {}
      : { writeScope: requireUnknownStringArray(value.writeScope) }),
    ...(value.findingIds === undefined
      ? {}
      : { findingIds: requireUnknownStringArray(value.findingIds) }),
    ...(value.previousReportPath === undefined
      ? {}
      : { previousReportPath: requireString(value.previousReportPath) }),
    ...(value.lastEvidence === undefined
      ? {}
      : { lastEvidence: requireString(value.lastEvidence) }),
    ...(value.roundId === undefined ? {} : { roundId: requireString(value.roundId) }),
    ...(value.predecessorWorkerRunId === undefined
      ? {}
      : { predecessorWorkerRunId: deserializeWorkerRunId(value.predecessorWorkerRunId) }),
    ...(value.promptPath === undefined ? {} : { promptPath: requireString(value.promptPath) }),
    ...(value.promptSha256 === undefined
      ? {}
      : { promptSha256: requireString(value.promptSha256) }),
    ...(value.providerResumeId === undefined
      ? {}
      : { providerResumeId: deserializeProviderResumeId(value.providerResumeId) }),
    ...(value.stopRequestedAt === undefined
      ? {}
      : { stopRequestedAt: requireString(value.stopRequestedAt) }),
    ...(value.stopReason === undefined ? {} : { stopReason: requireString(value.stopReason) }),
    ...(value.terminalAt === undefined ? {} : { terminalAt: requireString(value.terminalAt) }),
    ...(value.terminalReason === undefined
      ? {}
      : { terminalReason: requireString(value.terminalReason) }),
    ...(value.closedAt === undefined ? {} : { closedAt: requireString(value.closedAt) }),
    observations,
  };
}

function deserializeObservations(value: unknown): WorkerRunObservation[] {
  if (!Array.isArray(value)) throw new WorkerControlPlaneError("worker_state_invalid");
  return value.map((observation) => {
    if (!isRecord(observation) || !isObservationKind(observation.kind)) {
      throw new WorkerControlPlaneError("worker_state_invalid");
    }
    if (observation.detail !== undefined && !isRecord(observation.detail)) {
      throw new WorkerControlPlaneError("worker_state_invalid");
    }
    return {
      kind: observation.kind,
      observedAt: requireString(observation.observedAt),
      ...(observation.detail !== undefined
        ? { detail: observation.detail }
        : {}),
    };
  });
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkerControlPlaneError("worker_state_invalid");
  }
  return value;
}

function requireUnknownStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new WorkerControlPlaneError("worker_state_invalid");
  }
  return value.map(requireString);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkerRunLifecycle(value: unknown): value is WorkerRunLifecycle {
  return (
    typeof value === "string" &&
    (WORKER_RUN_LIFECYCLES as readonly string[]).includes(value)
  );
}

function isObservationKind(value: unknown): value is WorkerRunObservationKind {
  return (
    typeof value === "string" &&
    (WORKER_RUN_OBSERVATION_KINDS as readonly string[]).includes(value)
  );
}
