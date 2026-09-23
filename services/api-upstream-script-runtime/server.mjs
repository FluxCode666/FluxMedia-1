import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimePool, RuntimePoolError } from "./pool.mjs";

const workerCount = boundedInt("API_UPSTREAM_SCRIPT_WORKER_COUNT", 1, 8, 1);
const memoryLimitBytes = boundedInt("API_UPSTREAM_SCRIPT_MEMORY_LIMIT_MB", 16, 128, 32) * 1024 * 1024;
const stackLimitBytes = boundedInt("API_UPSTREAM_SCRIPT_STACK_LIMIT_KB", 256, 2048, 512) * 1024;
const maxBodyBytes = 4 * 1024 * 1024;
const authToken = process.env.SCRIPT_RUNTIME_TOKEN || "";
const maxScriptCharacters = 32_768;
const maxSerializedBytes = 2 * 1024 * 1024;
const maxDepth = 16;
const maxNodes = 10_000;
const operations = new Set([
  "images.generate",
  "images.generate.query",
  "images.edit",
  "images.edit.query",
  "videos.generate",
  "videos.query",
]);
const stages = new Set(["request", "response"]);

function boundedInt(name, min, max, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

export function resolveListenTarget(environment = process.env) {
  const bind = (environment.SCRIPT_RUNTIME_BIND || ":8090").trim();
  const host = environment.SCRIPT_RUNTIME_HOST?.trim() || undefined;
  if (bind.startsWith(":")) {
    const rawPort = bind.slice(1);
    if (!/^[0-9]+$/.test(rawPort)) {
      throw new Error("SCRIPT_RUNTIME_BIND must contain a valid port");
    }
    const port = Number(rawPort);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error("SCRIPT_RUNTIME_BIND must contain a valid port");
    }
    return {
      options: host ? { port, host } : { port },
      display: host ? `${host}:${port}` : bind,
    };
  }
  if (host) {
    throw new Error("SCRIPT_RUNTIME_HOST requires a :port SCRIPT_RUNTIME_BIND");
  }
  return { options: { path: bind }, display: bind };
}

