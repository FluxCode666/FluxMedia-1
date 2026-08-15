/**
 * 运营趋势和矩阵图的完整等价数据表组件。
 *
 * 使用方：本目录所有图。表格不使用视觉降采样，所有真实桶和特殊状态均按
 * 原顺序保留；折叠只影响视觉占用，不影响屏幕阅读器访问表格语义。
 */
import type { ReactNode } from "react";

export type OperationsChartDataTableColumn<Row> = {
  key: string;
  label: string;
  align?: "left" | "right";
  render: (row: Row) => ReactNode;
};

export type OperationsChartDataTableProps<Row> = {
  caption: string;
  openLabel: string;
  rows: readonly Row[];
  rowKey: (row: Row, index: number) => string;
  columns: readonly OperationsChartDataTableColumn<Row>[];
};

/**
 * 渲染可展开的完整等价数据表。
 *
 * @param props 表题、展开文案、完整行、稳定行键和列定义。
 * @returns 原生 details 与 table；空数组时仍保留表头和 caption。
 */
export function OperationsChartDataTable<Row>({
  caption,
  columns,
  openLabel,
  rowKey,
  rows,
}: OperationsChartDataTableProps<Row>) {
  return (
    <details className="rounded-lg border border-[#1C1C1A]/15 bg-card">
      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-[#55554F] outline-none focus-visible:ring-2 focus-visible:ring-[#1C1C1A]">
        {openLabel}
      </summary>
      <div className="max-h-80 overflow-auto border-t border-[#1C1C1A]/15">
        <table className="w-full min-w-[32rem] border-collapse text-xs">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-[#1C1C1A]/15">
              {columns.map((column) => (
                <th
                  className={
                    column.align === "right"
                      ? "px-3 py-2 text-right font-semibold"
                      : "px-3 py-2 text-left font-semibold"
                  }
                  key={column.key}
                  scope="col"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                className="border-b border-[#1C1C1A]/10 last:border-0"
                key={rowKey(row, index)}
              >
                {columns.map((column, columnIndex) => {
                  const cellClassName =
                    column.align === "right"
                      ? "px-3 py-2 text-right font-mono tabular-nums"
                      : "px-3 py-2 text-left";
                  if (columnIndex === 0) {
                    return (
                      <th
                        className={cellClassName}
                        key={column.key}
                        scope="row"
                      >
                        {column.render(row)}
                      </th>
                    );
                  }
                  return (
                    <td className={cellClassName} key={column.key}>
                      {column.render(row)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
