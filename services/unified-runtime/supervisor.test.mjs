import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { defaultProcessSpecs, runSupervisor } from "./supervisor.mjs";

class FakeChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  signals = [];

  kill(signal) {
    this.signals.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}

const specs = ["backend", "web", "script-runtime", "media-processing"].map(
  (name) => ({ name, command: `/test/${name}`, args: [], cwd: "/test" })
);

test("starts all four direct children and forwards SIGTERM", async () => {
  const signalSource = new EventEmitter();
  const children = [];
  const result = runSupervisor(specs, {
    signalSource,
    shutdownTimeoutMs: 100,
    spawnProcess(command, args, options) {
      assert.equal(options.shell, false);
      const child = new FakeChild();
      children.push({ child, command, args });
      return child;
    },
  });

  assert.equal(children.length, 4);
  signalSource.emit("SIGTERM");
  assert.equal(await result, 0);
  assert.deepEqual(
    children.map(({ child }) => child.signals),
    [["SIGTERM"], ["SIGTERM"], ["SIGTERM"], ["SIGTERM"]]
  );
});

test("private runtimes receive only their required environment", async () => {
  const signalSource = new EventEmitter();
  const spawned = [];
  const environment = {
    DATABASE_URL: "postgresql://must-not-leak",
    HOME: "/home/fluxmedia",
    MEDIA_PROCESSING_PORT: "8091",
    GO_MEDIA_PROCESSING_TOKEN: "media-token-with-$-literal",
    PATH: "/usr/local/bin:/usr/bin",
    REDIS_PASSWORD: "must-not-leak",
    SCRIPT_RUNTIME_BIND: ":8090",
    GO_SCRIPT_RUNTIME_TOKEN: "script-token-with-$-literal",
  };
  const result = runSupervisor(defaultProcessSpecs(environment), {
    environment,
    signalSource,
    shutdownTimeoutMs: 100,
    spawnProcess(command, args, options) {
      const child = new FakeChild();
      spawned.push({ child, command, env: options.env });
      return child;
    },
  });

  assert.equal(spawned[0].env.DATABASE_URL, environment.DATABASE_URL);
  assert.equal(spawned[1].env.REDIS_PASSWORD, environment.REDIS_PASSWORD);
  assert.equal(spawned[2].env.SCRIPT_RUNTIME_BIND, ":8090");
  assert.equal(spawned[2].env.SCRIPT_RUNTIME_TOKEN, environment.GO_SCRIPT_RUNTIME_TOKEN);
  assert.equal(spawned[3].env.MEDIA_PROCESSING_PORT, "8091");
  assert.equal(spawned[3].env.MEDIA_PROCESSING_TOKEN, environment.GO_MEDIA_PROCESSING_TOKEN);
  for (const { env } of spawned.slice(2)) {
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.REDIS_PASSWORD, undefined);
    assert.equal(env.HOME, environment.HOME);
    assert.equal(env.PATH, environment.PATH);
  }

  signalSource.emit("SIGTERM");
  assert.equal(await result, 0);
});

test("a premature child exit fails fast and terminates the other children", async () => {
  const signalSource = new EventEmitter();
  const children = [];
  const result = runSupervisor(specs, {
    signalSource,
    shutdownTimeoutMs: 100,
    logger: { error() {} },
    spawnProcess() {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });

  children[1].exitCode = 2;
  children[1].emit("close", 2, null);
  assert.equal(await result, 1);
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
  assert.deepEqual(children[1].signals, []);
  assert.deepEqual(children[2].signals, ["SIGTERM"]);
  assert.deepEqual(children[3].signals, ["SIGTERM"]);
});

test("uses SIGKILL and returns failure when a child ignores graceful shutdown", async () => {
  const signalSource = new EventEmitter();
  const children = [];
  const result = runSupervisor(specs, {
    signalSource,
    shutdownTimeoutMs: 5,
    logger: { error() {} },
    spawnProcess() {
      const child = new FakeChild();
      child.kill = function kill(signal) {
        this.signals.push(signal);
        if (signal === "SIGKILL") this.signalCode = signal;
        return true;
      };
      children.push(child);
      return child;
    },
  });

  children[0].exitCode = 1;
  children[0].emit("close", 1, null);
  assert.equal(await result, 1);
  assert.ok(children[1].signals.includes("SIGKILL"));
  assert.ok(children[2].signals.includes("SIGKILL"));
  assert.ok(children[3].signals.includes("SIGKILL"));
});
