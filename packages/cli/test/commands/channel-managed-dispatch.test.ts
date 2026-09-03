import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";

import {
  createWorkerId,
  createWorkerRunId,
  dispatchWorkerRun,
  readWorkerRunState,
  serializeWorkerRunId,
  startWorkerRun,
} from "@mindfoldhq/trellis-core/channel";

import { createChannel } from "../../src/commands/channel/create.js";
import { registerChannelCommand } from "../../src/commands/channel/index.js";
import { channelKill } from "../../src/commands/channel/kill.js";
import { readChannelEvents } from "../../src/commands/channel/store/events.js";
import {
  projectKey,
  workerFile,
} from "../../src/commands/channel/store/paths.js";
import {
  resolveSupervisorSystemPrompt,
  finalizeManagedWorkerRun,
  writeSupervisorConfig,
  type ManagedSupervisorConfig,
} from "../../src/commands/channel/supervisor.js";

interface TmpEnv {
  tmpDir: string;
  projectDir: string;
  taskPath: string;
  projectKey: string;
  oldRoot: string | undefined;
  oldProject: string | undefined;
}

function setup(): TmpEnv {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-managed-test-"));
  const projectDir = path.join(tmpDir, "project");
  const taskPath = path.join(projectDir, ".trellis", "tasks", "managed-a");
  fs.mkdirSync(taskPath, { recursive: true });
  const oldRoot = process.env.TRELLIS_CHANNEL_ROOT;
  const oldProject = process.env.TRELLIS_CHANNEL_PROJECT;
  process.env.TRELLIS_CHANNEL_ROOT = path.join(tmpDir, "channels");
  delete process.env.TRELLIS_CHANNEL_PROJECT;
  return {
    tmpDir,
    projectDir,
    taskPath,
    projectKey: projectKey(projectDir),
    oldRoot,
    oldProject,
  };
}

function teardown(env: TmpEnv): void {
  if (env.oldRoot === undefined) delete process.env.TRELLIS_CHANNEL_ROOT;
  else process.env.TRELLIS_CHANNEL_ROOT = env.oldRoot;
  if (env.oldProject === undefined) delete process.env.TRELLIS_CHANNEL_PROJECT;
  else process.env.TRELLIS_CHANNEL_PROJECT = env.oldProject;
  fs.rmSync(env.tmpDir, { recursive: true, force: true });
}

