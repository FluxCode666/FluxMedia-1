/**
 * 分组管理路由加载骨架。
 *
 * 使用方是独立分组页面的 App Router loading 边界；骨架保留标题、工具栏、筛选和
 * 语义列表层级，避免客户端导航期间把加载状态误认为空数据。
 */
export default function SupplierGroupsLoading() {
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
      <div className="flex justify-end">
        <div className="h-9 w-24 animate-pulse rounded bg-muted" />
      </div>
      <div className="h-20 animate-pulse rounded-lg border bg-muted/30" />
      <div className="h-64 animate-pulse rounded-lg border bg-muted/30" />
    </main>
  );
}
