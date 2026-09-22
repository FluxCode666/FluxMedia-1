import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimePool } from "./pool.mjs";
import { createRuntimeServer } from "./server.mjs";

const keys = ["lifecycle", "workerCount", "liveWorkerCount", "requestQueueLength", "responseQueueLength", "responsePermitsInUse", "responsePermitCapacity", "saturationCount", "replacementCount"];

async function fixture(t, options = {}) {
  const pool = new RuntimePool({ workerCount: 1, memoryLimitBytes: 32 * 1024 * 1024, stackLimitBytes: 512 * 1024, ...options });
  await pool.start();
  const server = createRuntimeServer(pool, "private-test-token");
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await pool.close(0); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => fetch(base + path, { ...options, headers: { Authorization: "Bearer private-test-token", "Content-Type": "application/json", ...options.headers } });
  const snapshot = async () => {
    const response = await request("/v1/diagnostics");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await response.json();
    assert.deepEqual(Object.keys(payload.data).sort(), [...keys].sort());
    return payload.data;
  };
  const reserve = async (options = {}) => {
    const response = await request("/v1/response-permits", { method: "POST", ...options });
    assert.equal(response.status, 200);
    return (await response.json()).data.id;
  };
  const execute = (script, extra = {}, options = {}) => request("/v1/execute", { method: "POST", ...options, body: JSON.stringify({ script, operation: "images.generate", stage: "request", input: { safe: "data" }, context: {}, ...extra }) });
  return { request, snapshot, reserve, execute };
}

async function until(fn, predicate) {
  const deadline = Date.now() + 5_000;
  let last;
  do { last = await fn(); if (predicate(last)) return last; await delay(10); } while (Date.now() < deadline);
  assert.fail(`condition timed out: ${JSON.stringify(last)}`);
}

test("private HTTP diagnostics reflect real QuickJS permits, auth and safe counters", async t => {
  const runtime = await fixture(t, { workerCount: 2 });
  for (const [path, method] of [["/v1/diagnostics", "GET"], ["/v1/response-permits", "POST"], ["/v1/response-permits/11111111-1111-4111-8111-111111111111", "DELETE"]]) {
    assert.equal((await runtime.request(path, { method, headers: { Authorization: "Bearer wrong" } })).status, 401);
  }
  const initial = await runtime.snapshot();
  assert.equal(initial.workerCount, 2);
  assert.equal(initial.liveWorkerCount, 2);
  assert.equal(initial.responsePermitCapacity, 32);
  const id = await runtime.reserve();
  assert.equal((await runtime.snapshot()).responsePermitsInUse, 1);
  const result = await runtime.execute("return { value: input.safe, isolated: typeof process, permitVisible: context.responsePermitId };", { stage: "response", responsePermitId: id });
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).data.output, { value: "data", isolated: "undefined" });
  assert.equal((await runtime.snapshot()).responsePermitsInUse, 0);
  assert.equal((await runtime.execute("return input;", { stage: "response", responsePermitId: id })).status, 409);
  for (let i = 0; i < 2; i++) assert.equal((await runtime.request(`/v1/response-permits/${id}`, { method: "DELETE" })).status, 204);
  const bad = await runtime.reserve();
  assert.equal((await runtime.execute("throw new Error('private-source');", { stage: "response", responsePermitId: bad })).status, 422);
  assert.equal((await runtime.snapshot()).responsePermitsInUse, 0);
  const empty = await runtime.execute("", { input: { unchanged: true } });
  assert.deepEqual((await empty.json()).data.output, { unchanged: true });
});

const workerPath = new URL("./test-fixtures/controlled-worker.mjs", import.meta.url);

