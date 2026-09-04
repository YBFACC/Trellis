/**
 * Supervisor process: owns a single worker (claude or codex) and bridges
 * worker ↔ channel events.jsonl.
 *
 * Run as: `trellis channel __supervisor <channel> <worker> <config-path>`
 *
 * Three concurrent loops:
 *   1. stdout reader  — parse worker stdout → adapter → append events
 *   2. inbox watcher  — read events.jsonl for `to=<worker>` say events,
 *                       translate via adapter.encodeUserMessage → worker stdin
 *   3. signal handler — SIGTERM → close worker stdin → 3s → SIGTERM → 3s → SIGKILL
 *                       → write `killed` event → exit
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  DEFAULT_INBOX_POLICY,
  acknowledgeStop,
  abortDispatchedWorkerRun,
  completeWorkerRun,
  deserializeWorkerRunId,
  observeWorkerRun,
  readWorkerRunState,
  recordReport,
  startWorkerRun,
  verifyWorkerRunPrompt,
  type InboxPolicy,
  type SerializedWorkerRunId,
} from "@ybfacc/trellis-core/channel";

import { shouldUseSystemPromptFile } from "./adapters/claude.js";
import type { CodexSandboxMode } from "./adapters/codex.js";
import { getAdapter, type Provider } from "./adapters/index.js";
import { appendEvent } from "./store/events.js";
import { workerFile } from "./store/paths.js";
import { scheduleSupervisorIdleTimer } from "./supervisor/idle.js";
import { runInboxWatcher } from "./supervisor/inbox.js";
import { createShutdown, type ShutdownReason } from "./supervisor/shutdown.js";
import {
  createStdoutDrainControl,
  startStdoutPump,
} from "./supervisor/stdout.js";
import { TurnTracker } from "./supervisor/turns.js";
import { scheduleSupervisorTimeoutWarning } from "./supervisor/warning.js";

export interface SupervisorConfig {
  provider: Provider;
  cwd: string;
  /** Combined worker system prompt: channel protocol prefix + agent body.
   *  Injected via Claude `--append-system-prompt(-file)` or Codex
   *  `developerInstructions`. The supervisor also persists it to
   *  `<worker>.system-prompt.md` and exposes the path as
   *  `view.systemPromptFile` so adapters can avoid OS argv-length limits.
   *  No "initial user prompt" — the worker stays idle until the first
   *  inbox `send --to <worker>` arrives. */
  systemPrompt?: string;
  /** Extra env vars (TRELLIS_HOOKS=0 etc. are added automatically). */
  env?: Record<string, string>;
  /** Optional model override. */
  model?: string;
  /** Resume an existing session/thread if id is provided. */
  resume?: string;
  /** Codex-only: overrides the `thread/start` sandbox mode (default `workspace-write`). */
  sandbox?: CodexSandboxMode;
  /** Auto-kill worker after this many ms (anti-zombie). */
  timeoutMs?: number;
  /** Emit supervisor_warning this many ms before timeout. `<=0` disables it. */
  warnBeforeMs?: number;
  /**
   * OOM-guard idle-cleanup TTL in ms. When a running worker stays idle
   * for this long (no active turn), the supervisor self-terminates with
   * `killed{reason:"idle-timeout"}`. `<=0` or undefined disables.
   */
  idleTimeoutMs?: number;
  /** Caller identity recorded on the `spawned` event (default "main"). */
  spawnedBy?: string;
  /** Agent definition name loaded for this worker, if any (recorded on `spawned`). */
  agent?: string;
  /** Relative paths injected via --file / --jsonl (recorded on `spawned`). */
  contextFiles?: string[];
  /** Relative paths of every `--jsonl` manifest processed, even if empty
   *  (recorded on `spawned` for observability — "I passed --jsonl X but
   *  X contained no real entries"). */
  contextManifests?: string[];
  /** Worker inbox delivery policy (recorded on `spawned`; default
   *  `explicitOnly`). */
  inboxPolicy?: InboxPolicy;
  /** Structured, task-owned managed dispatch; legacy configs omit this. */
  managed?: ManagedSupervisorConfig;
}

