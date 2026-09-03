import { describe, expect, it } from "vitest";

import {
  ChannelIdCodecError,
  createProviderResumeId,
  createSubmissionId,
  createWorkerId,
  createWorkerRunId,
  deserializeProviderResumeId,
  deserializeSubmissionId,
  deserializeWorkerId,
  deserializeWorkerRunId,
  serializeProviderResumeId,
  serializeSubmissionId,
  serializeWorkerId,
  serializeWorkerRunId,
  type WorkerId,
} from "../../src/channel/index.js";

describe("channel ID codec", () => {
  it("round-trips every typed ID through JSON", () => {
    const cases = [
      [createWorkerId("implementer-a"), serializeWorkerId, deserializeWorkerId],
      [
        createProviderResumeId("provider-thread-123"),
        serializeProviderResumeId,
        deserializeProviderResumeId,
      ],
      [
        createSubmissionId("submission-123"),
        serializeSubmissionId,
        deserializeSubmissionId,
      ],
      [createWorkerRunId("run-123"), serializeWorkerRunId, deserializeWorkerRunId],
    ] as const;

    for (const [id, serialize, deserialize] of cases) {
      const recovered = deserialize(JSON.parse(JSON.stringify(serialize(id))));
      expect(recovered).toBe(id);
    }
  });

  it("keeps WorkerId isolated at compile time", () => {
    const takesWorkerId = (value: WorkerId): WorkerId => value;
    expect(takesWorkerId(createWorkerId("worker-a"))).toBe("worker-a");
  });

  it("rejects a submission where a worker ID is required", () => {
    const serialized = serializeSubmissionId(createSubmissionId("submission-a"));

    expect(() => deserializeWorkerId(serialized)).toThrow(
      expect.objectContaining({
        code: "worker_id_type_mismatch",
        expectedKind: "worker",
        actualKind: "submission",
      }),
    );
  });

  it("rejects a worker where a submission ID is required", () => {
    const serialized = serializeWorkerId(createWorkerId("worker-a"));

    expect(() => deserializeSubmissionId(serialized)).toThrow(
      expect.objectContaining({
        code: "submission_id_type_mismatch",
        expectedKind: "submission",
        actualKind: "worker",
      }),
    );
  });

  it("rejects a worker where a provider resume ID is required", () => {
    const serialized = serializeWorkerId(createWorkerId("worker-a"));

    expect(() => deserializeProviderResumeId(serialized)).toThrow(
      expect.objectContaining({
        code: "provider_resume_id_type_mismatch",
        expectedKind: "provider_resume",
        actualKind: "worker",
      }),
    );
  });

  it("rejects a worker where a worker run ID is required", () => {
    const serialized = serializeWorkerId(createWorkerId("worker-a"));

    expect(() => deserializeWorkerRunId(serialized)).toThrow(
      expect.objectContaining({
        code: "worker_run_id_type_mismatch",
        expectedKind: "worker_run",
        actualKind: "worker",
      }),
    );
  });

  it("uses a stable invalid-payload error for malformed JSON values", () => {
    expect(() => deserializeWorkerId({ kind: "worker", value: "" })).toThrow(
      expect.objectContaining({ code: "channel_id_invalid" }),
    );
    expect(() => deserializeWorkerId({ kind: "unknown", value: "w" })).toThrow(
      expect.objectContaining({ code: "channel_id_invalid" }),
    );
  });

  it("exposes codec failures as a dedicated error class", () => {
    try {
      deserializeWorkerId(serializeSubmissionId(createSubmissionId("submission-a")));
      throw new Error("expected deserializeWorkerId to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ChannelIdCodecError);
    }
  });
});
