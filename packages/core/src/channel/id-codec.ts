/**
 * Runtime-safe identifiers for channel control-plane handles.
 *
 * The branded string types prevent accidental mixing in TypeScript. Because
 * brands do not survive JSON serialization, the codec's wire format carries
 * an explicit `kind` discriminator and validates it while decoding.
 */

declare const workerIdBrand: unique symbol;
declare const providerResumeIdBrand: unique symbol;
declare const submissionIdBrand: unique symbol;
declare const workerRunIdBrand: unique symbol;

export type WorkerId = string & {
  readonly [workerIdBrand]: "WorkerId";
};

export type ProviderResumeId = string & {
  readonly [providerResumeIdBrand]: "ProviderResumeId";
};

export type SubmissionId = string & {
  readonly [submissionIdBrand]: "SubmissionId";
};

export type WorkerRunId = string & {
  readonly [workerRunIdBrand]: "WorkerRunId";
};

export const CHANNEL_ID_KINDS = [
  "worker",
  "provider_resume",
  "submission",
  "worker_run",
] as const;

export type ChannelIdKind = (typeof CHANNEL_ID_KINDS)[number];

export interface SerializedChannelId<K extends ChannelIdKind = ChannelIdKind> {
  kind: K;
  value: string;
}

export type SerializedWorkerId = SerializedChannelId<"worker">;
export type SerializedProviderResumeId = SerializedChannelId<"provider_resume">;
export type SerializedSubmissionId = SerializedChannelId<"submission">;
export type SerializedWorkerRunId = SerializedChannelId<"worker_run">;

export type ChannelIdErrorCode =
  | "channel_id_invalid"
  | "worker_id_type_mismatch"
  | "provider_resume_id_type_mismatch"
  | "submission_id_type_mismatch"
  | "worker_run_id_type_mismatch";

const MISMATCH_CODES: Readonly<Record<ChannelIdKind, ChannelIdErrorCode>> = {
  worker: "worker_id_type_mismatch",
  provider_resume: "provider_resume_id_type_mismatch",
  submission: "submission_id_type_mismatch",
  worker_run: "worker_run_id_type_mismatch",
};

/** A stable, structured failure from the channel ID codec. */
export class ChannelIdCodecError extends Error {
  readonly code: ChannelIdErrorCode;
  readonly expectedKind?: ChannelIdKind;
  readonly actualKind?: string;

  constructor(
    code: ChannelIdErrorCode,
    options: {
      expectedKind?: ChannelIdKind;
      actualKind?: string;
    } = {},
  ) {
    super(messageFor(code, options));
    this.name = "ChannelIdCodecError";
    this.code = code;
    this.expectedKind = options.expectedKind;
    this.actualKind = options.actualKind;
  }
}

function messageFor(
  code: ChannelIdErrorCode,
  options: {
    expectedKind?: ChannelIdKind;
    actualKind?: string;
  },
): string {
  if (code === "channel_id_invalid") {
    return "Invalid serialized channel ID";
  }
  return `Expected ${options.expectedKind ?? "channel"} ID, received ${
    options.actualKind ?? "unknown"
  } ID`;
}

function isChannelIdKind(value: unknown): value is ChannelIdKind {
  return (
    typeof value === "string" &&
    (CHANNEL_ID_KINDS as readonly string[]).includes(value)
  );
}

function assertRawId(value: string): void {
  if (value.length === 0) {
    throw new ChannelIdCodecError("channel_id_invalid");
  }
}

function parseSerializedChannelId(value: unknown): SerializedChannelId {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ChannelIdCodecError("channel_id_invalid");
  }
  const record = value as Record<string, unknown>;
  if (!isChannelIdKind(record.kind) || typeof record.value !== "string") {
    throw new ChannelIdCodecError("channel_id_invalid");
  }
  assertRawId(record.value);
  return { kind: record.kind, value: record.value };
}

function decodeId(
  value: unknown,
  expectedKind: ChannelIdKind,
): SerializedChannelId {
  const serialized = parseSerializedChannelId(value);
  if (serialized.kind !== expectedKind) {
    throw new ChannelIdCodecError(MISMATCH_CODES[expectedKind], {
      expectedKind,
      actualKind: serialized.kind,
    });
  }
  return serialized;
}

export function createWorkerId(value: string): WorkerId {
  assertRawId(value);
  return value as WorkerId;
}

export function createProviderResumeId(value: string): ProviderResumeId {
  assertRawId(value);
  return value as ProviderResumeId;
}

export function createSubmissionId(value: string): SubmissionId {
  assertRawId(value);
  return value as SubmissionId;
}

export function createWorkerRunId(value: string): WorkerRunId {
  assertRawId(value);
  return value as WorkerRunId;
}

export function serializeWorkerId(value: WorkerId): SerializedWorkerId {
  return { kind: "worker", value };
}

export function serializeProviderResumeId(
  value: ProviderResumeId,
): SerializedProviderResumeId {
  return { kind: "provider_resume", value };
}

export function serializeSubmissionId(
  value: SubmissionId,
): SerializedSubmissionId {
  return { kind: "submission", value };
}

export function serializeWorkerRunId(
  value: WorkerRunId,
): SerializedWorkerRunId {
  return { kind: "worker_run", value };
}

export function deserializeWorkerId(value: unknown): WorkerId {
  return createWorkerId(decodeId(value, "worker").value);
}

export function deserializeProviderResumeId(value: unknown): ProviderResumeId {
  return createProviderResumeId(decodeId(value, "provider_resume").value);
}

export function deserializeSubmissionId(value: unknown): SubmissionId {
  return createSubmissionId(decodeId(value, "submission").value);
}

export function deserializeWorkerRunId(value: unknown): WorkerRunId {
  return createWorkerRunId(decodeId(value, "worker_run").value);
}

type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Assert<T extends true> = T;
type _SubmissionIdIsNotWorkerId = Assert<
  IsAssignable<SubmissionId, WorkerId> extends false ? true : false
>;
type _WorkerRunIdIsNotWorkerId = Assert<
  IsAssignable<WorkerRunId, WorkerId> extends false ? true : false
>;
type _ProviderResumeIdIsNotWorkerId = Assert<
  IsAssignable<ProviderResumeId, WorkerId> extends false ? true : false
>;