describe("managed channel dispatch config", () => {
  let env: TmpEnv;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    teardown(env);
  });

  async function dispatch(prompt: string) {
    return dispatchWorkerRun({
      taskPath: env.taskPath,
      workerRunId: createWorkerRunId("run-managed-a"),
      workerId: createWorkerId("implement"),
      role: "implement",
      packageId: "core-channel",
      writeScope: ["packages/core/**"],
      findingIds: ["finding-1"],
      roundId: "round-1",
      prompt,
    });
  }

  it("keeps hostile UTF-8 prompt bytes out of config and resolves them exactly", async () => {
    const prompt = [
      "`backticks` ${value}",
      "```ts\nconst rx = /[\\w-]+/;\n```",
      "中文 {\\\"shell\\\":\\\"$(echo never)\\\"}",
      "x".repeat(11_000),
    ].join("\n");
    const dispatched = await dispatch(prompt);
    const managed: ManagedSupervisorConfig = {
      taskPath: env.taskPath,
      workerRunId: serializeWorkerRunId(dispatched.run.workerRunId),
      promptPath: dispatched.promptPath,
      promptSha256: dispatched.promptSha256,
    };

    const configPath = writeSupervisorConfig(
      "c",
      "implement",
      { provider: "claude", cwd: env.projectDir, managed },
      env.projectKey,
    );
    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(persisted).not.toHaveProperty("systemPrompt");
    expect(persisted).toMatchObject({ managed });
    await expect(
      resolveSupervisorSystemPrompt({
        provider: "claude",
        cwd: env.projectDir,
        managed,
      }),
    ).resolves.toBe(prompt);
  });

  it("exposes managed dispatch fields on trellis channel spawn", () => {
    const program = new Command();
    registerChannelCommand(program);
    const channel = program.commands.find((command) => command.name() === "channel");
    const spawn = channel?.commands.find((command) => command.name() === "spawn");
    const flags = spawn?.options.map((option) => option.long) ?? [];

    expect(flags).toEqual(
      expect.arrayContaining([
        "--task",
        "--package-id",
        "--write-scope",
        "--finding-id",
        "--round-id",
        "--predecessor-worker-run-id",
      ]),
    );
  });

  it("turns a managed normal kill into cooperative inbox stop intent", async () => {
    const dispatched = await dispatch("stop safely");
    await startWorkerRun({
      taskPath: env.taskPath,
      workerRunId: createWorkerRunId("run-managed-a"),
    });
    await createChannel("c", { by: "main", cwd: env.projectDir });
    fs.writeFileSync(
      workerFile("c", "implement", "pid", env.projectKey),
      String(process.pid),
    );
    writeSupervisorConfig(
      "c",
      "implement",
      {
        provider: "claude",
        cwd: env.projectDir,
        managed: {
          taskPath: env.taskPath,
          workerRunId: serializeWorkerRunId(dispatched.run.workerRunId),
          promptPath: dispatched.promptPath,
          promptSha256: dispatched.promptSha256,
        },
      },
      env.projectKey,
    );

    await channelKill("c", { as: "implement" });

    const state = await readWorkerRunState({ taskPath: env.taskPath });
    expect(state.runs[0]).toMatchObject({
      lifecycle: "stop_requested",
      stopReason: "explicit-kill",
    });
    const events = await readChannelEvents("c", env.projectKey);
    expect(events.at(-1)).toMatchObject({
      kind: "message",
      by: "cli:kill",
      to: "implement",
    });
  });

  it("terminalizes a managed run after confirmed dead supervisor runtime", async () => {
    const dispatched = await dispatch("recover from dead runtime");
    await startWorkerRun({
      taskPath: env.taskPath,
      workerRunId: createWorkerRunId("run-managed-a"),
    });
    await createChannel("c", { by: "main", cwd: env.projectDir });
    fs.writeFileSync(
      workerFile("c", "implement", "pid", env.projectKey),
      "999999",
    );
    writeSupervisorConfig(
      "c",
      "implement",
      {
        provider: "claude",
        cwd: env.projectDir,
        managed: {
          taskPath: env.taskPath,
          workerRunId: serializeWorkerRunId(dispatched.run.workerRunId),
          promptPath: dispatched.promptPath,
          promptSha256: dispatched.promptSha256,
        },
      },
      env.projectKey,
    );

    await channelKill("c", { as: "implement" });

    const state = await readWorkerRunState({ taskPath: env.taskPath });
    expect(state.runs[0]).toMatchObject({
      lifecycle: "failed",
      terminalReason: "confirmed dead runtime",
    });
    expect(state).not.toHaveProperty("activeImplementerWorkerRunId");
  });

  it("completes a normal managed child exit so the Implementer slot is released", async () => {
    const dispatched = await dispatch("complete after report");
    await startWorkerRun({
      taskPath: env.taskPath,
      workerRunId: createWorkerRunId("run-managed-a"),
    });
    const managed: ManagedSupervisorConfig = {
      taskPath: env.taskPath,
      workerRunId: serializeWorkerRunId(dispatched.run.workerRunId),
      promptPath: dispatched.promptPath,
      promptSha256: dispatched.promptSha256,
    };

    await finalizeManagedWorkerRun(managed, 0, null);

    const state = await readWorkerRunState({ taskPath: env.taskPath });
    expect(state.runs[0]).toMatchObject({
      lifecycle: "completed",
      reportRecordedAt: expect.any(String),
      terminalAt: expect.any(String),
    });
    expect(state).not.toHaveProperty("activeImplementerWorkerRunId");
  });
});
