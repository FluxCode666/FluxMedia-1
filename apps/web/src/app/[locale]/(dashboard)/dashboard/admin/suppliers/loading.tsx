/**
 * 供应商管理路由加载骨架。
 *
 * 使用方是独立供应商页面的 App Router loading 边界；骨架保持页面标题、统计卡和列表
 * 的层级，避免客户端导航期间把加载状态误认为空数据。
 */
const STAT_SKELETON_KEYS = ["groups", "members", "leases"];

export default function SuppliersLoading() {
  return (
    <main
      aria-busy="true"
      className="container mx-auto space-y-6 px-4 py-6 md:px-6"
      role="status"
    >
      <header className="space-y-2">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-4 w-72 max-w-full animate-pulse rounded bg-muted" />
      </header>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {STAT_SKELETON_KEYS.map((key) => (
          <div
            className="h-24 animate-pulse rounded-lg border bg-muted/30"
            key={key}
          />
        ))}
      </div>
      <div className="space-y-4 rounded-lg border p-6">
        <div className="h-10 w-64 animate-pulse rounded bg-muted" />
        <div className="h-40 w-full animate-pulse rounded bg-muted" />
      </div>
    </main>
  );
}
