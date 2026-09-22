import "@repo/shared/uol/operations";
import { invokeOperation, isOperationBound } from "@repo/shared/uol";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:5432/unit";
  return { json: vi.fn(), response: vi.fn(), info: vi.fn(), warn: vi.fn() };
});
vi.mock("@repo/shared/logger", () => ({
  logger: { info: mocks.info, warn: mocks.warn },
  logError: vi.fn(),
}));
vi.mock("@/server/go-backend-client", () => ({
  requestGoJson: mocks.json,
  requestGoResponse: mocks.response,
  GoBackendRequestError: class GoBackendRequestError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string
    ) {
      super(message);
    }
  },
}));

import { GoBackendRequestError } from "@/server/go-backend-client";
import {
  createOperationsDetailFixture,
  createOperationsOverviewFixture,
} from "@/features/operations-dashboard/operations-dashboard-test-fixtures";
import "./operations-dashboard";

const admin = { type: "user", userId: "admin-1", role: "admin" } as const;
const query = { granularity: "day", range: { kind: "default" } };
const task = {
  id: "task-1",
  exportType: "user_growth",
  status: "queued",
  query,
  createdAt: "2026-08-14T00:00:00.000Z",
  completedAt: null,
  expiresAt: null,
  rowCount: null,
  byteCount: null,
  errorCode: null,
  retryOfTaskId: null,
};