export interface ManagedSupervisorConfig {
  taskPath: string;
  workerRunId: SerializedWorkerRunId;
  promptPath: string;
  promptSha256: string;
}

export interface ScheduleSupervisorTimeoutArgs {
  timeoutMs: number;
  shutdown: {
    request(signal: NodeJS.Signals, reason: "timeout"): Promise<void>;
  };
  log: { write: (data: string) => void };
  /** Managed dispatches record an observation rather than killing the worker. */
  onManagedTimeout?: () => void;
}

/** Schedule the legacy timeout kill or a managed observation, never both. */
export function scheduleSupervisorTimeout(
  args: ScheduleSupervisorTimeoutArgs,
): () => void {
  if (args.timeoutMs <= 0) return () => undefined;
  const timer = setTimeout(() => {
    if (args.onManagedTimeout) {
      args.log.write(
        `[supervisor] timeout ${args.timeoutMs}ms reached; recording managed observation\n`,
      );
      args.onManagedTimeout();
      return;
    }
    args.log.write(
      `[supervisor] timeout ${args.timeoutMs}ms reached, killing worker\n`,
    );
    void args.shutdown.request("SIGTERM", "timeout");
  }, args.timeoutMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

type Child = ChildProcessByStdio<Writable, Readable, Readable>;

const SHUTDOWN_GRACE_MS = 3000;

interface ResolvedProviderPath {
  command: string;
  prefixArgs: string[];
}

/**
 * Drain worker stdout before synthesising terminal state and removing the
 * supervisor's runtime files.
 */
export async function finalizeSupervisorExit(args: {
  stdoutDrained: Promise<void>;
  drainTimeoutMs: number;
  abortStdoutDrain: () => void;
  onDrainTimeout?: () => void;
  finalizeOnExit: () => Promise<void>;
  recordManagedExit?: () => Promise<void>;
  acknowledgeManagedStop?: () => Promise<void>;
  cleanup: () => Promise<void>;
  exit: () => void;
}): Promise<void> {
  const timer = setTimeout(() => {
    try {
      args.onDrainTimeout?.();
    } catch {
      // Logging must not prevent supervisor teardown.
    }
    try {
      args.abortStdoutDrain();
    } catch {
      // Continue teardown even if the drain abort hook fails.
    }
  }, args.drainTimeoutMs);
  await args.stdoutDrained.catch(() => undefined);
  clearTimeout(timer);
  await args.finalizeOnExit().catch(() => undefined);
  await args.recordManagedExit?.().catch(() => undefined);
  await args.acknowledgeManagedStop?.().catch(() => undefined);
  await args.cleanup().catch(() => undefined);
  args.exit();
}

/**
 * Resolve the real launch target for npm `.cmd` shims on Windows.
 *
 * @param provider CLI basename for the provider, such as `codex` or `claude`.
 * @param cwd Worker launch directory, used to check local `node_modules/.bin` first.
 * @returns Command and prefix arguments that can be passed directly to `spawn()`.
 */
export function resolveProviderPath(
  provider: string,
  cwd?: string,
): ResolvedProviderPath {
  const fallback = { command: provider, prefixArgs: [] };
  if (process.platform !== "win32") return fallback;
  try {
    const cmdName = `${provider}.cmd`;
    const dirs = [
      ...(cwd ? [path.join(cwd, "node_modules", ".bin")] : []),
      ...(process.env.PATH ?? "").split(path.delimiter),
    ].filter(Boolean);
    for (const dir of dirs) {
      const cmdFile = path.join(dir, cmdName);
      if (!fs.existsSync(cmdFile)) continue;
      const content = fs.readFileSync(cmdFile, "utf8");
      // npm-generated executable shim format: "%dp0%\node_modules\pkg\bin\name.exe" %*
      const m = content.match(/"%dp0%\\([^"]+?\.exe)"/i);
      if (m) {
        const exePath = path.join(dir, m[1]);
        if (
          path.basename(exePath).toLowerCase() !== "node.exe" &&
          fs.existsSync(exePath)
        ) {
          return { command: exePath, prefixArgs: [] };
        }
      }
      // npm-generated Node script shim format:
      // "%_prog%"  "%dp0%\node_modules\pkg\bin\name.js" %*
      const js = content.match(/"%dp0%\\([^"]+?\.(?:js|cjs|mjs))"/i);
      if (js) {
        const jsPath = path.join(dir, js[1]);
        if (fs.existsSync(jsPath)) {
          return { command: process.execPath, prefixArgs: [jsPath] };
        }
      }
    }
  } catch {
    // Resolution failures are non-fatal; fall back to the raw provider name.
  }
  return fallback;
}

