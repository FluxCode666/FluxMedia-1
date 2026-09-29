/**
 * 站内系统更新状态推导的单元测试。
 *
 * 使用方：apps/web Vitest。覆盖 Go 状态、维护响应与连接失败的归一，以及跨重启
 * 推断本次更新最终结果的规则。
 */
import { describe, expect, it } from "vitest";

import {
  currentStep,
  downloadPercent,
  knownCode,
  readSystemUpdateProbe,
  SYSTEM_UPDATE_ERROR_CODES,
  type SystemUpdateProbe,
  type SystemUpdateStatus,
  trackedOutcome,
} from "./system-update-model";

function status(
  overrides: Partial<SystemUpdateStatus> = {}
): SystemUpdateStatus {
  return {
    currentVersion: "v1.0.0",
    imageVersion: "v1.0.0",
    updater: { available: true },
    latestRelease: null,
    updateAvailable: false,
    job: { state: "idle" },
    lastResult: null,
    ...overrides,
  };
}

function statusProbe(
  overrides: Partial<SystemUpdateStatus> = {}
): SystemUpdateProbe {
  return { kind: "status", status: status(overrides) };
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const tracked = { version: "v1.1.0", startedAt: "2026-09-30T10:00:00Z" };

describe("readSystemUpdateProbe", () => {
  it("网络失败视为服务重启中", async () => {
    expect(await readSystemUpdateProbe(null)).toEqual({ kind: "unreachable" });
  });

  it("解析正常状态", async () => {
    const body = status();
    expect(await readSystemUpdateProbe(jsonResponse(body))).toEqual({
      kind: "status",
      status: body,
    });
  });

  it("识别 boot.mjs 的迁移维护响应", async () => {
    const response = jsonResponse(
      {
        error: { code: "SYSTEM_UPDATING", message: "updating" },
        update: { phase: "backfilling", targetVersion: "v1.1.0" },
      },
      { status: 503 }
    );
    expect(await readSystemUpdateProbe(response)).toEqual({
      kind: "maintenance",
      phase: "backfilling",
      targetVersion: "v1.1.0",
    });
  });

  it("网关暂态错误与非 JSON 响应视为不可达", async () => {
    expect(
      await readSystemUpdateProbe(
        jsonResponse({ error: { code: "NOT_READY" } }, { status: 503 })
      )
    ).toEqual({ kind: "unreachable" });
    expect(
      await readSystemUpdateProbe(new Response("<html>", { status: 500 }))
    ).toEqual({ kind: "unreachable" });
  });

  it("其余错误带出状态码与错误码", async () => {
    const response = jsonResponse(
      { error: { code: "FORBIDDEN", message: "no" } },
      { status: 403 }
    );
    expect(await readSystemUpdateProbe(response)).toEqual({
      kind: "error",
      status: 403,
      code: "FORBIDDEN",
    });
  });
});

describe("currentStep", () => {
  it("按任务阶段、重启与维护响应返回步骤", () => {
    expect(currentStep({ kind: "unreachable" })).toBe("restarting");
    expect(
      currentStep({
        kind: "maintenance",
        phase: "migrating",
        targetVersion: null,
      })
    ).toBe("migrating");
    expect(
      currentStep(
        statusProbe({ job: { state: "running", phase: "backing_up" } })
      )
    ).toBe("backing_up");
    expect(
      currentStep(statusProbe({ job: { state: "running", phase: "odd" } }))
    ).toBe("downloading");
    expect(currentStep(statusProbe({ job: { state: "restarting" } }))).toBe(
      "restarting"
    );
    expect(currentStep(statusProbe())).toBeNull();
  });
});

describe("trackedOutcome", () => {
  it("重启和迁移期间保持进行中", () => {
    expect(trackedOutcome(tracked, { kind: "unreachable" })).toEqual({
      kind: "pending",
      step: "restarting",
    });
    expect(
      trackedOutcome(tracked, {
        kind: "maintenance",
        phase: "migrating",
        targetVersion: "v1.1.0",
      })
    ).toEqual({ kind: "pending", step: "migrating" });
  });

  it("当前版本变为目标版本即成功，并只采纳本次结果的警告", () => {
    const succeeded = {
      status: "succeeded" as const,
      code: "ok",
      message: null,
      version: "v1.1.0",
      fromVersion: "v1.0.0",
      warnings: ["dashboard_backfill_failed"],
      finishedAt: "2026-09-30T10:05:00Z",
    };
    expect(
      trackedOutcome(
        tracked,
        statusProbe({ currentVersion: "v1.1.0", lastResult: succeeded })
      )
    ).toEqual({ kind: "succeeded", warnings: ["dashboard_backfill_failed"] });
    expect(
      trackedOutcome(
        tracked,
        statusProbe({
          currentVersion: "v1.1.0",
          lastResult: { ...succeeded, finishedAt: "2026-09-29T10:05:00Z" },
        })
      )
    ).toEqual({ kind: "succeeded", warnings: [] });
  });

  it("Go 任务失败或 boot.mjs 记录本次失败时返回失败码", () => {
    expect(
      trackedOutcome(
        tracked,
        statusProbe({
          job: {
            state: "failed",
            targetVersion: "v1.1.0",
            error: "checksum_mismatch",
          },
        })
      )
    ).toEqual({ kind: "failed", code: "checksum_mismatch" });
    expect(
      trackedOutcome(
        tracked,
        statusProbe({
          lastResult: {
            status: "failed",
            code: "migration_failed",
            message: "boom",
            version: "v1.1.0",
            fromVersion: "v1.0.0",
            finishedAt: "2026-09-30T10:04:00Z",
          },
        })
      )
    ).toEqual({ kind: "failed", code: "migration_failed" });
  });

  it("早于本次任务的同版本失败不算本次结果", () => {
    expect(
      trackedOutcome(
        tracked,
        statusProbe({
          lastResult: {
            status: "failed",
            code: "migration_failed",
            message: null,
            version: "v1.1.0",
            fromVersion: "v1.0.0",
            finishedAt: "2026-09-29T10:04:00Z",
          },
        })
      )
    ).toEqual({ kind: "unknown" });
  });

  it("Go 返回非暂态错误时停止并报告错误码", () => {
    expect(
      trackedOutcome(tracked, {
        kind: "error",
        status: 401,
        code: "UNAUTHORIZED",
      })
    ).toEqual({ kind: "failed", code: "UNAUTHORIZED" });
  });
});

describe("downloadPercent", () => {
  it("总大小未知时返回 null，其余按比例取整并夹在 0-100", () => {
    expect(downloadPercent({ state: "running" })).toBeNull();
    expect(
      downloadPercent({ state: "running", downloadedBytes: 1, totalBytes: 3 })
    ).toBe(33);
    expect(
      downloadPercent({ state: "running", downloadedBytes: 9, totalBytes: 3 })
    ).toBe(100);
  });
});

describe("knownCode", () => {
  it("大小写不敏感匹配，未知码回退 unknown", () => {
    expect(knownCode("RELEASE_CHANGED", SYSTEM_UPDATE_ERROR_CODES)).toBe(
      "release_changed"
    );
    expect(knownCode("EVIL<script>", SYSTEM_UPDATE_ERROR_CODES)).toBe(
      "unknown"
    );
    expect(knownCode(undefined, SYSTEM_UPDATE_ERROR_CODES)).toBe("unknown");
  });
});
