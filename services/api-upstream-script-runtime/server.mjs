import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const bind = process.env.SCRIPT_RUNTIME_BIND || ":8090";
const listenTarget = bind.startsWith(":") ? Number(bind.slice(1)) : bind;
const workerCount = boundedInt("API_UPSTREAM_SCRIPT_WORKER_COUNT", 1, 8, 1);
const memoryLimitBytes = boundedInt("API_UPSTREAM_SCRIPT_MEMORY_LIMIT_MB", 16, 128, 32) * 1024 * 1024;
const stackLimitBytes = boundedInt("API_UPSTREAM_SCRIPT_STACK_LIMIT_KB", 256, 2048, 512) * 1024;
const maxBodyBytes = 4 * 1024 * 1024;
const authToken = process.env.SCRIPT_RUNTIME_TOKEN || "";
const maxScriptCharacters = 32_768;
const maxSerializedBytes = 2 * 1024 * 1024;
const maxDepth = 16;
const maxNodes = 10_000;
const scriptTimeoutMs = 50;
const workerWallTimeoutMs = 500;
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
  return { script: payload.script.trim(), operation: payload.operation, stage: payload.stage, inputJson, contextJson };
}

class RuntimePool {
  constructor() {
    this.slots = [];
    this.queue = [];
    this.closed = false;
    this.workerPath = null;
  }

  async start() {
    this.workerPath = resolve(fileURLToPath(new URL(".", import.meta.url)), "worker.mjs");
    await Promise.all(Array.from({ length: workerCount }, async () => {
      const worker = new Worker(this.workerPath);
      const slot = { worker, ready: false, busy: false, pending: null };
      this.slots.push(slot);
      await this.initializeWorker(slot, worker);
    }));
  }

  async initializeWorker(slot, worker) {
    await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error("script worker startup timeout")), 10_000);
      worker.once("message", (message) => {
        if (message?.type !== "ready") return rejectReady(new Error("invalid script worker handshake"));
        clearTimeout(timer);
        slot.ready = true;
        resolveReady();
      });
      worker.once("error", (error) => { clearTimeout(timer); rejectReady(error); });
    });
    worker.on("message", (message) => this.finish(slot, message));
    worker.on("error", (error) => this.fail(slot, error));
    worker.on("exit", (code) => {
      if (!this.closed && code !== 0) {
        this.fail(slot, new Error("script worker exited"));
        void this.replaceWorker(slot);
      }
    });
  }

  async replaceWorker(slot) {
    if (this.closed || slot.restarting) return;
    slot.restarting = true;
    slot.ready = false;
    try {
      const worker = new Worker(this.workerPath);
      slot.worker = worker;
      await this.initializeWorker(slot, worker);
      slot.restarting = false;
      this.dispatch();
    } catch {
      slot.restarting = false;
      if (!this.closed) setTimeout(() => void this.replaceWorker(slot), 100);
    }
  }

  execute(job) {
    if (this.closed) return Promise.reject(new Error("script runtime is closed"));
    return new Promise((resolveJob, rejectJob) => {
      this.queue.push({ job, resolve: resolveJob, reject: rejectJob });
      this.dispatch();
    });
  }

  dispatch() {
    for (const slot of this.slots) {
      if (!slot.ready || slot.busy || !this.queue.length) continue;
      const queued = this.queue.shift();
      slot.busy = true;
      slot.pending = queued;
      slot.timer = setTimeout(() => {
        this.fail(slot, new Error("script execution timeout"));
        void slot.worker.terminate();
      }, workerWallTimeoutMs);
      slot.worker.postMessage({
        type: "job", id: randomUUID(), kind: "execute", script: queued.job.script,
        inputJson: queued.job.inputJson, contextJson: queued.job.contextJson,
        timeoutMs: scriptTimeoutMs, memoryLimitBytes, stackLimitBytes,
        maxScriptCharacters, maxSerializedBytes,
      });
    }
  }

  finish(slot, message) {
    if (!slot.pending || message?.type !== "result") return;
    clearTimeout(slot.timer);
    const pending = slot.pending;
    slot.pending = null;
    slot.busy = false;
    if (message.ok && typeof message.outputJson === "string") {
      try {
        const output = JSON.parse(message.outputJson);
        safeTree(output);
        pending.resolve(output);
      } catch (error) { pending.reject(error); }
    } else {
      pending.reject(new Error(message.code || "script execution failed"));
    }
    this.dispatch();
  }

  fail(slot, error) {
    if (!slot.pending) return;
    clearTimeout(slot.timer);
    const pending = slot.pending;
    slot.pending = null;
    slot.busy = false;
    pending.reject(error);
    this.dispatch();
  }

  async close() {
    this.closed = true;
    for (const slot of this.slots) await slot.worker.terminate();
  }
}

const pool = new RuntimePool();
await pool.start();

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

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    return writeJson(response, 200, { status: "ok", service: "api-upstream-script-runtime", workers: workerCount });
  }
  if (request.method !== "POST" || request.url !== "/v1/execute") {
    return writeJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
  }
  if (authToken && request.headers.authorization !== `Bearer ${authToken}`) {
    return writeJson(response, 401, { error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
  }
  try {
    const payload = parseRequest(await readJson(request));
    const output = payload.script ? await pool.execute(payload) : payload.input;
    return writeJson(response, 200, { data: { output } });
  } catch (_error) {
    return writeJson(response, 422, { error: { code: "SCRIPT_EXECUTION_FAILED", message: "Script execution failed" } });
  }
});

server.listen(listenTarget, () => console.log(`api upstream script runtime listening on ${bind}`));
const shutdown = async () => { server.close(); await pool.close(); process.exit(0); };
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
