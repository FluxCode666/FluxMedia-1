/**
 * 支付概览路由加载骨架。
 *
 * 使用方：Next.js 软导航边界。保持页头、日期范围选择、摘要卡和图表高度，避免
 * 切换范围时页面布局跳动。
 */
export default function AdminPaymentsLoading() {
  return (
    <div className="container mx-auto space-y-6 px-4 py-6 md:px-6">
      <div className="space-y-3">
        <div className="h-3 w-28 animate-pulse rounded bg-muted" />
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-4 w-full max-w-2xl animate-pulse rounded bg-muted" />
      </div>
      <div className="h-24 animate-pulse rounded-lg border bg-muted/25" />
      <div className="grid gap-4 md:grid-cols-3">
        {["revenue", "orders", "days"].map((key) => (
          <div
            className="h-36 animate-pulse rounded-lg border bg-muted/25"
            key={key}
          />
        ))}
      </div>
      <div className="h-[500px] animate-pulse rounded-lg border bg-muted/25" />
    </div>
  );
}