/**
 * Entry point invoked by `trellis channel __supervisor <channel> <worker> <config>`.
 */
export async function runSupervisor(
  channelName: string,
  workerName: string,
  configPath: string,
): Promise<void> {
  const config = readConfig(configPath);
  const managed = config.managed;
  let systemPrompt: string;
  try {
    systemPrompt = await resolveSupervisorSystemPrompt(config);
  } catch (error) {
    if (managed !== undefined) {
      await abortDispatchedWorkerRun({
        taskPath: managed.taskPath,
        workerRunId: managed.workerRunId,
        reason: "managed prompt verification failed",
      }).catch(() => undefined);
    }
    throw error;
  }

  // Self-pid file lets `trellis channel kill` find us.
  const project = process.env.TRELLIS_CHANNEL_PROJECT;
  fs.writeFileSync(
    workerFile(channelName, workerName, "pid", project),
    String(process.pid),
  );

  // ── adapter selection ──
  const adapter = getAdapter(config.provider);
  const adapterCtx = adapter.createCtx();
  // Persist an oversized system prompt to the worker dir and hand adapters a
  // file path. Inlining a large prompt (agent body + injected --file/--jsonl
  // context) on the worker command line breaks spawn(): Windows CreateProcess
  // caps the command line at 32,767 chars and fails with a silent-to-the-user
  // ENAMETOOLONG. Prompts within the inline budget stay on the argv flag so
  // Claude Code installs older than v2.0.34 (no --append-system-prompt-file)
  // keep working exactly as before; adapters that do support a file-based
  // prompt flag (claude: --append-system-prompt-file) prefer it.
  let systemPromptFile: string | undefined = managed?.promptPath;
  if (
    systemPromptFile === undefined &&
    shouldUseSystemPromptFile(systemPrompt)
  ) {
    systemPromptFile = workerFile(
      channelName,
      workerName,
      "system-prompt.md",
      project,
    );
    fs.writeFileSync(systemPromptFile, systemPrompt);
  }
  const view = {
    resume: config.resume,
    model: config.model,
    systemPrompt,
    ...(systemPromptFile ? { systemPromptFile } : {}),
    cwd: config.cwd,
    sandbox: config.sandbox,
  };
  const args = adapter.buildArgs(view);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...config.env,
    TRELLIS_HOOKS: "0",
    TRELLIS_CHANNEL: channelName,
    TRELLIS_CHANNEL_AS: workerName,
  };

  const logPath = workerFile(channelName, workerName, "log", project);
  const log = fs.createWriteStream(logPath);
  const resolvedProvider = resolveProviderPath(adapter.provider, config.cwd);
  const resolvedProviderDisplay = [
    resolvedProvider.command,
    ...resolvedProvider.prefixArgs,
  ].join(" ");
  log.write(
    `[supervisor] starting ${adapter.provider} (resolved: ${resolvedProviderDisplay}) ${args.join(" ")}\n`,
  );

  const child = spawn(
    resolvedProvider.command,
    [...resolvedProvider.prefixArgs, ...args],
    {
      cwd: config.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  ) as Child;

  // ── shutdown controller declared before listener attachment ──
  // Node fires `error` on next tick when spawn fails (ENOENT / EACCES);
  // create the controller and attach listeners synchronously, with no
  // await between spawn() and child.on("error").
  const shutdown = createShutdown({
    channelName,
    workerName,
    log,
    getChild: () => child,
    graceMs: SHUTDOWN_GRACE_MS,
    timeoutMs: config.timeoutMs,
    ...(config.idleTimeoutMs !== undefined
      ? { idleTimeoutMs: config.idleTimeoutMs }
      : {}),
  });

  const stdoutDrain = createStdoutDrainControl();
  const idleTimerRef: {
    current?: ReturnType<typeof scheduleSupervisorIdleTimer>;
  } = {};
  const turnTracker = new TurnTracker({
    onIdleExit: () => idleTimerRef.current?.pause(),
    onIdleEnter: () => idleTimerRef.current?.reset(),
  });

  // Attach before any await. Node drains unread child stdio after `exit`, so
  // attaching only after the durable `spawned` append can silently discard a
  // fast worker's final output. Line processing stays gated until `spawned`
  // is durable, preserving event-log order.
  const stdoutDrained = startStdoutPump({
    channelName,
    workerName,
    child,
    adapter,
    adapterCtx,
    log,
    shutdown,
    turnTracker,
    processLines: stdoutDrain.processLines,
    signal: stdoutDrain.signal,
  });

  // Gate the `spawned` event behind whichever child lifecycle event fires
  // first: `spawn` (success) or `error` (launch failure, e.g. ENOENT).
  // Without this gate the post-spawn path writes `spawned` even when the
  // process never actually started — and the racing error append makes
  // `spawned` vs `error` ordering non-deterministic. Both rounds of CR
  // converged on this.
  let spawnFailed = false;
  let settleSpawn: () => void = () => undefined;
  const spawnSettled = new Promise<void>((resolve) => {
    settleSpawn = resolve;
  });

  // Attach listeners SYNCHRONOUSLY — no awaits between spawn() and these
  // lines. Node fires `error` on next tick when spawn fails (ENOENT etc.),
  // and if no listener is attached by then the supervisor dies with an
  // unhandled error and leaves a stale .pid behind.
  child.stderr.on("data", (b: Buffer) => log.write(b));
  child.once("spawn", () => {
    settleSpawn();
  });
  child.on("error", (err) => {
    // L1 fix: guard against double-fire of `error` (Node can re-emit it
    // during pipe teardown). The startup-failed path runs an IIFE that
    // owns process.exit; subsequent fires must be no-ops or we'd queue
    // duplicate error events.
    if (spawnFailed) return;
    log.write(`[supervisor] worker error: ${err.message}\n`);
    if (!child.pid) {
      // Pre-spawn failure (ENOENT / EACCES): emit ONE `error` event,
      // skip the misleading `spawned{pid:undefined}`, clean up, and exit
      // so the supervisor doesn't linger as a zombie waiting for an
      // `exit` event that Node won't deliver.
      spawnFailed = true;
      settleSpawn();
      stdoutDrain.discard();
      void (async () => {
        try {
          await appendEvent(
            channelName,
            {
              kind: "error",
              by: `supervisor:${workerName}`,
              message: `worker spawn failed: ${err.message}`,
              provider: config.provider,
            },
            project,
          );
        } catch {
          // ignore — we're exiting anyway
        }
        if (managed !== undefined) {
          await abortDispatchedWorkerRun({
            taskPath: managed.taskPath,
            workerRunId: managed.workerRunId,
            reason: `provider launch failed: ${err.message}`,
          }).catch(() => undefined);
        }
        await cleanup(channelName, workerName).catch(() => undefined);
        process.exit(1);
      })();
      return;
    }
    // Post-spawn error (worker already running). Claude M2 fix: await
    // the `error` append BEFORE requesting shutdown so `killed` can't
    // land first in events.jsonl.
    //
    // Sync-claim the shutdown reason FIRST so other code paths (e.g.
    // the `await spawnSettled` re-check, future inbox-handler probes)
    // observe `isShuttingDown=true` immediately, before the IIFE
    // suspends on its first await.
    shutdown.claim("crash");
    void (async () => {
      try {
        await appendEvent(
          channelName,
          {
            kind: "error",
            by: `supervisor:${workerName}`,
            message: `worker process error: ${err.message}`,
            provider: config.provider,
          },
          project,
        );
      } catch {
        // ignore
      }
      await shutdown.request("SIGTERM", "crash");
    })();
  });
  child.on("exit", (code, sig) => {
    // Codex #1 + #2 fix: synthesise a fallback terminal event when the
    // adapter never produced one (otherwise `wait --kind done` hangs),
    // and await any in-flight `killed` append from a concurrent shutdown
    // before exiting so the event doesn't race the process death.
    void finalizeSupervisorExit({
      stdoutDrained,
      drainTimeoutMs: SHUTDOWN_GRACE_MS,
      abortStdoutDrain: stdoutDrain.abortReading,
      onDrainTimeout: () =>
        log.write(
          `[supervisor] stdout did not close within ${SHUTDOWN_GRACE_MS}ms; draining buffered lines and exiting\n`,
        ),
      finalizeOnExit: () => shutdown.finalizeOnExit(code, sig),
      ...(managed !== undefined
        ? {
            recordManagedExit: async () => {
              await finalizeManagedWorkerRun(managed, code, sig);
            },
          }
        : {}),
      ...(managed !== undefined
        ? {
            acknowledgeManagedStop: async () => {
              await acknowledgeManagedStopIfRequested(managed);
            },
          }
        : {}),
      cleanup: () => cleanup(channelName, workerName),
      exit: () => process.exit(0),
    });
  });

  // Signal handlers MUST be registered before any await so a SIGTERM
  // arriving during the spawn-settle / spawned-append window funnels
  // into `shutdown.request` instead of using Node's default behaviour
  // (which would orphan the child and skip the `killed` event).
  process.on("SIGTERM", () => {
    void shutdown.request(
      "SIGTERM",
      readExternalShutdownReason(channelName, workerName, project),
    );
  });
  process.on("SIGINT", () => void shutdown.request("SIGINT", "explicit-kill"));
  // SIGHUP arrives when the parent terminal closes — without this
  // handler Node's default behaviour exits the supervisor before the
  // killed-append lands.
  process.on("SIGHUP", () => void shutdown.request("SIGHUP", "explicit-kill"));

  // Wait until either `spawn` or pre-spawn `error` fires before writing
  // the `spawned` event. The error handler exits the process directly,
  // so reaching this point with `spawnFailed=true` means we already kicked
  // off cleanup and can bail cleanly.
  await spawnSettled;
  if (spawnFailed) {
    stdoutDrain.discard();
    return;
  }
  // Codex #3 fix: if a signal/timeout requested shutdown while we were
  // waiting for spawn-settled, don't write a misleading `spawned` event;
  // let the in-flight `killed` append complete and bail.
  if (shutdown.isShuttingDown()) {
    stdoutDrain.discard();
    await shutdown.awaitFinalize();
    return;
  }

  try {
    fs.writeFileSync(
      workerFile(channelName, workerName, "worker-pid", project),
      String(child.pid),
    );

    await appendEvent(
      channelName,
      {
        kind: "spawned",
        by: config.spawnedBy ?? "main",
        as: workerName,
        provider: config.provider,
        pid: child.pid,
        inboxPolicy: config.inboxPolicy ?? DEFAULT_INBOX_POLICY,
        ...(config.agent ? { agent: config.agent } : {}),
        ...(config.contextFiles && config.contextFiles.length > 0
          ? { files: config.contextFiles }
          : {}),
        ...(config.contextManifests && config.contextManifests.length > 0
          ? { manifests: config.contextManifests }
          : {}),
      },
      project,
    );
    if (managed !== undefined) {
      await startWorkerRun({
        taskPath: managed.taskPath,
        workerRunId: managed.workerRunId,
      });
    }
  } catch (err) {
    stdoutDrain.discard();
    if (managed !== undefined) {
      await abortDispatchedWorkerRun({
        taskPath: managed.taskPath,
        workerRunId: managed.workerRunId,
        reason: "failed to mark durable supervisor spawn",
      }).catch(() => undefined);
    }
    throw err;
  }

  // OOM-guard idle timer: start only after `spawned` is durable. Hooks
  // wired through the TurnTracker pause it mid-turn and reset it on
  // turn finish / interrupted (the same transitions that drive durable
  // `idleSince`). `<=0` short-circuits the timer to a no-op.
  idleTimerRef.current = scheduleSupervisorIdleTimer({
    idleTimeoutMs: config.idleTimeoutMs ?? 0,
    shutdown,
    isChildExited: () => child.exitCode !== null || child.signalCode !== null,
    log,
    ...(managed !== undefined
      ? {
          onIdleTimeout: () => {
            void observeManagedWorkerRun(
              managed,
              "silent",
              {
                reason: "idle-timeout",
                idleTimeoutMs: config.idleTimeoutMs ?? 0,
              },
              log,
            );
          },
        }
      : {}),
  });
  process.on("exit", () => idleTimerRef.current?.cancel());
  stdoutDrain.allowProcessing();

  // ── timeout guard (anti-zombie) ──
  if (config.timeoutMs && config.timeoutMs > 0) {
    const cancelTimeout = scheduleSupervisorTimeout({
      timeoutMs: config.timeoutMs,
      shutdown,
      log,
      ...(managed !== undefined
        ? {
            onManagedTimeout: () => {
              void observeManagedWorkerRun(
                managed,
                "wait_timeout",
                {
                  reason: "timeout",
                  timeoutMs: config.timeoutMs,
                },
                log,
              );
            },
          }
        : {}),
    });
    process.on("exit", cancelTimeout);

    // Fire-and-forget pre-timeout observability warning. One-shot, guarded
    // by shutdown/terminal/exit state so it stays quiet once the worker is
    // already on its way out.
    scheduleSupervisorTimeoutWarning({
      channelName,
      workerName,
      timeoutMs: config.timeoutMs,
      warnBeforeMs: config.warnBeforeMs,
      shutdown,
      isChildExited: () => child.exitCode !== null || child.signalCode !== null,
      log,
      project,
    });
  }

  // ── 3. inbox watcher ──
  // Start BEFORE adapter.handshake() so messages arriving during the
  // handshake window are captured. The adapter's `isReady()` is checked
  // inside runInboxWatcher; codex blocks there until thread/start lands.
  const abort = new AbortController();
  process.on("exit", () => abort.abort());
  void runInboxWatcher({
    channelName,
    workerName,
    adapter,
    ctx: adapterCtx,
    child,
    signal: abort.signal,
    inboxPolicy: config.inboxPolicy ?? DEFAULT_INBOX_POLICY,
    turnTracker,
  });

  // ── adapter handshake (no initial user prompt) ──
  if (adapter.handshake) {
    try {
      await adapter.handshake({ child, ctx: adapterCtx, view });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.write(`[supervisor] adapter handshake failed: ${msg}\n`);
      // Codex #4 fix: emit an `error` event with the handshake message
      // BEFORE requesting shutdown — otherwise the channel only sees a
      // `killed{reason:"crash"}` with no detail on what went wrong.
      void (async () => {
        try {
          await appendEvent(
            channelName,
            {
              kind: "error",
              by: `supervisor:${workerName}`,
              message: `handshake failed: ${msg}`,
              provider: config.provider,
              detail: { source: "handshake" },
            },
            project,
          );
        } catch {
          // ignore
        }
        await shutdown.request("SIGTERM", "crash");
      })();
    }
  }
}