function safeTree(value) {
  const seen = new WeakSet();
  let nodes = 0;
  const visit = (current, depth) => {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) throw new Error("JSON resource limit exceeded");
    if (!current || typeof current !== "object") return;
    if (seen.has(current)) throw new Error("JSON cycles are not supported");
    seen.add(current);
    for (const [key, child] of Object.entries(current)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new Error("unsafe JSON key");
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

function parseRequest(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("request must be an object");
  if (typeof payload.script !== "string" || payload.script.length > maxScriptCharacters) throw new Error("script is invalid");
  if (typeof payload.operation !== "string" || !operations.has(payload.operation)) throw new Error("operation is invalid");
  if (typeof payload.stage !== "string" || !stages.has(payload.stage)) throw new Error("stage is invalid");
  if (!("input" in payload) || !("context" in payload)) throw new Error("input and context are required");
  safeTree(payload.input);
  safeTree(payload.context);
  const inputJson = JSON.stringify(payload.input);
  const contextJson = JSON.stringify(payload.context);
  if (Buffer.byteLength(inputJson) > maxSerializedBytes || Buffer.byteLength(contextJson) > maxSerializedBytes) {
    throw new Error("JSON resource limit exceeded");
  }
  if (payload.validateOnly !== undefined && typeof payload.validateOnly !== "boolean") throw new Error("validateOnly must be a boolean");
  if (payload.responsePermitId !== undefined && (typeof payload.responsePermitId !== "string" || !/^[a-f0-9-]{36}$/.test(payload.responsePermitId))) throw new Error("response permit is invalid");
  return { responsePermitId: payload.responsePermitId, kind: payload.validateOnly === true ? "validate" : "execute", script: payload.script.trim(), operation: payload.operation, stage: payload.stage, inputJson, contextJson };
}

function writeJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Dependency injection keeps HTTP tests on the same authentication/dispatch
// path while allowing deterministic worker fault and queue tests.
export function createRuntimeServer(pool, token = authToken) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      const snapshot = pool.diagnostics();
      const healthy = snapshot.lifecycle === "ready" && snapshot.liveWorkerCount > 0;
      return writeJson(response, healthy ? 200 : 503, {
        status: healthy ? "ok" : "unavailable",
        service: "api-upstream-script-runtime", workers: snapshot.liveWorkerCount,
      });
    }
    if (token && request.headers.authorization !== `Bearer ${token}`) {
      return writeJson(response, 401, { error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
    }
    if (request.method === "GET" && request.url === "/v1/diagnostics") {
      return writeJson(response, 200, { data: pool.diagnostics() });
    }
    const release = /^\/v1\/response-permits\/([a-f0-9-]{36})$/.exec(request.url ?? "");
    if (request.method === "DELETE" && release) {
      pool.releaseResponse(release[1]);
      response.writeHead(204, { "Cache-Control": "no-store" });
      return response.end();
    }
    const controller = new AbortController();
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    try {
      if (request.method === "POST" && request.url === "/v1/response-permits") {
        const id = await pool.reserveResponse(controller.signal);
        if (controller.signal.aborted) { pool.releaseResponse(id); return; }
        // If the connection is lost before the ID reaches Go, reclaim it now;
        // the TTL also covers a Go process that dies after receiving the ID.
        response.once("close", () => { if (!response.writableFinished) pool.releaseResponse(id); });
        return writeJson(response, 200, { data: { id } });
      }
      if (request.method !== "POST" || request.url !== "/v1/execute") {
        return writeJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
      }
      const payload = parseRequest(await readJson(request));
      if (!payload.script) payload.script = "return input;";
      const output = await pool.execute(payload, controller.signal);
      safeTree(output);
      return writeJson(response, 200, { data: { output } });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof RuntimePoolError && ["runtime_saturated", "runtime_closed"].includes(error.code)) {
        response.setHeader("Retry-After", "1");
        return writeJson(response, 503, { error: { code: "SCRIPT_RUNTIME_UNAVAILABLE", message: "Script runtime temporarily unavailable" } });
      }
      if (error instanceof RuntimePoolError && error.code === "invalid_response_permit") {
        return writeJson(response, 409, { error: { code: "INVALID_RESPONSE_PERMIT", message: "Response permit is invalid or expired" } });
      }
      return writeJson(response, 422, { error: { code: "SCRIPT_EXECUTION_FAILED", message: "Script execution failed" } });
    }
  });
}

function closeHttpServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

export async function shutdownRuntime(server, pool) {
  const errors = [];
  try {
    await closeHttpServer(server);
  } catch (error) {
    errors.push(error);
  }
  try {
    await pool.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "script runtime shutdown failed");
  }
}

export function registerRuntimeShutdown(
  server,
  pool,
  {
    signalSource = process,
    logger = console,
    setExitCode = (code) => { process.exitCode = code; },
  } = {}
) {
  let shutdownPromise;
  const shutdown = () => {
    if (!shutdownPromise) {
      shutdownPromise = shutdownRuntime(server, pool).catch(() => {
        logger.error?.("api upstream script runtime shutdown failed");
        setExitCode(1);
      });
    }
    return shutdownPromise;
  };
  signalSource.once("SIGTERM", () => { void shutdown(); });
  signalSource.once("SIGINT", () => { void shutdown(); });
  return shutdown;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = new RuntimePool({ workerCount, memoryLimitBytes, stackLimitBytes });
  await pool.start();
  const server = createRuntimeServer(pool);
  const listenTarget = resolveListenTarget();
  server.listen(listenTarget.options, () => console.log(`api upstream script runtime listening on ${listenTarget.display}`));
  registerRuntimeShutdown(server, pool);
}
