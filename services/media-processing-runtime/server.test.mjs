import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { closeMediaServer, registerMediaShutdown } from "./server.mjs";

test("media shutdown stops admission and waits for server close", async () => {
  const order = [];
  const server = {
    close(callback) {
      order.push("close-start");
      queueMicrotask(() => {
        order.push("close-finished");
        callback();
      });
    },
    closeIdleConnections() {
      order.push("close-idle");
    },
  };
  await closeMediaServer(server, { timeoutMs: 100 });
  assert.deepEqual(order, ["close-start", "close-idle", "close-finished"]);
});

test("media shutdown forcibly closes connections after its short timeout", async () => {
  let forced = 0;
  const server = {
    close() {},
    closeAllConnections() { forced += 1; },
  };
  await assert.rejects(
    closeMediaServer(server, { timeoutMs: 5 }),
    /media server shutdown timed out/
  );
  assert.equal(forced, 1);
});

test("registered media shutdown handles both signals idempotently", async () => {
  const signalSource = new EventEmitter();
  let closeCalls = 0;
  const server = {
    close(callback) {
      closeCalls += 1;
      callback();
    },
  };
  const shutdown = registerMediaShutdown(server, { signalSource });
  signalSource.emit("SIGTERM");
  signalSource.emit("SIGINT");
  await shutdown();
  assert.equal(closeCalls, 1);
});