async function cleanup(channelName: string, workerName: string): Promise<void> {
  // Remove ephemeral runtime files. Keep `log` (forensic), `session-id` /
  // `thread-id` (future resume). The .spawnlock should already be gone
  // because `withLock` released it; we delete it defensively in case the
  // CLI crashed mid-spawn and left a stale one.
  // Keep `log` (forensic), `session-id` / `thread-id` (future resume).
  // `inbox-cursor` is kept so a respawn (same worker name without
  // killing the channel) doesn't replay messages.
  // `system-prompt.md` may carry a large injected context; a respawn rewrites
  // it from config when needed, so it is removed unconditionally (also when
  // the current run inlined the prompt and would otherwise leave a stale one).
  for (const suffix of [
    "pid",
    "worker-pid",
    "config",
    "system-prompt.md",
    "spawnlock",
    "shutdown-reason",
    "reservation",
  ]) {
    try {
      fs.unlinkSync(
        workerFile(
          channelName,
          workerName,
          suffix,
          process.env.TRELLIS_CHANNEL_PROJECT,
        ),
      );
    } catch {
      // already gone
    }
  }
}

function readExternalShutdownReason(
  channelName: string,
  workerName: string,
  project?: string,
): ShutdownReason {
  const file = workerFile(channelName, workerName, "shutdown-reason", project);
  try {
    const reason = fs.readFileSync(file, "utf-8").trim();
    fs.unlinkSync(file);
    if (reason === "idle-timeout") return "idle-timeout";
  } catch {
    // No sidecar: ordinary external SIGTERM remains an explicit kill.
  }
  return "explicit-kill";
}

