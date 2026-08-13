/**
 * API Key URL 分页状态测试。
 *
 * 使用方：Vitest；固定 key namespace、20 默认值和 10/20/50 白名单恢复行为。
 */
import { parsePaginationConfig } from "@repo/shared/pagination/config";
import { describe, expect, it } from "vitest";

import { parseExternalApiKeyPagination } from "./external-api-key-pagination";

const paginationConfig = parsePaginationConfig([10, 20, 50]);

describe("external API key pagination URL", () => {
  it("parses valid namespaced page and page size", () => {
    expect(
      parseExternalApiKeyPagination(
        { keyPage: "3", keyPageSize: "50" },
        paginationConfig
      )
    ).toEqual({ page: 3, pageSize: 50 });
  });

  it("recovers duplicated or non-whitelisted values to defaults", () => {
    expect(
      parseExternalApiKeyPagination(
        { keyPage: ["2"], keyPageSize: "100" },
        paginationConfig
      )
    ).toEqual({ page: 1, pageSize: 20 });
  });
});
