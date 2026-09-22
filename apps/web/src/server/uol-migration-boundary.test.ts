import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { listOperations } from "@repo/shared/uol";
import { expect, it, vi } from "vitest";

// Next supplies this build-time guard; it has no behavior in the Node test runner.
vi.mock("server-only", () => ({}));

import { ensureUolInitialized } from "./uol-init";

it("initializes every inventoried operation with a non-placeholder execution binding", async () => {
  await ensureUolInitialized();
  const inventory = JSON.parse(readFileSync(
    resolve(process.cwd(), "../../docs/go-migration-inventory.json"), "utf8"
  )) as { operations: Array<{ name: string }> };
  const operations = listOperations();
  expect(operations.map(({ name }) => name).sort()).toEqual(
    inventory.operations.map(({ name }) => name).sort()
  );
  const placeholders = operations.filter(({ execute }) =>
    /Not yet wired|must be bound at app level/.test(execute.toString())
  ).map(({ name }) => name);
  expect(placeholders).toEqual([]);
});
