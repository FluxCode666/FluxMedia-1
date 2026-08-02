/**
 * 已接受 API 视频任务的执行错误分类测试。
 *
 * 职责：锁定平台容量、网络传输与管理员适配错误的连续失败计数边界；测试替换
 * 通用执行器，不访问数据库、Worker 或供应商网络。
 */
import {
  type ApiUpstreamAdapterDraft,
  createDefaultApiUpstreamOperations,
} from "@repo/shared/image-backend/api-upstream-adaptation";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeApiUpstreamOperation: vi.fn(),
}));

vi.mock(
  "@/features/image-backend-pool/api-upstream-executor",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/features/image-backend-pool/api-upstream-executor")
      >();
    return {
      ...actual,
      executeApiUpstreamOperation: mocks.executeApiUpstreamOperation,
    };
  }
);

vi.mock("@/features/image-backend-pool/media-upstream-fetch", () => ({
  fetchMediaUpstreamDownloadWithTrustedOrigin: vi.fn(),
  MAX_VIDEO_UPSTREAM_DOWNLOAD_BYTES: 512 * 1024 * 1024,
}));

import { ApiUpstreamExecutionError } from "@/features/image-backend-pool/api-upstream-executor";

import { pollApiVideoRequest } from "./api-video";
import type { ApiConfig } from "./types";

/** 构造只用于错误分类、不会外呼的固定视频适配配置。 */
function createConfig(): ApiConfig {
  const adapter: ApiUpstreamAdapterDraft = {
    baseUrl: "https://video.example.com/v1",
    useStream: false,
    modelMappings: [],
    authentication: { mode: "bearer" },
    credentialScope: "https://video.example.com|bearer",
    operations: createDefaultApiUpstreamOperations(),
  };
  return {
    baseUrl: adapter.baseUrl,
    apiKey: "provider-key",
    model: "seedance2",
    backend: {
      type: "pool-api",
      apiUpstreamAdapter: adapter,
      modelMappings: [],
    },
  };
}

describe("accepted API video execution failure classification", () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    { code: "platform_busy", countsTowardAdapterFailure: false },
    { code: "transport_failed", countsTowardAdapterFailure: false },
    { code: "invalid_configuration", countsTowardAdapterFailure: true },
    { code: "request_script_failed", countsTowardAdapterFailure: true },
    { code: "response_read_failed", countsTowardAdapterFailure: true },
    { code: "response_script_failed", countsTowardAdapterFailure: true },
  ] as const)("$code 的连续适配失败计数为 $countsTowardAdapterFailure", async ({
    code,
    countsTowardAdapterFailure,
  }) => {
    mocks.executeApiUpstreamOperation.mockRejectedValueOnce(
      new ApiUpstreamExecutionError(
        code,
        code === "transport_failed" ? "transport_uncertain" : "before_send"
      )
    );

    await expect(
      pollApiVideoRequest(createConfig(), "upstream-task-1", {
        trustedOrigin: "https://video.example.com",
      })
    ).rejects.toMatchObject({
      retryable: true,
      countsTowardAdapterFailure,
    });
  });
});
