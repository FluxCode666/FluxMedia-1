/**
 * 站内生图标准尺寸与比例映射表。
 *
 * 公开 API 文档和系统文档共用此展示组件，确保尺寸枚举和映射说明不会因页面
 * 分叉而漂移；数据契约由 image-size-docs.ts 提供。
 */

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { cn } from "@repo/ui/utils";

export type ImageSizeTableContent = {
  title: string;
  description: string;
  headers: readonly string[];
  rows: readonly (readonly string[])[];
  note: string;
};

/**
 * 渲染站内生图标准尺寸与比例映射表。
 *
 * @param table 当前语言的尺寸表数据。
 * @returns 可横向滚动的语义表格；不改变尺寸选择或请求行为。
 */
export function ImageSizeTable({ table }: { table: ImageSizeTableContent }) {
  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle className="font-serif text-lg tracking-tight">
          {table.title}
        </CardTitle>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {table.description}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-muted/40 text-xs font-medium text-muted-foreground">
              <tr>
                {table.headers.map((header) => (
                  <th
                    className="whitespace-nowrap px-3 py-2 text-left font-medium"
                    key={header}
                    scope="col"
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr className="border-t" key={row[0]}>
                  {row.map((value, columnIndex) => (
                    <td
                      className={cn(
                        "whitespace-nowrap px-3 py-2.5",
                        columnIndex === 0
                          ? "font-medium text-foreground"
                          : "font-mono text-xs text-muted-foreground"
                      )}
                      key={`${row[0]}-${value}`}
                    >
                      {value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {table.note}
        </p>
      </CardContent>
    </Card>
  );
}
