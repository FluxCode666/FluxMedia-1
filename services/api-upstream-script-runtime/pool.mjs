import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

export class RuntimePoolError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Only counters and lifecycle leave this pool. Scripts, task IDs, bodies and
// provider headers never participate in its public diagnostics.
export class RuntimePool {
  constructor({ workerCount, memoryLimitBytes, stackLimitBytes, workerPath = new URL("./worker.mjs", import.meta.url), permitTTL = 30 * 60_000 }) {
    Object.assign(this, { workerCount, memoryLimitBytes, stackLimitBytes, workerPath, permitTTL });
    this.slots = [];
    this.requestQueue = [];
    this.responseQueue = [];
    this.permits = new Map();
    this.waiters = [];
    this.queuedBytes = 0;
    this.saturationCount = 0;
    this.replacementCount = 0;
    this.state = "starting";
  }

  diagnostics() {
    return {
      lifecycle: this.state,
      workerCount: this.workerCount,
      liveWorkerCount: this.slots.filter(slot => slot.ready && !slot.retiring).length,
      requestQueueLength: this.requestQueue.length,
      responseQueueLength: this.responseQueue.length,
      responsePermitsInUse: this.permits.size,
      responsePermitCapacity: this.workerCount * 16,
      saturationCount: this.saturationCount,
      replacementCount: this.replacementCount,
    };
  }

  async start() {
    try {
      await Promise.all(Array.from({ length: this.workerCount }, () => {
        const slot = { ready: false, retiring: false, pending: null };
        this.slots.push(slot);
        return this.spawn(slot);
      }));
      this.state = "ready";
      this.dispatch();
    } catch (error) { await this.close(0); throw error; }
  }

  spawn(slot) {
    const worker = new Worker(this.workerPath);
    slot.worker = worker;
    slot.ready = false;
    slot.retiring = false;
    return new Promise((resolve, reject) => {
      const failStartup = () => {
        clearTimeout(timer);
        slot.ready = false;
        slot.retiring = true;
        reject(new RuntimePoolError("worker_failed"));
        void worker.terminate();
      };
      const timer = setTimeout(failStartup, 10_000);
      worker.on("message", message => {
        if (slot.worker !== worker || slot.retiring) return;
        if (!slot.ready && message?.type === "ready") {
          clearTimeout(timer);
          slot.ready = true;
          resolve();
          this.dispatch();
        } else if (slot.ready) {
          this.finish(slot, message);
        } else {
          failStartup();
        }
      });
      const failed = () => {
        if (slot.worker !== worker || slot.retiring) return;
        if (!slot.ready) failStartup();
        else this.retire(slot);
      };
      worker.on("error", failed);
      worker.on("messageerror", failed);
      worker.on("exit", failed);
    });
  }

  retire(slot, error = new RuntimePoolError("worker_failed")) {
    if (slot.retiring) return;
    slot.retiring = true;
    slot.ready = false;
    clearTimeout(slot.timer);
    if (slot.pending) this.settle(slot.pending, undefined, error);
    slot.pending = null;
    if (this.state === "ready") this.replacementCount += 1;
    const worker = slot.worker;
    void (async () => {
      await worker.terminate();
      while (this.state === "ready") {
        try { await this.spawn(slot); return; }
        catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
    })();
    this.dispatch();
  }

  saturated() {
    this.saturationCount += 1;
    return new RuntimePoolError("runtime_saturated");
  }

  reserveResponse(signal) {
    if (signal?.aborted) return Promise.reject(new RuntimePoolError("request_cancelled"));
    if (this.state !== "ready") return Promise.reject(new RuntimePoolError("runtime_closed"));
    if (this.permits.size < this.workerCount * 16) return Promise.resolve(this.issuePermit());
    if (this.waiters.length >= this.workerCount * 64) return Promise.reject(this.saturated());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal };
      const remove = error => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        this.cleanWaiter(waiter);
        reject(error);
      };
      waiter.abort = () => remove(new RuntimePoolError("request_cancelled"));
      waiter.timer = setTimeout(() => remove(this.saturated()), 2_000);
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  issuePermit() {
    const id = randomUUID();
    const permit = { consumed: false };
    permit.timer = setTimeout(() => this.releaseResponse(id), this.permitTTL);
    permit.timer.unref();
    this.permits.set(id, permit);
    return id;
  }

