/**
 * Lieflat 图表的键盘可展开等价数据表。
 *
 * 使用方：四张数据看板图表。原始日期、单位、任务数与百分比始终存在于语义化表格，
 * 不要求触摸、键盘或读屏用户依赖 SVG tooltip。
 */
import type { ReactNode } from "react";

type ChartDataTableProps = {
  label: string;
  caption: string;
  columns: readonly string[];
  rows: ReadonlyArray<readonly ReactNode[]>;
};

/** 渲染原生 details/table，浏览器无需客户端脚本即可操作。 */
export function ChartDataTable({
  label,
  caption,
  columns,
  rows,
}: ChartDataTableProps) {
  return (
    <details className="group border-t border-black/10 px-5 py-3 text-xs">
      <summary className="cursor-pointer select-none font-medium text-[var(--chart-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/50">
        {label}
      </summary>
      <div className="mt-3 max-h-64 overflow-auto rounded-lg border border-black/10">
        <table className="w-full border-collapse text-left tabular-nums">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-[var(--chart-paper)]">
            <tr>
              {columns.map((column) => (
                <th
                  className="border-b border-black/10 px-3 py-2 font-semibold"
                  key={column}
                  scope="col"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={String(row[0] ?? rowIndex)}>
                {row.map((cell, cellIndex) => (
                  <td
                    className="border-b border-black/5 px-3 py-2 last:text-right"
                    key={columns[cellIndex] ?? cellIndex}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
