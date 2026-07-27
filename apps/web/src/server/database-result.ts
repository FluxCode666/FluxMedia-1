/**
 * Drizzle 原始 SQL 返回值适配器。
 *
 * 职责：统一 node-postgres、Neon 与测试端口的 execute 返回形态，供服务端仓储在
 * 进入 Zod 校验前提取不可信行数组；本模块不解释或信任任何行字段。
 */

/**
 * 从 Drizzle execute 的不同返回形态中提取行数组。
 *
 * @param result 数据库驱动返回的不可信结果。
 * @returns 驱动直接返回的数组或 rows 数组；未知形态返回空数组。
 */
export function extractExecuteRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows: unknown }).rows;
    return Array.isArray(rows) ? rows : [];
  }
  return [];
}