  cleanWaiter(waiter) {
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.abort);
  }

  releaseResponse(id) {
    const permit = this.permits.get(id);
    if (!permit) return;
    clearTimeout(permit.timer);
    this.permits.delete(id);
    while (this.state === "ready" && this.waiters.length && this.permits.size < this.workerCount * 16) {
      const waiter = this.waiters.shift();
      this.cleanWaiter(waiter);
      waiter.resolve(this.issuePermit());
    }
  }

  execute(payload, signal) {
    if (signal?.aborted) return Promise.reject(new RuntimePoolError("request_cancelled"));
    const response = Boolean(payload.responsePermitId);
    if (this.state === "closed" || (this.state !== "ready" && !response)) {
      return Promise.reject(new RuntimePoolError("runtime_closed"));
    }
    if (response) {
      const permit = this.permits.get(payload.responsePermitId);
      if (!permit || permit.consumed || payload.stage !== "response" || payload.kind !== "execute") {
        return Promise.reject(new RuntimePoolError("invalid_response_permit"));
      }
      permit.consumed = true;
      // The permit now belongs to a bounded queue/worker watchdog, not the
      // possibly crashed Go caller. It is released when the job settles.
      clearTimeout(permit.timer);
    }
    const byteLength = Buffer.byteLength(payload.script) + Buffer.byteLength(payload.inputJson) + Buffer.byteLength(payload.contextJson);
    // A granted response permit reserves the full legal input + context + UTF-8
    // source envelope, so paid provider responses cannot lose admission to
    // ordinary requests or to other already-reserved responses.
    const responseEnvelopeBytes = 2 * 2 * 1024 * 1024 + 4 * 32_768;
    const byteCapacity = this.workerCount * (32 * 1024 * 1024 + 16 * responseEnvelopeBytes);
    return new Promise((resolve, reject) => {
      const job = { id: randomUUID(), payload, byteLength, resolve, reject, signal, settled: false };
      const queue = response ? this.responseQueue : this.requestQueue;
      if (response) {
        while (this.requestQueue.length && this.queuedBytes + byteLength > byteCapacity) {
          const evicted = this.requestQueue.pop();
          this.removeAccounting(evicted);
          this.settle(evicted, undefined, this.saturated());
        }
      }
      if ((!response && queue.length >= this.workerCount * 64) || this.queuedBytes + byteLength > byteCapacity) {
        this.settle(job, undefined, this.saturated());
        return;
      }
      job.abort = () => {
        const index = queue.indexOf(job);
        if (index >= 0) { queue.splice(index, 1); this.removeAccounting(job); }
        this.settle(job, undefined, new RuntimePoolError("request_cancelled"));
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      job.queueTimer = setTimeout(() => {
        const index = queue.indexOf(job);
        if (index < 0) return;
        queue.splice(index, 1);
        this.removeAccounting(job);
        this.settle(job, undefined, this.saturated());
      }, response ? 5_000 : 2_000);
      queue.push(job);
      this.queuedBytes += byteLength;
      this.dispatch();
    });
  }

  removeAccounting(job) {
    this.queuedBytes -= job.byteLength;
    clearTimeout(job.queueTimer);
  }

  settle(job, output, error) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.queueTimer);
    job.signal?.removeEventListener("abort", job.abort);
    if (job.payload.responsePermitId) this.releaseResponse(job.payload.responsePermitId);
    if (error) job.reject(error); else job.resolve(output);
  }

  dispatch() {
    if (this.state !== "ready" && this.state !== "draining") return;
    for (const slot of this.slots) {
      if (!slot.ready || slot.retiring || slot.pending) continue;
      const job = this.responseQueue.shift() ?? this.requestQueue.shift();
      if (!job) break;
      this.removeAccounting(job);
      slot.pending = job;
      slot.timer = setTimeout(() => this.retire(slot, new RuntimePoolError("runtime_timeout")), 500);
      try {
        slot.worker.postMessage({ type: "job", id: job.id, kind: job.payload.kind, script: job.payload.script,
          inputJson: job.payload.inputJson, contextJson: job.payload.contextJson,
          timeoutMs: 50, memoryLimitBytes: this.memoryLimitBytes, stackLimitBytes: this.stackLimitBytes,
          maxScriptCharacters: 32_768, maxSerializedBytes: 2 * 1024 * 1024 });
      } catch { this.retire(slot); }
    }
  }

  finish(slot, message) {
    const job = slot.pending;
    if (!job || message?.type !== "result" || message.id !== job.id || typeof message.ok !== "boolean") {
      this.retire(slot);
      return;
    }
    clearTimeout(slot.timer);
    slot.pending = null;
    if (message.ok && job.payload.kind === "validate") this.settle(job, { valid: true });
    else if (message.ok && typeof message.outputJson === "string") {
      try { this.settle(job, JSON.parse(message.outputJson)); }
      catch { this.settle(job, undefined, new RuntimePoolError("invalid_output")); }
    } else this.settle(job, undefined, new RuntimePoolError("script_execution_failed"));
    if (message.replaceWorker) this.retire(slot);
    else this.dispatch();
  }

  async close(graceMs = 5_000) {
    this.state = "draining";
    for (const waiter of this.waiters.splice(0)) {
      this.cleanWaiter(waiter);
      waiter.reject(new RuntimePoolError("runtime_closed"));
    }
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && (this.permits.size || this.requestQueue.length || this.responseQueue.length || this.slots.some(slot => slot.pending))) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.state = "closed";
    for (const job of [...this.requestQueue.splice(0), ...this.responseQueue.splice(0)]) {
      this.removeAccounting(job);
      this.settle(job, undefined, new RuntimePoolError("runtime_closed"));
    }
    for (const id of this.permits.keys()) this.releaseResponse(id);
    await Promise.all(this.slots.map(async slot => {
      clearTimeout(slot.timer);
      slot.ready = false;
      slot.retiring = true;
      if (slot.pending) this.settle(slot.pending, undefined, new RuntimePoolError("runtime_closed"));
      slot.pending = null;
      await slot.worker.terminate();
    }));
  }
}
