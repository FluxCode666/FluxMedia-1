/**
 * 运营导出存储流测试。
 *
 * 使用方：U6 导出 worker。验证统计包装器不会缓存完整文件，并对上传字节计算稳定
 * SHA-256、行数和字节数。
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { streamOperationsCsv } from "./csv-encoder";
import { createMeasuredExportStream } from "./export-storage";

/** 构造会在每次 pull 后记录进度的异步字节流。 */
async function* chunks(progress: number[]): AsyncGenerator<Uint8Array> {
  for (const value of ["a\r\n", "b\r\n", "c\r\n"]) {
    progress.push(progress.length + 1);
    yield Buffer.from(value);
  }
}

describe("createMeasuredExportStream", () => {
  it("逐块透传并在消费完成后返回校验和、业务行数和字节数", async () => {
    const progress: number[] = [];
    const measured = createMeasuredExportStream(chunks(progress), {
      headerRows: 1,
    });
    expect(progress).toEqual([]);

    const output: Uint8Array[] = [];
    for await (const chunk of measured.stream) output.push(chunk);

    const bytes = Buffer.concat(output);
    expect(bytes.toString("utf8")).toBe("a\r\nb\r\nc\r\n");
    expect(progress).toEqual([1, 2, 3]);
    await expect(measured.result).resolves.toEqual({
      byteCount: bytes.length,
      checksumSha256: createHash("sha256").update(bytes).digest("hex"),
      rowCount: 2,
    });
  });

  it("上游失败时拒绝统计结果而不是发布部分文件", async () => {
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("header\r\n");
      throw new Error("source failed");
    }
    const measured = createMeasuredExportStream(failing(), { headerRows: 1 });
    await expect(async () => {
      for await (const _chunk of measured.stream) {
        // 仅消费流以触发上游错误。
      }
    }).rejects.toThrow("source failed");
    await expect(measured.result).rejects.toThrow("source failed");
  });

  it("字段内换行不增加业务行数，且跨 chunk 引号状态保持正确", async () => {
    const csv = streamOperationsCsv({
      headers: ["用户 ID", "名称"],
      rows: (async function* () {
        yield ["user-1", '第一行\n第二行且含"引号"'];
        yield ["user-2", "普通名称"];
      })(),
    });
    async function* splitSource(): AsyncGenerator<Uint8Array> {
      for await (const chunk of csv) {
        for (let offset = 0; offset < chunk.length; offset += 3) {
          yield chunk.subarray(offset, offset + 3);
        }
      }
    }
    const measured = createMeasuredExportStream(splitSource(), {
      headerRows: 1,
    });
    for await (const _chunk of measured.stream) {
      // 消费拆分后的完整流以完成统计。
    }
    await expect(measured.result).resolves.toMatchObject({ rowCount: 2 });
  });
});
