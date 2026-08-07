/**
 * 支付结果页面加载骨架。
 *
 * 使用方：订单状态客户端视图加载前的路由边界与页面内 Suspense fallback；保留支付
 * 状态卡的形状，让回跳、冷启动和慢网络下都有可见反馈。
 */

/** 渲染支付状态卡片的中性加载占位。 */
export default function CreditPaymentResultLoading() {
  return (
    <main
      aria-hidden="true"
      className="mx-auto max-w-xl animate-pulse px-4 py-10 motion-reduce:animate-none"
    >
      <div className="mb-5 h-8 w-32 rounded bg-muted" />
      <div className="space-y-6 rounded-lg border bg-background p-6 sm:p-8">
        <div className="mx-auto size-14 rounded-full bg-muted" />
        <div className="space-y-3 text-center">
          <div className="mx-auto h-6 w-32 rounded-full bg-muted" />
          <div className="mx-auto h-8 w-56 max-w-full rounded bg-muted" />
          <div className="mx-auto h-4 w-full max-w-sm rounded bg-muted" />
        </div>
        <div className="space-y-3 rounded-md border p-4">
          <div className="h-4 w-full rounded bg-muted" />
          <div className="h-4 w-full rounded bg-muted" />
          <div className="h-4 w-4/5 rounded bg-muted" />
        </div>
        <div className="h-10 w-full rounded bg-muted" />
      </div>
    </main>
  );
}
