/**
 * Provider-injected worker runtime contract.
 *
 * Core owns event writes, reducer state, and the lifecycle contract. It
 * must NOT import CLI provider adapters or shell-specific process
 * behavior. The CLI adapter registry (or an external daemon) implements
 * {@link WorkerRuntime} and passes it into {@link spawnWorker} /
 * {@link interruptWorker}.
 */

import type {
  InterruptMethod,
  InterruptOutcome,
  InterruptReason,
} from "../internal/store/events.js";
import type {
  ChannelRef,
  ChannelScope,
  InboxPolicy,
} from "../internal/store/schema.js";
import type {
  ProviderResumeId,
  SerializedChannelId,
  WorkerId,
} from "../id-codec.js";

export interface WorkerStartInput {
  channel: ChannelRef;
  workerId: WorkerId;
  cwd: string;
  systemPrompt: string;
  model?: string;
  resume?: ProviderResumeId;
  env?: Record<string, string>;
}

export interface WorkerRuntimeHandle {
  workerId: WorkerId;
  provider?: string;
  pid?: number;
  startedAt: string;
}

export interface WorkerInterruptInput {
  workerId: WorkerId;
  turnId?: string;
  reason?: InterruptReason;
  message?: string;
}

export interface WorkerInterruptResult {
  method: InterruptMethod;
  outcome: InterruptOutcome;
  message?: string;
}

export interface WorkerStopInput {
  workerId: WorkerId;
  reason: "explicit-kill" | "timeout" | "crash" | "shutdown";
  signal?: NodeJS.Signals;
  force?: boolean;
}

export interface WorkerStopResult {
  outcome: "stopped" | "already-stopped" | "failed";
  signal?: NodeJS.Signals;
  message?: string;
}

export interface WorkerRuntime {
  start(input: WorkerStartInput): Promise<WorkerRuntimeHandle>;
  interrupt?(input: WorkerInterruptInput): Promise<WorkerInterruptResult>;
  stop?(input: WorkerStopInput): Promise<WorkerStopResult>;
}

export interface SpawnWorkerInput {
  channel: string;
  scope?: ChannelScope;
  projectKey?: string;
  cwd: string;
  by: string;
  /** Legacy string aliases remain accepted; tagged JSON is validated at ingress. */
  workerId: string | SerializedChannelId;
  provider?: string;
  agent?: string;
  systemPrompt: string;
  model?: string;
  resume?: string | SerializedChannelId;
  inboxPolicy?: InboxPolicy;
  timeoutMs?: number;
  meta?: Record<string, unknown>;
}