test("HTTP reports queued requests/responses and real saturation, with reserved responses first", async t => {
  const holdGate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const runtime = await fixture(t, {
    workerPath,
    workerData: { holdGate: holdGate.buffer },
    executionTimeoutMs: 5_000,
  });
  const permit = await runtime.reserve();
  const hold = runtime.execute("hold");
  const completed = [];
  const queued = Array.from({ length: 70 }, (_, index) => runtime.execute("normal", { input: { index } }).then(async response => {
    const payload = await response.json();
    if (response.status === 200) completed.push(`request-${index}`);
    else { assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "1"); }
    return { status: response.status, payload };
  }));
  const responseJob = runtime.execute("normal", { stage: "response", responsePermitId: permit }).then(async response => {
    assert.equal(response.status, 200); await response.json(); completed.push("response");
  });
  const busy = await until(runtime.snapshot, value => value.requestQueueLength > 0 && value.responseQueueLength === 1 && value.saturationCount > 0);
  assert.ok(busy.requestQueueLength <= 64);
  assert.equal(busy.responsePermitsInUse, 1);
  Atomics.store(holdGate, 0, 1);
  Atomics.notify(holdGate, 0);
  await Promise.all([hold, responseJob, ...queued]);
  assert.equal(completed[0], "response");
  const idle = await runtime.snapshot();
  assert.equal(idle.requestQueueLength, 0);
  assert.equal(idle.responseQueueLength, 0);
  assert.equal(idle.responsePermitsInUse, 0);
  assert.ok(idle.saturationCount > 0);
});

test("disconnected queued work releases response permits and does not run later", async t => {
  const runtime = await fixture(t, { workerPath });
  const permit = await runtime.reserve();
  const hold = runtime.execute("hold");
  await delay(25);
  const controller = new AbortController();
  const queued = runtime.execute("exit", { stage: "response", responsePermitId: permit }, { signal: controller.signal }).catch(error => error);
  await until(runtime.snapshot, value => value.responseQueueLength === 1);
  controller.abort();
  await queued;
  await until(runtime.snapshot, value => value.responseQueueLength === 0 && value.responsePermitsInUse === 0);
  await hold;
  assert.equal((await runtime.snapshot()).replacementCount, 0);
});

test("reserved responses keep admission for the full legal input and context envelope", async t => {
  const runtime = await fixture(t, { workerPath });
  const permits = await Promise.all(Array.from({ length: 16 }, () => runtime.reserve()));
  const hold = runtime.execute("hold");
  await delay(25);
  const large = "a".repeat(1_600_000);
  const responses = permits.map(responsePermitId => runtime.execute("normal", {
    stage: "response", responsePermitId, input: { data: large }, context: { data: large },
  }).then(async response => { assert.equal(response.status, 200); await response.arrayBuffer(); }));
  await Promise.all([hold, ...responses]);
  const idle = await runtime.snapshot();
  assert.equal(idle.responsePermitsInUse, 0);
  assert.equal(idle.saturationCount, 0);
});

test("permit capacity is bounded, cancelled waiters are removed and expiry reclaims lost callers", async t => {
  const runtime = await fixture(t, { workerPath });
  const permits = await Promise.all(Array.from({ length: 16 }, () => runtime.reserve()));
  assert.equal((await runtime.snapshot()).responsePermitsInUse, 16);
  const controller = new AbortController();
  const waiting = runtime.request("/v1/response-permits", { method: "POST", signal: controller.signal }).catch(error => error);
  await delay(25); controller.abort(); await waiting;
  const rejected = await runtime.request("/v1/response-permits", { method: "POST" });
  assert.equal(rejected.status, 503);
  assert.ok((await runtime.snapshot()).saturationCount >= 1);
  await Promise.all(permits.map(id => runtime.request(`/v1/response-permits/${id}`, { method: "DELETE" })));
  assert.equal((await runtime.snapshot()).responsePermitsInUse, 0);
  const expiring = await fixture(t, { workerPath, permitTTL: 80 });
  await expiring.reserve();
  await until(expiring.snapshot, value => value.responsePermitsInUse === 0);
});

test("worker crashes, wrong IDs, cleanup errors and wall timeouts replace workers and recover", async t => {
  const runtime = await fixture(t, { workerPath });
  let count = 0;
  for (const fault of ["exit", "wrong-id", "cleanup-failed", "hang"]) {
    const id = await runtime.reserve();
    const result = await runtime.execute(fault, { stage: "response", responsePermitId: id });
    assert.equal(result.status, 422);
    count += 1;
    const recovered = await until(runtime.snapshot, value => value.liveWorkerCount === 1 && value.replacementCount === count);
    assert.equal(recovered.responsePermitsInUse, 0);
    assert.equal((await runtime.execute("normal")).status, 200);
  }
});
