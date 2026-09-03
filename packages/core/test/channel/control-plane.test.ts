import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WorkerControlPlaneError,
  acknowledgeStop,
  abortDispatchedWorkerRun,
  closeWorkerRun,
  completeWorkerRun,
  createSubmissionId,
  createWorkerId,
  createWorkerRun,
  createWorkerRunId,
  dispatchWorkerRun,
  normalizeWorkerRunRole,
  observeWorkerRun,
  readWorkerRunState,
  recordReport,
  requestGracefulStop,
  resumeWorkerRun,
  sendWorkerInput,
  serializeSubmissionId,
  serializeWorkerRunId,
  startWorkerRun,
  transitionWorkerRun,
  verifyWorkerRunPrompt,
} from "../../src/channel/index.js";
import { setupChannelTmp, type TmpEnv } from "./setup.js";

describe("worker-run control plane", () => {
  let env: TmpEnv;
  let taskPath: string;

  beforeEach(() => {
    env = setupChannelTmp();
    taskPath = path.join(env.projectDir, ".trellis", "tasks", "task-a");
    fs.mkdirSync(taskPath, { recursive: true });
  });

  afterEach(() => {
    env.cleanup();
  });

  async function createRun() {
    return createWorkerRun({
      taskPath,
      workerRunId: createWorkerRunId("run-a"),
      workerId: createWorkerId("worker-a"),
      role: "trellis-research",
    });
  }

  it("persists a dispatched record with tagged IDs", async () => {
    const run = await createRun();

    expect(run).toMatchObject({
      workerRunId: "run-a",
      workerId: "worker-a",
      lifecycle: "dispatched",
      role: "trellis-research",
    });

    const state = await readWorkerRunState({ taskPath });
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({
      workerRunId: "run-a",
      workerId: "worker-a",
    });

    const onDisk = JSON.parse(
      fs.readFileSync(
        path.join(taskPath, "orchestration", "worker-runs.json"),
        "utf8",
      ),
    ) as {
      runs: { workerRunId: { kind: string }; workerId: { kind: string } }[];
    };
    expect(onDisk.runs[0]).toMatchObject({
      workerRunId: { kind: "worker_run" },
      workerId: { kind: "worker" },
    });
  });

  it("serializes concurrent state mutations through the task-local lock", async () => {
    await Promise.all(
      ["a", "b"].map((suffix) =>
        createWorkerRun({
          taskPath,
          workerRunId: createWorkerRunId(`run-${suffix}`),
          workerId: createWorkerId(`worker-${suffix}`),
          role: "trellis-research",
        }),
      ),
    );

    const state = await readWorkerRunState({ taskPath });
    expect(state.runs.map((run) => run.workerRunId).sort()).toEqual([
      "run-a",
      "run-b",
    ]);
    expect(fs.readdirSync(path.join(taskPath, "orchestration"))).toEqual([
      "worker-runs.json",
    ]);
  });

  it("normalizes channel and native controlled role names", () => {
    expect(normalizeWorkerRunRole("implement")).toBe("trellis-implement");
    expect(normalizeWorkerRunRole("trellis-implement")).toBe(
      "trellis-implement",
    );
    expect(normalizeWorkerRunRole("check")).toBe("trellis-check");
    expect(normalizeWorkerRunRole("trellis-check")).toBe("trellis-check");
  });

  it("dispatches an atomic UTF-8 prompt file and verifies its exact bytes", async () => {
    const prompt = [
      "`backticks` and ${value}",
      "```ts\nconst value = /[\\w-]+/;\n```",
      "中文 JSON: {\\\"shell\\\": \\\"$(echo no)\\\"}",
      "x".repeat(11_000),
    ].join("\n");
    const dispatched = await dispatchWorkerRun({
      taskPath,
      workerRunId: createWorkerRunId("run-prompt"),
      workerId: createWorkerId("research-a"),
      role: "research",
      packageId: "core-channel",
      writeScope: ["packages/core/**"],
      findingIds: ["finding-1"],
      roundId: "round-1",
      prompt,
    });

    expect(fs.readFileSync(dispatched.promptPath, "utf8")).toBe(prompt);
    expect(dispatched.promptSha256).toBe(
      createHash("sha256").update(prompt, "utf8").digest("hex"),
    );
    await expect(
      verifyWorkerRunPrompt({
        taskPath,
        workerRunId: createWorkerRunId("run-prompt"),
        promptPath: dispatched.promptPath,
        promptSha256: dispatched.promptSha256,
      }),
    ).resolves.toBe(prompt);

    fs.writeFileSync(dispatched.promptPath, `${prompt}\ntampered`, "utf8");
    await expect(
      verifyWorkerRunPrompt({
        taskPath,
        workerRunId: createWorkerRunId("run-prompt"),
        promptPath: dispatched.promptPath,
        promptSha256: dispatched.promptSha256,
      }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "worker_prompt_hash_mismatch" }),
    );
  });

  it("rejects a second active Implementer and copies all replacement handoff fields", async () => {
    await dispatchWorkerRun({
      taskPath,
      workerRunId: createWorkerRunId("run-implement-a"),
      workerId: createWorkerId("implement-a"),
      role: "implement",
      packageId: "core-channel",
      writeScope: ["packages/core/**"],
      findingIds: ["finding-1", "finding-2"],
      previousReportPath: "prior.md",
      lastEvidence: "baseline evidence",
      roundId: "round-9",
      prompt: "first",
    });

    await expect(
      dispatchWorkerRun({
        taskPath,
        workerRunId: createWorkerRunId("run-implement-b"),
        workerId: createWorkerId("implement-b"),
        role: "trellis-implement",
        packageId: "other",
        writeScope: ["other/**"],
        findingIds: [],
        roundId: "round-other",
        prompt: "second",
      }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "active_implementer_exists" }),
    );

    await expect(
      dispatchWorkerRun({
        taskPath,
        workerRunId: createWorkerRunId("run-replacement-blocked"),
        workerId: createWorkerId("research-b"),
        role: "research",
        packageId: "other",
        writeScope: ["other/**"],
        findingIds: [],
        roundId: "round-other",
        predecessorWorkerRunId: createWorkerRunId("run-implement-a"),
        prompt: "replacement",
      }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "worker_replacement_blocked" }),
    );

    await startWorkerRun({
      taskPath,
      workerRunId: createWorkerRunId("run-implement-a"),
    });
    await recordReport({
      taskPath,
      workerRunId: createWorkerRunId("run-implement-a"),
      reportPath: "report-a.md",
      lastEvidence: "terminal evidence",
    });
    await completeWorkerRun({
      taskPath,
      workerRunId: createWorkerRunId("run-implement-a"),
      outcome: "completed",
    });

    const replacement = await dispatchWorkerRun({
      taskPath,
      workerRunId: createWorkerRunId("run-implement-b"),
      workerId: createWorkerId("implement-b"),
      role: "trellis-implement",
      packageId: "ignored",
      writeScope: ["ignored/**"],
      findingIds: [],
      roundId: "ignored",
      predecessorWorkerRunId: createWorkerRunId("run-implement-a"),
      prompt: "replacement",
    });
    expect(replacement.run).toMatchObject({
      packageId: "core-channel",
      writeScope: ["packages/core/**"],
      findingIds: ["finding-1", "finding-2"],
      previousReportPath: "report-a.md",
      lastEvidence: "terminal evidence",
      roundId: "round-9",
    });
  });

  it("releases a dispatched Implementer claim after an unrecoverable launch failure", async () => {
    await dispatchWorkerRun({
      taskPath,
      workerRunId: createWorkerRunId("run-launch-failure"),
      workerId: createWorkerId("implement-a"),
      role: "implement",
      packageId: "core-channel",
      writeScope: ["packages/core/**"],
      findingIds: [],
      roundId: "round-failure",
      prompt: "will not launch",
    });
    await abortDispatchedWorkerRun({
      taskPath,
      workerRunId: createWorkerRunId("run-launch-failure"),
      reason: "supervisor fork failed",
    });

    await expect(
      dispatchWorkerRun({
        taskPath,
        workerRunId: createWorkerRunId("run-launch-retry"),
        workerId: createWorkerId("implement-b"),
        role: "trellis-implement",
        packageId: "core-channel",
        writeScope: ["packages/core/**"],
        findingIds: [],
        roundId: "round-retry",
        prompt: "retry",
      }),
    ).resolves.toMatchObject({
      run: { lifecycle: "dispatched" },
    });
  });

  it("records graceful-stop intent and requires acknowledgement before close", async () => {
    await dispatchWorkerRun({
      taskPath,
      workerRunId: createWorkerRunId("run-stop"),
      workerId: createWorkerId("research-a"),
      role: "research",
      packageId: "core-channel",
      writeScope: ["packages/core/**"],
      findingIds: [],
      roundId: "round-stop",
      prompt: "stop me",
    });
    await startWorkerRun({
      taskPath,
      workerRunId: createWorkerRunId("run-stop"),
    });
    const requested = await requestGracefulStop({
      taskPath,
      workerRunId: createWorkerRunId("run-stop"),
      reason: "explicit-kill",
    });
    expect(requested).toMatchObject({
      lifecycle: "stop_requested",
      stopReason: "explicit-kill",
      stopRequestedAt: expect.any(String),
    });

    await expect(
      closeWorkerRun({ taskPath, workerRunId: createWorkerRunId("run-stop") }),
    ).rejects.toThrow(expect.objectContaining({ code: "worker_not_terminal" }));
    await expect(
      completeWorkerRun({
        taskPath,
        workerRunId: createWorkerRunId("run-stop"),
        outcome: "cancelled",
      }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "worker_invalid_transition" }),
    );

    const acknowledged = await acknowledgeStop({
      taskPath,
      workerRunId: createWorkerRunId("run-stop"),
      outcome: "cancelled",
      reason: "worker acknowledged stop",
    });
    expect(acknowledged).toMatchObject({
      lifecycle: "cancelled",
      terminalReason: "worker acknowledged stop",
      terminalAt: expect.any(String),
    });
    await expect(
      closeWorkerRun({ taskPath, workerRunId: createWorkerRunId("run-stop") }),
    ).resolves.toMatchObject({ lifecycle: "closed" });
  });

  it("allows only acknowledgement to terminalize a stop_requested run", async () => {
    await dispatchWorkerRun({
      taskPath,
      workerRunId: createWorkerRunId("run-stop-guard"),
      workerId: createWorkerId("research-a"),
      role: "research",
      packageId: "core-channel",
      writeScope: ["packages/core/**"],
      findingIds: [],
      roundId: "round-stop-guard",
      prompt: "stop guard",
    });
    await startWorkerRun({
      taskPath,
      workerRunId: createWorkerRunId("run-stop-guard"),
    });
    const requested = await requestGracefulStop({
      taskPath,
      workerRunId: createWorkerRunId("run-stop-guard"),
      reason: "explicit-kill",
    });

    for (const options of [
      undefined,
      { operation: "start" as const },
      { operation: "report" as const },
      { operation: "complete" as const },
      { operation: "close" as const },
    ]) {
      expect(() => transitionWorkerRun(requested, "cancelled", options)).toThrow(
        expect.objectContaining({ code: "worker_invalid_transition" }),
      );
    }
    expect(
      transitionWorkerRun(requested, "cancelled", {
        operation: "acknowledge_stop",
      }),
    ).toMatchObject({ lifecycle: "cancelled" });
  });

  it("allows the lifecycle and requires a resume before completed work accepts input", async () => {
    await createRun();
    await startWorkerRun({ taskPath, workerRunId: createWorkerRunId("run-a") });
    await recordReport({
      taskPath,
      workerRunId: createWorkerRunId("run-a"),
      reportPath: "report.md",
    });
    const completed = await completeWorkerRun({
      taskPath,
      workerRunId: createWorkerRunId("run-a"),
      outcome: "completed",
      reason: "report accepted",
    });
    expect(completed).toMatchObject({
      lifecycle: "completed",
      terminalReason: "report accepted",
    });

    let delivered = false;
    await expect(
      sendWorkerInput(
        {
          taskPath,
          workerRunId: createWorkerRunId("run-a"),
          workerId: createWorkerId("worker-a"),
          text: "continue",
        },
        async () => {
          delivered = true;
        },
      ),
    ).rejects.toThrow(
      expect.objectContaining({ code: "worker_not_resumed" }),
    );
    expect(delivered).toBe(false);

    const resumed = await resumeWorkerRun({
      taskPath,
      workerRunId: createWorkerRunId("run-a"),
    });
    expect(resumed).toMatchObject({
      lifecycle: "running",
      resumedAt: expect.any(String),
    });

    await sendWorkerInput(
      {
        taskPath,
        workerRunId: createWorkerRunId("run-a"),
        workerId: createWorkerId("worker-a"),
        text: "continue",
      },
      async (input) => {
        delivered = input.text === "continue";
      },
    );
    expect(delivered).toBe(true);
  });

  it("rejects invalid direct close and restart transitions with stable errors", async () => {
    await createRun();
    await startWorkerRun({ taskPath, workerRunId: createWorkerRunId("run-a") });

    await expect(
      closeWorkerRun({ taskPath, workerRunId: createWorkerRunId("run-a") }),
    ).rejects.toThrow(expect.objectContaining({ code: "worker_not_terminal" }));

    await recordReport({ taskPath, workerRunId: createWorkerRunId("run-a") });
    await completeWorkerRun({
      taskPath,
      workerRunId: createWorkerRunId("run-a"),
      outcome: "completed",
    });

    await expect(
      startWorkerRun({ taskPath, workerRunId: createWorkerRunId("run-a") }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "worker_invalid_transition" }),
    );
  });

  it("rejects resume until a run has completed", async () => {
    await createRun();

    await expect(
      resumeWorkerRun({ taskPath, workerRunId: createWorkerRunId("run-a") }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "worker_invalid_transition" }),
    );

    const state = await readWorkerRunState({ taskPath });
    expect(state.runs[0].lifecycle).toBe("dispatched");
    expect(state.runs[0]).not.toHaveProperty("startedAt");
    expect(state.runs[0]).not.toHaveProperty("resumedAt");
  });

  it("validates every terminal branch from report_pending", async () => {
    for (const outcome of ["completed", "failed", "cancelled"] as const) {
      const scopedTaskPath = path.join(taskPath, outcome);
      fs.mkdirSync(scopedTaskPath, { recursive: true });
      await createWorkerRun({
        taskPath: scopedTaskPath,
        workerRunId: createWorkerRunId(`run-${outcome}`),
        workerId: createWorkerId(`worker-${outcome}`),
        role: "trellis-research",
      });
      await startWorkerRun({
        taskPath: scopedTaskPath,
        workerRunId: createWorkerRunId(`run-${outcome}`),
      });
      await recordReport({
        taskPath: scopedTaskPath,
        workerRunId: createWorkerRunId(`run-${outcome}`),
      });
      const terminal = await completeWorkerRun({
        taskPath: scopedTaskPath,
        workerRunId: createWorkerRunId(`run-${outcome}`),
        outcome,
      });
      expect(terminal.lifecycle).toBe(outcome);
      expect(terminal.terminalAt).toEqual(expect.any(String));

      const closed = await closeWorkerRun({
        taskPath: scopedTaskPath,
        workerRunId: createWorkerRunId(`run-${outcome}`),
      });
      expect(closed.lifecycle).toBe("closed");
    }
  });

  it("keeps lifecycle intact for wait-timeout and no-diff observations", async () => {
    await createRun();
    await startWorkerRun({ taskPath, workerRunId: createWorkerRunId("run-a") });

    const afterTimeout = await observeWorkerRun({
      taskPath,
      workerRunId: createWorkerRunId("run-a"),
      kind: "wait_timeout",
    });
    const afterNoDiff = await observeWorkerRun({
      taskPath,
      workerRunId: createWorkerRunId("run-a"),
      kind: "no_diff",
    });

    expect(afterTimeout.lifecycle).toBe("running");
    expect(afterNoDiff).toMatchObject({
      lifecycle: "running",
      observations: [{ kind: "wait_timeout" }, { kind: "no_diff" }],
    });
  });

  it("rejects a tagged submission before its input callback can run", async () => {
    await createRun();
    await startWorkerRun({ taskPath, workerRunId: createWorkerRunId("run-a") });
    let delivered = false;

    await expect(
      sendWorkerInput(
        {
          taskPath,
          workerRunId: createWorkerRunId("run-a"),
          workerId: serializeSubmissionId(createSubmissionId("submission-a")),
          text: "must not be delivered",
        },
        async () => {
          delivered = true;
        },
      ),
    ).rejects.toThrow(
      expect.objectContaining({ code: "worker_id_type_mismatch" }),
    );
    expect(delivered).toBe(false);
  });

  it("rejects a tagged worker-run ID before its input callback can run", async () => {
    await createRun();
    await startWorkerRun({ taskPath, workerRunId: createWorkerRunId("run-a") });
    let delivered = false;

    await expect(
      sendWorkerInput(
        {
          taskPath,
          workerRunId: createWorkerRunId("run-a"),
          workerId: serializeWorkerRunId(createWorkerRunId("other-run")),
          text: "must not be delivered",
        },
        async () => {
          delivered = true;
        },
      ),
    ).rejects.toThrow(
      expect.objectContaining({ code: "worker_id_type_mismatch" }),
    );
    expect(delivered).toBe(false);
  });

  it("exposes stable typed control-plane errors", () => {
    const error = new WorkerControlPlaneError("worker_not_resumed");
    expect(error).toMatchObject({
      name: "WorkerControlPlaneError",
      code: "worker_not_resumed",
    });
  });
});
