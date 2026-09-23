import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultShutdownTimeoutMs = 40_000;
const internalRuntimeBaseEnvironmentKeys = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "NODE_OPTIONS",
  "PATH",
  "TMPDIR",
  "TZ",
]);
const scriptRuntimeEnvironmentKeys = Object.freeze([
  ...internalRuntimeBaseEnvironmentKeys,
  "API_UPSTREAM_SCRIPT_MEMORY_LIMIT_MB",
  "API_UPSTREAM_SCRIPT_STACK_LIMIT_KB",
  "API_UPSTREAM_SCRIPT_WORKER_COUNT",
  "SCRIPT_RUNTIME_BIND",
  "SCRIPT_RUNTIME_HOST",
  "SCRIPT_RUNTIME_TOKEN",
]);
const mediaRuntimeEnvironmentKeys = Object.freeze([
  ...internalRuntimeBaseEnvironmentKeys,
  "ISNET_MODEL_PATH",
  "MEDIA_PROCESSING_HOST",
  "MEDIA_PROCESSING_MODELS_PATH",
  "MEDIA_PROCESSING_PORT",
  "MEDIA_PROCESSING_TOKEN",
  "REALESR_MODEL_PATH",
  "SCUNET_MODEL_PATH",
  "UV_THREADPOOL_SIZE",
]);
const privateRuntimeEnvironmentAliases = Object.freeze({
  SCRIPT_RUNTIME_TOKEN: "GO_SCRIPT_RUNTIME_TOKEN",
  MEDIA_PROCESSING_TOKEN: "GO_MEDIA_PROCESSING_TOKEN",
});

function positiveInteger(value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (!/^[0-9]+$/.test(String(value))) {
    throw new Error("UNIFIED_SHUTDOWN_TIMEOUT_MS must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("UNIFIED_SHUTDOWN_TIMEOUT_MS must be a positive integer");
  }
  return parsed;
}

export function defaultProcessSpecs(environment = process.env) {
  const appRoot = environment.FLUXMEDIA_APP_ROOT || "/app";
  const node = environment.UNIFIED_NODE_EXECUTABLE || process.execPath;
  return [
    {
      name: "backend",
      command: environment.GO_BACKEND_EXECUTABLE || "/backend",
      args: [],
      cwd: appRoot,
    },
    {
      name: "web",
      command: node,
      args: [environment.UNIFIED_WEB_ENTRYPOINT || `${appRoot}/apps/web/server.js`],
      cwd: appRoot,
    },
    {
      name: "script-runtime",
      command: node,
      args: [
        environment.UNIFIED_SCRIPT_RUNTIME_ENTRYPOINT ||
          `${appRoot}/services/api-upstream-script-runtime/server.mjs`,
      ],
      cwd: appRoot,
      environmentKeys: scriptRuntimeEnvironmentKeys,
    },
    {
      name: "media-processing",
      command: node,
      args: [
        environment.UNIFIED_MEDIA_PROCESSING_ENTRYPOINT ||
          `${appRoot}/services/media-processing-runtime/server.mjs`,
      ],
      cwd: appRoot,
      environmentKeys: mediaRuntimeEnvironmentKeys,
    },
  ];
}

function childEnvironment(spec, environment) {
  if (!spec.environmentKeys) {
    return { ...environment, ...(spec.env ?? {}) };
  }
  const selected = {};
  for (const key of spec.environmentKeys) {
    const sourceKey = Object.hasOwn(environment, key)
      ? key
      : privateRuntimeEnvironmentAliases[key];
    if (sourceKey && Object.hasOwn(environment, sourceKey)) {
      selected[key] = environment[sourceKey];
    }
  }
  return { ...selected, ...(spec.env ?? {}) };
}

function processIsRunning(child, state) {
  return !state.closed && child.exitCode === null && child.signalCode === null;
}

/**
 * Supervise the four application processes as direct children. Process specs
 * and lifecycle dependencies are injectable so signal and failure semantics
 * can be tested without starting the production services.
 */
export function runSupervisor(
  specs = defaultProcessSpecs(),
  {
    spawnProcess = spawn,
    signalSource = process,
    shutdownTimeoutMs = positiveInteger(
      process.env.UNIFIED_SHUTDOWN_TIMEOUT_MS,
      defaultShutdownTimeoutMs
    ),
    logger = console,
    environment = process.env,
  } = {}
) {
  if (!Array.isArray(specs) || specs.length === 0) {
    return Promise.resolve(1);
  }

  return new Promise((resolve) => {
    const states = [];
    let shutdownStarted = false;
    let failed = false;
    let forced = false;
    let settled = false;
    let shutdownTimer;

    const cleanupSignalListeners = () => {
      signalSource.removeListener("SIGTERM", onSigterm);
      signalSource.removeListener("SIGINT", onSigint);
    };

    const finishIfClosed = () => {
      if (!shutdownStarted || states.some((state) => !state.closed)) return;
      if (settled) return;
      settled = true;
      if (shutdownTimer) clearTimeout(shutdownTimer);
      cleanupSignalListeners();
      resolve(failed || forced ? 1 : 0);
    };

    const signalRunningChildren = (signal) => {
      for (const state of states) {
        if (!processIsRunning(state.child, state)) continue;
        try {
          state.child.kill(signal);
        } catch {
          failed = true;
        }
      }
    };

    const beginShutdown = (signal, isFailure) => {
      if (isFailure) failed = true;
      if (shutdownStarted) return;
      shutdownStarted = true;
      signalRunningChildren(signal);
      finishIfClosed();
      if (settled) return;
      shutdownTimer = setTimeout(() => {
        forced = true;
        // A child that ignores SIGTERM can also leave its close event delayed
        // (or be reparented while the namespace is shutting down). Once the
        // hard kill has been issued, the supervisor must not hold the release
        // gate open waiting for an event that cannot affect the outcome.
        for (const state of states) {
          if (state.closed) continue;
          try {
            if (
              state.child.exitCode === null &&
              state.child.signalCode === null
            ) {
              state.child.kill("SIGKILL");
            }
          } catch {
            // The result is already a failure. Continue reaping other children.
          }
          state.closed = true;
        }
        finishIfClosed();
      }, shutdownTimeoutMs);
    };

    const onSigterm = () => beginShutdown("SIGTERM", false);
    const onSigint = () => beginShutdown("SIGINT", false);
    signalSource.once("SIGTERM", onSigterm);
    signalSource.once("SIGINT", onSigint);

    for (const spec of specs) {
      if (shutdownStarted) break;
      let child;
      try {
        child = spawnProcess(spec.command, spec.args ?? [], {
          cwd: spec.cwd,
          env: childEnvironment(spec, environment),
          stdio: spec.stdio ?? "inherit",
          shell: false,
        });
      } catch (error) {
        logger.error?.(`failed to start ${spec.name}`);
        beginShutdown("SIGTERM", true);
        break;
      }

      const state = { child, closed: false, name: spec.name };
      states.push(state);
      child.once("error", () => {
        logger.error?.(`${spec.name} process error`);
        beginShutdown("SIGTERM", true);
      });
      child.once("close", (code, signal) => {
        state.closed = true;
        if (!shutdownStarted) {
          logger.error?.(
            `${spec.name} exited prematurely (code=${String(code)}, signal=${String(signal)})`
          );
          beginShutdown("SIGTERM", true);
        }
        finishIfClosed();
      });
    }

    if (shutdownStarted && states.length === 0) {
      finishIfClosed();
    }
  });
}

async function main() {
  const exitCode = await runSupervisor();
  process.exitCode = exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
