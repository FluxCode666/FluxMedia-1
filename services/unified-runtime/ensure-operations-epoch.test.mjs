import assert from "node:assert/strict";
import { test } from "node:test";

import { ensureOperationsEpoch } from "./ensure-operations-epoch.mjs";

test("sends the epoch request to the loopback backend", async () => {
  const secret = "test-secret-that-must-not-be-logged";
  let request;
  const result = await ensureOperationsEpoch({
    environment: {
      CRON_SECRET: secret,
      OPERATIONS_EPOCH_INITIALIZED_BY: "release-v1.2.3",
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return { initialized: true, appDate: "2026-09-23" };
        },
      };
    },
  });

  assert.equal(
    request.url,
    "http://127.0.0.1:8080/api/operations/ensure-epoch"
  );
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.authorization, `Bearer ${secret}`);
  assert.deepEqual(JSON.parse(request.options.body), {
    initializedBy: "release-v1.2.3",
  });
  assert.equal(result.initialized, true);
});

test("accepts a raw dotenv quote pair around CRON_SECRET", async () => {
  let authorization;
  await ensureOperationsEpoch({
    environment: {
      CRON_SECRET: '"quoted-secret"',
      OPERATIONS_EPOCH_INITIALIZED_BY: "release-test",
    },
    fetchImpl: async (_url, options) => {
      authorization = options.headers.authorization;
      return { ok: true, status: 200, async json() { return {}; } };
    },
  });
  assert.equal(authorization, "Bearer quoted-secret");
});

test("request failures do not expose CRON_SECRET", async () => {
  const secret = "do-not-leak-this-secret";
  await assert.rejects(
    ensureOperationsEpoch({
      environment: {
        CRON_SECRET: secret,
        OPERATIONS_EPOCH_INITIALIZED_BY: "release-test",
      },
      fetchImpl: async () => {
        throw new Error(`network failure with ${secret}`);
      },
    }),
    (error) => {
      assert.equal(error.message, "operations epoch request failed");
      assert.equal(error.message.includes(secret), false);
      return true;
    }
  );
});
