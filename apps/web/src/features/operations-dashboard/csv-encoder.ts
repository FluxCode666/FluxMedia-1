/**
 * 运营总览异步导出的流式 CSV 编码器。
 *
 * 使用方：运营导出 worker。编码器只处理稳定列顺序、UTF-8 BOM、RFC 4180 与
 * 表格公式注入防护，不读取数据库或对象存储，因此可在 DB-free 测试中验证。
 */

/** CSV 单元格允许的可序列化原始值。 */
export type OperationsCsvCell = string | number | boolean | null | undefined;

const FORMULA_PREFIX_PATTERN = /^[=+\-@\t\r]/;
const CSV_QUOTE_PATTERN = /[",\r\n]/;
const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

/**
 * 按 RFC 4180 编码单个单元格，并把公式前缀固定为文本。
 *
 * @param value 可序列化的业务字段；null 和 undefined 导出为空字段。
 * @returns 可直接拼入一行 CSV 的安全文本。
 */
export function encodeOperationsCsvCell(value: OperationsCsvCell): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (FORMULA_PREFIX_PATTERN.test(text)) text = `'${text}`;
  if (!CSV_QUOTE_PATTERN.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

/** 把一行字段转换为以 CRLF 结尾的 UTF-8 字节。 */
function encodeOperationsCsvRow(
  values: readonly OperationsCsvCell[]
): Uint8Array {
  return Buffer.from(
    `${values.map(encodeOperationsCsvCell).join(",")}\r\n`,
    "utf8"
  );
}

/**
 * 流式输出完整 CSV。
 *
 * @param input 稳定表头和异步业务行；调用方负责列数与字段语义。
 * @returns 先 BOM、再表头、最后逐行业务数据的异步字节流。
 * @sideEffects 仅消费传入的异步 rows，不缓存全部行。
 */
export async function* streamOperationsCsv(input: {
  headers: readonly string[];
  rows: AsyncIterable<readonly OperationsCsvCell[]>;
}): AsyncGenerator<Uint8Array> {
  yield UTF8_BOM;
  yield encodeOperationsCsvRow(input.headers);
  for await (const row of input.rows) {
    if (row.length !== input.headers.length) {
      throw new RangeError("运营导出 CSV 列数不一致");
    }
    yield encodeOperationsCsvRow(row);
  }
}
