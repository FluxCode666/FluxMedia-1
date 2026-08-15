/**
 * 运营导出 CSV 编码器的 DB-free 测试。
 *
 * 使用方：Vitest。锁定 UTF-8 BOM、RFC 4180 转义、公式注入防护和异步逐行输出，
 * 防止大范围导出退化为一次性内存拼接。
 */
import { describe, expect, it } from "vitest";

import { encodeOperationsCsvCell, streamOperationsCsv } from "./csv-encoder";

/** 收集测试中的异步字节流，生产 worker 不会执行该全量聚合。 */
async function collectCsv(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe("operations CSV encoder", () => {
  it("按 RFC 4180 转义逗号、引号与换行", () => {
    expect(encodeOperationsCsvCell("普通文本")).toBe("普通文本");
    expect(encodeOperationsCsvCell('甲,乙"丙\n丁')).toBe('"甲,乙""丙\n丁"');
  });

  it.each([
    "=1+1",
    "+cmd",
    "-2+3",
    "@SUM(A1)",
    "\t=1",
    "\r=1",
  ])("为公式前缀 %j 增加文本保护", (value) => {
    expect(encodeOperationsCsvCell(value)).toContain(`'${value}`);
  });

  it("输出 BOM、稳定表头和逐行 CRLF，空值不会变成字符串 null", async () => {
    async function* rows() {
      yield ["订单-1", "USD", 1234, null] as const;
      yield ["订单-2", "CNY", 8, undefined] as const;
    }

    const csv = await collectCsv(
      streamOperationsCsv({
        headers: ["订单 ID", "币种", "金额", "备注"],
        rows: rows(),
      })
    );

    expect(csv.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(csv.subarray(3).toString("utf8")).toBe(
      "订单 ID,币种,金额,备注\r\n订单-1,USD,1234,\r\n订单-2,CNY,8,\r\n"
    );
  });

  it("空导出仍包含 BOM 和表头", async () => {
    const rows: AsyncIterable<readonly []> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: true, value: undefined }),
        };
      },
    };
    const csv = await collectCsv(
      streamOperationsCsv({ headers: ["用户 ID"], rows })
    );
    expect(csv.toString("utf8")).toBe("﻿用户 ID\r\n");
  });
});