function readConfig(p: string): SupervisorConfig {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as SupervisorConfig;
}

// Helper to write a fresh config file before forking the supervisor.
export function writeSupervisorConfig(
  channelName: string,
  workerName: string,
  config: SupervisorConfig,
  project?: string,
): string {
  const p = workerFile(channelName, workerName, "config", project);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tempPath = path.join(
    path.dirname(p),
    `.${path.basename(p)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    fs.renameSync(tempPath, p);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // no temp file to clean up
    }
    throw error;
  }
  return p;
}

/** Resolve the prompt without interpreting it as executable source. */
export async function resolveSupervisorSystemPrompt(
  config: SupervisorConfig,
): Promise<string> {
  if (config.managed !== undefined) {
    return verifyWorkerRunPrompt({
      taskPath: config.managed.taskPath,
      workerRunId: config.managed.workerRunId,
      promptPath: config.managed.promptPath,
      promptSha256: config.managed.promptSha256,
    });
  }
  if (config.systemPrompt === undefined) {
    throw new Error("Supervisor config is missing systemPrompt");
  }
  return config.systemPrompt;
}

async function observeManagedWorkerRun(
  managed: ManagedSupervisorConfig,
  kind: "silent" | "wait_timeout",
  detail: Record<string, unknown>,
  log: { write: (data: string) => void },
): Promise<void> {
  try {
    await observeWorkerRun({
      taskPath: managed.taskPath,
      workerRunId: managed.workerRunId,
      kind,
      detail,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.write(`[supervisor] managed observation failed: ${message}\n`);
  }
}

async function acknowledgeManagedStopIfRequested(
  managed: ManagedSupervisorConfig,
): Promise<void> {
  const workerRunId = deserializeWorkerRunId(managed.workerRunId);
  const state = await readWorkerRunState({ taskPath: managed.taskPath });
  const run = state.runs.find(
    (candidate) => candidate.workerRunId === workerRunId,
  );
  if (run?.lifecycle !== "stop_requested") return;
  await acknowledgeStop({
    taskPath: managed.taskPath,
    workerRunId,
    outcome: "cancelled",
    reason: "supervisor exited after graceful stop",
  });
}

/**
 * Map a managed child terminal exit into the durable control-plane lifecycle.
 * Cooperative stops are acknowledged separately so they can retain their stop
 * reason; a normal successful process exit is the terminal report
 * acknowledgement for this channel-managed dispatch.
 */
export async function finalizeManagedWorkerRun(
  managed: ManagedSupervisorConfig,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  const workerRunId = deserializeWorkerRunId(managed.workerRunId);
  const state = await readWorkerRunState({ taskPath: managed.taskPath });
  const run = state.runs.find(
    (candidate) => candidate.workerRunId === workerRunId,
  );
  if (run === undefined || run.lifecycle === "stop_requested") return;
  if (code === 0) {
    if (run.lifecycle === "running") {
      await recordReport({ taskPath: managed.taskPath, workerRunId });
    }
    if (run.lifecycle === "running" || run.lifecycle === "report_pending") {
      await completeWorkerRun({
        taskPath: managed.taskPath,
        workerRunId,
        outcome: "completed",
        reason: "worker exited after report acknowledgement",
      });
    }
    return;
  }
  if (run.lifecycle === "running" || run.lifecycle === "report_pending") {
    await completeWorkerRun({
      taskPath: managed.taskPath,
      workerRunId,
      outcome: "failed",
      reason: `worker exited with code=${code ?? "null"} signal=${signal ?? "null"}`,
    });
  }
}
