import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkUnifiedHealth,
  defaultHealthEndpoints,
  defaultModelFiles,
} from "./healthcheck.mjs";

test("checks all four internal services and all media models", async () => {
  const requests = [];
  const accessedFiles = [];
  await checkUnifiedHealth({
    timeoutMs: 100,
    fetchImpl: async (url) => {
      requests.push(url);
      return { ok: true, status: 200 };
    },
    accessImpl: async (file) => accessedFiles.push(file),
  });
  assert.deepEqual(
    requests.sort(),
    defaultHealthEndpoints.map(({ url }) => url).sort()
  );
  assert.deepEqual(accessedFiles.sort(), defaultModelFiles().sort());
});

test("fails when any internal service is unhealthy", async (t) => {
  for (const failedEndpoint of defaultHealthEndpoints) {
    await t.test(failedEndpoint.name, async () => {
      await assert.rejects(
        checkUnifiedHealth({
          timeoutMs: 100,
          accessImpl: async () => {},
          fetchImpl: async (url) => ({
            ok: url !== failedEndpoint.url,
            status: url === failedEndpoint.url ? 503 : 200,
          }),
        }),
        new RegExp(`${failedEndpoint.name} healthcheck failed`)
      );
    });
  }
});

test("fails when any media model is unreadable", async () => {
  const failedFile = defaultModelFiles()[1];
  await assert.rejects(
    checkUnifiedHealth({
      timeoutMs: 100,
      fetchImpl: async () => ({ ok: true, status: 200 }),
      accessImpl: async (file) => {
        if (file === failedFile) throw new Error("unreadable");
      },
    }),
    /media model healthcheck failed/
  );
});