describe("Go operations bindings", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("authorizes before forwarding normalized overview and detail queries to Go", async () => {
    const overview = createOperationsOverviewFixture();
    mocks.json.mockResolvedValueOnce(overview);
    await expect(
      invokeOperation("operations.getOverview", {}, admin)
    ).resolves.toEqual(overview);
    expect(mocks.json).toHaveBeenCalledWith("/api/admin/operations/overview", {
      method: "POST",
      body: JSON.stringify(query),
    });
    const detail = createOperationsDetailFixture();
    mocks.json.mockResolvedValueOnce(detail);
    const selection = { module: "growth", detail: "users" };
    await expect(
      invokeOperation("operations.getDetail", { selection }, admin)
    ).resolves.toEqual(detail);
    expect(mocks.json).toHaveBeenLastCalledWith(
      "/api/admin/operations/detail",
      {
        method: "POST",
        body: JSON.stringify({ ...query, selection, limit: 100 }),
      }
    );
    await expect(
      invokeOperation(
        "operations.getOverview",
        {},
        { type: "user", userId: "observer", role: "observer_admin" }
      )
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.json).toHaveBeenCalledTimes(2);
  });

  it.each([
    [400, "validation_error"],
    [401, "unauthenticated"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [429, "rate_limited"],
    [503, "not_ready"],
    [500, "internal_error"],
  ])("preserves safe Go HTTP %s errors as %s", async (status, code) => {
    mocks.json.mockRejectedValue(
      new GoBackendRequestError("backend failure", Number(status))
    );
    await expect(
      invokeOperation("operations.getOverview", {}, admin)
    ).rejects.toMatchObject({ code });
  });

  it("validates outputs and records only overview metrics in telemetry", async () => {
    const overview = createOperationsOverviewFixture();
    mocks.json.mockResolvedValueOnce(overview);
    await invokeOperation("operations.getOverview", {}, admin, {
      requestId: "overview-request",
    });
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "operations.getOverview",
        requestId: "overview-request",
        rangeDays: overview.range.dayCount,
        bucketCount: overview.range.buckets.length,
        status: "succeeded",
      }),
      "Operations dashboard operation completed"
    );
    mocks.json.mockResolvedValueOnce({ tasks: "invalid" });
    await expect(
      invokeOperation("operations.getOverview", {}, admin)
    ).rejects.toMatchObject({ code: "internal_error" });
  });

  it("forwards all export lifecycle operations to their Go endpoints", async () => {
    for (const name of [
      "operations.createExport",
      "operations.listExports",
      "operations.retryExport",
      "operations.prepareExportDownload",
      "operations.openLocalExportDownload",
      "operations.processExports",
      "operations.expireExports",
    ])
      expect(isOperationBound(name)).toBe(true);
    mocks.json.mockResolvedValueOnce({ task });
    await expect(
      invokeOperation(
        "operations.createExport",
        { exportType: "user_growth", query: {}, clientRequestId: "request-1" },
        admin
      )
    ).resolves.toEqual({ task });
    expect(mocks.json).toHaveBeenLastCalledWith(
      "/api/admin/operations/exports",
      {
        method: "POST",
        body: JSON.stringify({
          exportType: "user_growth",
          query,
          clientRequestId: "request-1",
        }),
      }
    );
    mocks.json.mockResolvedValueOnce({ task });
    await invokeOperation(
      "operations.retryExport",
      { taskId: "task-1", clientRequestId: "retry-1" },
      admin
    );
    expect(mocks.json).toHaveBeenLastCalledWith(
      "/api/admin/operations/exports/retry",
      {
        method: "POST",
        body: JSON.stringify({ taskId: "task-1", clientRequestId: "retry-1" }),
      }
    );
    mocks.json.mockResolvedValueOnce({ tasks: [task], nextCursor: null });
    await invokeOperation("operations.listExports", { limit: 20 }, admin);
    expect(mocks.json).toHaveBeenLastCalledWith(
      "/api/admin/operations/exports?limit=20"
    );
    const permit = {
      taskId: "task-1",
      mode: "stream",
      downloadUrl:
        "http://localhost:3000/api/admin/operations/exports/task-1/download",
      expiresAt: "2026-08-14T00:01:00Z",
    };
    mocks.json.mockResolvedValueOnce(permit);
    await expect(
      invokeOperation(
        "operations.prepareExportDownload",
        { taskId: "task-1" },
        admin
      )
    ).resolves.toEqual(permit);
  });

  it("passes Go CSV bytes as an async stream and cancels on early consumption", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a,b\r\n"));
      },
      cancel,
    });
    mocks.response.mockResolvedValueOnce(
      new Response(stream, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition":
            'attachment; filename="operations-user_growth-task-1.csv"',
        },
      })
    );
    const out = (await invokeOperation(
      "operations.openLocalExportDownload",
      { taskId: "task-1" },
      admin
    )) as {
      taskId: string;
      filename: string;
      stream: AsyncIterable<Uint8Array>;
    };
    expect(out.taskId).toBe("task-1");
    expect(mocks.response).toHaveBeenCalledWith(
      "/api/admin/operations/exports/task-1/download",
      { method: "GET" }
    );
    for await (const chunk of out.stream) {
      expect(new TextDecoder().decode(chunk)).toBe("a,b\r\n");
      break;
    }
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects a JSON permit or remote provider returned to a local stream request", async () => {
    mocks.response.mockResolvedValueOnce(Response.json({ mode: "redirect" }));
    await expect(
      invokeOperation(
        "operations.openLocalExportDownload",
        { taskId: "task-1" },
        admin
      )
    ).rejects.toMatchObject({ code: "internal_error" });
    mocks.response.mockRejectedValueOnce(
      new GoBackendRequestError("remote provider", 409)
    );
    await expect(
      invokeOperation(
        "operations.openLocalExportDownload",
        { taskId: "task-1" },
        admin
      )
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("permits only the matching worker cron principal and forwards its credential", async () => {
    vi.stubEnv("CRON_SECRET", "test-operations-secret");
    try {
      await expect(
        invokeOperation(
          "operations.processExports",
          { limit: 1 },
          { type: "cron", job: "operations-export-retention" }
        )
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        invokeOperation(
          "operations.expireExports",
          { limit: 1 },
          { type: "cron", job: "operations-export" }
        )
      ).rejects.toMatchObject({ code: "forbidden" });
      mocks.json.mockResolvedValueOnce({ processed: 1 });
      await expect(
        invokeOperation(
          "operations.processExports",
          { limit: 1 },
          { type: "cron", job: "operations-export" }
        )
      ).resolves.toEqual({ processed: 1 });
      expect(mocks.json).toHaveBeenLastCalledWith(
        "/api/jobs/operations/exports/process",
        {
          method: "POST",
          body: JSON.stringify({ limit: 1 }),
          headers: { authorization: "Bearer test-operations-secret" },
        }
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
