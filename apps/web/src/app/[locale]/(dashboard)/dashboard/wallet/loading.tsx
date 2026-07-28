/** 钱包路由加载骨架，仅占位资产卡、购买区与订单列表，不包含虚构财务数据。 */
export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl animate-pulse space-y-8">
      <div className="space-y-2">
        <div className="h-8 w-28 rounded bg-muted" />
        <div className="h-4 w-80 max-w-full rounded bg-muted" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="h-36 rounded-xl bg-muted" />
        <div className="h-36 rounded-xl bg-muted" />
      </div>
      <div className="h-72 rounded-xl bg-muted" />
      <div className="h-64 rounded-xl bg-muted" />
    </div>
  );
}
