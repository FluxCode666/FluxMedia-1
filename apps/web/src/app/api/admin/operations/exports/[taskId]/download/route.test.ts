/**
 * 运营导出下载路由的 UOL 薄适配与流式响应测试。
 *
 * 使用方：Vitest。验证路由只构造 Principal、调用统一 operation、映射稳定错误并
 * 在取消或读取失败时正确关闭 Web 流，不再直接访问领域服务、仓储或存储 provider。
 */
import { OperationError } from "@repo/shared/uol";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureUolInitialized: vi.fn(),
  getSession: vi.fn(),
  getRole: vi.fn(),
  invokeOperation: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@repo/shared/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("@repo/shared/auth/role-server", () => ({
  getUserRoleById: mocks.getRole,
}));
vi.mock("@repo/shared/logger", () => ({ logError: mocks.logError }));
vi.mock("@repo/shared/uol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/shared/uol")>();
  return { ...actual, invokeOperation: mocks.invokeOperation };
});
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureUolInitialized,
}));

import { GET } from "./route";

/** 创建默认成功字节流。 */
function createCsvStream(): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield Buffer.from("a,b\r\n");
  })();
}

/** 调用动态路由，可注入取消信号和外部请求标识。 */
function call(signal?: AbortSignal) {
  return GET(
    new Request(
      "http://localhost/api/admin/operations/exports/task-1/download",
      {
        headers: { "x-request-id": "external-request-1" },
        signal,
      }
    ) as never,
    { params: Promise.resolve({ taskId: "task-1" }) }
  );
}

describe("operations export download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: "admin-1" } });
    mocks.getRole.mockResolvedValue("admin");
    mocks.ensureUolInitialized.mockResolvedValue(undefined);
    mocks.invokeOperation.mockResolvedValue({
      taskId: "task-1",
      filename: "operations-user_growth-task-1.csv",
      contentType: "text/csv; charset=utf-8",
      stream: createCsvStream(),
    });
  });

  it("匿名请求不初始化或调用 UOL", async () => {
    mocks.getSession.mockResolvedValueOnce(null);

    expect((await call()).status).toBe(401);
    expect(mocks.ensureUolInitialized).not.toHaveBeenCalled();
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("构造 Principal 后只调用本地下载 operation 并流式返回 CSV", async () => {
    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="operations-user_growth-task-1.csv"'
    );
    await expect(response.text()).resolves.toBe("a,b\r\n");
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "operations.openLocalExportDownload",
      { taskId: "task-1" },
      {
        type: "user",
        userId: "admin-1",
        role: "admin",
      },
      { externalRequestId: "external-request-1" }
    );
  });

  it("由 UOL 单点拒绝普通用户并保留稳定 HTTP 状态", async () => {
    mocks.getRole.mockResolvedValueOnce("user");
    mocks.invokeOperation.mockRejectedValueOnce(
      new OperationError("forbidden", "Forbidden", undefined, 403)
    );

    const response = await call();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Forbidden",
      code: "forbidden",
    });
  });

  it("任务不存在或远端 provider 冲突时映射 UOL 错误", async () => {
    mocks.invokeOperation.mockRejectedValueOnce(
      new OperationError("not_found", "Not found", undefined, 404)
    );
    expect((await call()).status).toBe(404);

    mocks.invokeOperation.mockRejectedValueOnce(
      new OperationError("conflict", "Use signed URL", undefined, 409)
    );
    expect((await call()).status).toBe(409);
  });

  it("客户端取消下载时关闭底层异步迭代器", async () => {
    const iterator = {
      next: vi.fn().mockResolvedValue({
        done: false,
        value: Buffer.from("a,b\r\n"),
      }),
      return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
    };
    mocks.invokeOperation.mockResolvedValueOnce({
      taskId: "task-1",
      filename: "operations-user_growth-task-1.csv",
      contentType: "text/csv; charset=utf-8",
      stream: { [Symbol.asyncIterator]: () => iterator },
    });
    const response = await call();

    await response.body?.cancel();

    expect(iterator.return).toHaveBeenCalledTimes(1);
  });

  it("底层异步迭代器异常会传播给响应读取方", async () => {
    const streamError = new Error("stream interrupted");
    mocks.invokeOperation.mockResolvedValueOnce({
      taskId: "task-1",
      filename: "operations-user_growth-task-1.csv",
      contentType: "text/csv; charset=utf-8",
      stream: {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn().mockRejectedValue(streamError),
          return: vi.fn().mockResolvedValue({
            done: true,
            value: undefined,
          }),
        }),
      },
    });
    const response = await call();
    const reader = response.body?.getReader();

    await expect(reader?.read()).rejects.toThrow("stream interrupted");
  });

  it("请求在读取前已取消时关闭底层异步迭代器", async () => {
    const controller = new AbortController();
    controller.abort();
    const iterator = {
      next: vi.fn().mockResolvedValue({
        done: false,
        value: Buffer.from("a,b\r\n"),
      }),
      return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
    };
    mocks.invokeOperation.mockResolvedValueOnce({
      taskId: "task-1",
      filename: "operations-user_growth-task-1.csv",
      contentType: "text/csv; charset=utf-8",
      stream: { [Symbol.asyncIterator]: () => iterator },
    });
    const response = await call(controller.signal);

    await expect(response.text()).resolves.toBe("");
    expect(iterator.next).not.toHaveBeenCalled();
    expect(iterator.return).toHaveBeenCalledTimes(1);
  });

  it("未知异常记录安全上下文并返回 503", async () => {
    mocks.invokeOperation.mockRejectedValueOnce(new Error("storage details"));

    const response = await call();

    expect(response.status).toBe(503);
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        source: "operations-export-local-download",
        taskId: "task-1",
      })
    );
  });
});
