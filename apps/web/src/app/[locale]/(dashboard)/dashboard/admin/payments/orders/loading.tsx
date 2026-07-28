/**
 * 充值订单管理路由加载骨架。
 *
 * 使用方：Next.js 软导航边界。固定筛选栏和表格主体高度，减少筛选或翻页时的布局
 * 跳动。
 */
export default function AdminPaymentOrdersLoading() {
  return (
    <div className="container mx-auto space-y-6 px-4 py-6 md:px-6">
      <div className="space-y-3">
        <div className="h-3 w-28 animate-pulse rounded bg-muted" />
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-4 w-full max-w-2xl animate-pulse rounded bg-muted" />
      </div>
      <div className="h-28 animate-pulse rounded-lg border bg-muted/25" />
      <div className="h-[580px] animate-pulse rounded-lg border bg-muted/25" />
    </div>
  );
}
