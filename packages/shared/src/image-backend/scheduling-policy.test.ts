/**
 * 统一媒体后端调度策略测试。
 *
 * 职责：锁定三种全局策略的解析、主排序与确定性平局规则；数据库调度器只需
 * 提供候选快照，不得另行发明排序语义。
 */
import { describe, expect, it } from "vitest";

import { SYSTEM_SETTING_DEFINITIONS } from "../system-settings/definitions";

import {
  type BackendSchedulingCandidate,
  normalizeBackendSchedulingStrategy,
  sortBackendSchedulingCandidates,
} from "./scheduling-policy";

function candidate(
  id: string,
  overrides: Partial<BackendSchedulingCandidate> = {}
): BackendSchedulingCandidate {
  return {
    id,
    priority: 10,
    isHealthy: true,
    leaseAcquiredCount: 0,
    inflightCount: 0,
    concurrency: 10,
    lastAcquiredAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

describe("backend scheduling policy", () => {
  it.each([
    "priority",
    "least_acquired",
    "least_load",
  ] as const)("parses %s", (strategy) => {
    expect(normalizeBackendSchedulingStrategy(strategy)).toBe(strategy);
  });

  it("publishes the three strategies as a dynamic system setting", () => {
    const definition = SYSTEM_SETTING_DEFINITIONS.find(
      ({ key }) => key === "IMAGE_BACKEND_SCHEDULING_STRATEGY"
    );
    expect(definition).toMatchObject({
      valueType: "select",
      defaultValue: "priority",
      options: [
        { value: "priority" },
        { value: "least_acquired" },
        { value: "least_load" },
      ],
    });
  });

  it.each([
    undefined,
    null,
    "",
    "random",
    1,
    {},
  ])("falls back invalid value %j to priority", (value) => {
    expect(normalizeBackendSchedulingStrategy(value)).toBe("priority");
  });

  it("sorts priority by priority, health, oldest acquisition and stable id", () => {
    const sorted = sortBackendSchedulingCandidates(
      [
        candidate("d", { priority: 20 }),
        candidate("c", { isHealthy: false }),
        candidate("b", { lastAcquiredAt: new Date("2026-01-02") }),
        candidate("a", { lastAcquiredAt: new Date("2026-01-01") }),
      ],
      "priority"
    );

    expect(sorted.map(({ id }) => id)).toEqual(["a", "b", "c", "d"]);
  });

  it("sorts least acquired before applying priority and health ties", () => {
    const sorted = sortBackendSchedulingCandidates(
      [
        candidate("eight", { leaseAcquiredCount: 8, priority: 0 }),
        candidate("three-unhealthy", {
          leaseAcquiredCount: 3,
          priority: 5,
          isHealthy: false,
        }),
        candidate("three-healthy", {
          leaseAcquiredCount: 3,
          priority: 5,
        }),
      ],
      "least_acquired"
    );

    expect(sorted.map(({ id }) => id)).toEqual([
      "three-healthy",
      "three-unhealthy",
      "eight",
    ]);
  });

  it("compares least load by occupancy ratio instead of absolute inflight", () => {
    const sorted = sortBackendSchedulingCandidates(
      [
        candidate("half", { inflightCount: 1, concurrency: 2 }),
        candidate("fifth", { inflightCount: 2, concurrency: 10 }),
      ],
      "least_load"
    );

    expect(sorted.map(({ id }) => id)).toEqual(["fifth", "half"]);
  });

  it("does not mutate the scheduler candidate input", () => {
    const input = [candidate("b"), candidate("a")];
    const sorted = sortBackendSchedulingCandidates(input, "priority");

    expect(input.map(({ id }) => id)).toEqual(["b", "a"]);
    expect(sorted.map(({ id }) => id)).toEqual(["a", "b"]);
  });
});
