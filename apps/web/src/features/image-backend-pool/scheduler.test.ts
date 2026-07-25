/**
 * 统一媒体后端 DB-free 调度层测试。
 *
 * 职责：锁定候选资格、三策略排序、获租边界和基础设施失败语义，防止数据库
 * repository 引入前缀分流、进程内租约或其他降级口径。
 */
import { describe, expect, it, vi } from "vitest";

import {
  acquireBackendMember,
  type BackendAcquireCandidate,
  type BackendMemberAcquireRequest,
  BackendSchedulerError,
  getBackendCandidateIneligibilityReason,
  selectBackendMemberForAcquire,
} from "./scheduler";

const NOW = new Date("2026-07-26T00:00:00.000Z");

/** 构造默认合格的候选，测试只覆盖关心的差异字段。 */
function candidate(
  id: string,
  overrides: Partial<BackendAcquireCandidate> = {}
): BackendAcquireCandidate {
  return {
    id,
    groupIds: ["group-a"],
    supportedModelIds: ["gpt-image-2"],
    isEnabled: true,
    contentSafetyEnabled: true,
    cooldownUntil: null,
    hasTerminalError: false,
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

/** 构造一次固定的获租请求快照。 */
function acquireRequest(
  overrides: Partial<BackendMemberAcquireRequest> = {}
): BackendMemberAcquireRequest {
  return {
    groupId: "group-a",
    modelId: "gpt-image-2",
    strategy: "priority",
    contentSafetyRequired: true,
    excludedMemberIds: [],
    now: NOW,
    ...overrides,
  };
}

/** 从选择结果提取成员 ID，并让未选择结果直接使测试失败。 */
function selectedId(
  result: ReturnType<typeof selectBackendMemberForAcquire>
): string {
  if (result.status !== "selected") {
    throw new Error(`Expected selected result, received ${result.status}`);
  }
  return result.candidate.id;
}

describe("backend member scheduler", () => {
  it("uses stable priority ordering", () => {
    const result = selectBackendMemberForAcquire(
      [
        candidate("later", {
          lastAcquiredAt: new Date("2026-07-25T12:00:00.000Z"),
        }),
        candidate("unhealthy", { isHealthy: false }),
        candidate("stable-b"),
        candidate("stable-a"),
        candidate("lower-priority", { priority: 20 }),
      ],
      acquireRequest()
    );

    expect(selectedId(result)).toBe("stable-a");
  });

  it("uses stable least-acquired ordering", () => {
    const result = selectBackendMemberForAcquire(
      [
        candidate("many", { leaseAcquiredCount: 8, priority: 0 }),
        candidate("few-unhealthy", {
          leaseAcquiredCount: 3,
          priority: 5,
          isHealthy: false,
        }),
        candidate("few-b", { leaseAcquiredCount: 3, priority: 5 }),
        candidate("few-a", { leaseAcquiredCount: 3, priority: 5 }),
      ],
      acquireRequest({ strategy: "least_acquired" })
    );

    expect(selectedId(result)).toBe("few-a");
  });

  it("uses occupancy ratio for stable least-load ordering", () => {
    const result = selectBackendMemberForAcquire(
      [
        candidate("half", { inflightCount: 1, concurrency: 2 }),
        candidate("fifth-b", { inflightCount: 2, concurrency: 10 }),
        candidate("fifth-a", { inflightCount: 2, concurrency: 10 }),
      ],
      acquireRequest({ strategy: "least_load" })
    );

    expect(selectedId(result)).toBe("fifth-a");
  });

  it.each([
    ["disabled", candidate("disabled", { isEnabled: false })],
    ["terminal_error", candidate("terminal", { hasTerminalError: true })],
    [
      "cooling_down",
      candidate("cooling", {
        cooldownUntil: new Date("2026-07-26T00:00:01.000Z"),
      }),
    ],
    ["wrong_group", candidate("wrong-group", { groupIds: ["group-b"] })],
    [
      "unsupported_model",
      candidate("wrong-model", { supportedModelIds: ["other-model"] }),
    ],
    ["unsupported_model", candidate("empty-models", { supportedModelIds: [] })],
    [
      "content_safety_required",
      candidate("unsafe", { contentSafetyEnabled: false }),
    ],
    ["excluded", candidate("excluded")],
    ["invalid_capacity", candidate("invalid-capacity", { concurrency: 0 })],
    ["at_capacity", candidate("full", { inflightCount: 2, concurrency: 2 })],
  ] as const)("filters candidates for %s", (reason, value) => {
    const request = acquireRequest({
      excludedMemberIds: value.id === "excluded" ? [value.id] : [],
    });

    expect(getBackendCandidateIneligibilityReason(value, request)).toBe(reason);
  });

  it("selects only candidates passing every common eligibility filter", () => {
    const result = selectBackendMemberForAcquire(
      [
        candidate("wrong-group", { groupIds: ["group-b"] }),
        candidate("wrong-model", { supportedModelIds: ["other-model"] }),
        candidate("cooling", {
          cooldownUntil: new Date("2026-07-26T00:00:01.000Z"),
        }),
        candidate("terminal", { hasTerminalError: true }),
        candidate("excluded"),
        candidate("full", { inflightCount: 10 }),
        candidate("eligible", {
          supportedModelIds: ["GPT-IMAGE-2"],
          cooldownUntil: NOW,
        }),
      ],
      acquireRequest({ excludedMemberIds: ["excluded"] })
    );

    expect(result).toMatchObject({
      status: "selected",
      eligibleCandidateCount: 1,
      candidate: { id: "eligible" },
    });
  });

  it("returns a stable unavailable error when no candidate is eligible", () => {
    const result = selectBackendMemberForAcquire(
      [candidate("full", { inflightCount: 10 })],
      acquireRequest()
    );

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.error).toBeInstanceOf(BackendSchedulerError);
    expect(result.error.code).toBe("no_eligible_member");
  });

  it("returns a transactionally persisted lease on acquire", async () => {
    const request = acquireRequest();
    const selected = candidate("selected");
    const result = await acquireBackendMember(
      request,
      async (input, select) => {
        expect(input).toBe(request);
        const decision = select([selected]);
        if (decision.status !== "selected") return decision;
        return {
          status: "acquired",
          strategy: decision.strategy,
          member: decision.candidate,
          lease: {
            leaseId: "lease-1",
            ownerToken: "owner-1",
            expiresAt: new Date("2026-07-26T00:05:00.000Z"),
          },
          eligibleCandidateCount: decision.eligibleCandidateCount,
        };
      }
    );

    expect(result).toMatchObject({
      status: "acquired",
      member: { id: "selected" },
      lease: { leaseId: "lease-1", ownerToken: "owner-1" },
    });
  });

  it("turns infrastructure failure into a stable error without fallback", async () => {
    const infrastructureFailure = new Error("database unavailable");
    const transaction = vi.fn(async () => {
      throw infrastructureFailure;
    });

    const error = await acquireBackendMember(
      acquireRequest(),
      transaction
    ).catch((cause: unknown) => cause);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(BackendSchedulerError);
    expect(error).toMatchObject({
      code: "infrastructure_unavailable",
      message: "媒体后端调度基础设施不可用",
      cause: infrastructureFailure,
    });
  });
});
