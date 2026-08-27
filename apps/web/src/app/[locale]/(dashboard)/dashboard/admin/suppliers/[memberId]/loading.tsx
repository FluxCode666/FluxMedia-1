/** 供应商账号详情页的稳定加载骨架。 */
export default function DashboardAdminSupplierDetailLoading() {
  return (
    <main className="container mx-auto space-y-6 px-4 py-6 md:px-6">
      <div
        aria-busy="true"
        aria-label="正在加载账号详情"
        className="h-96 animate-pulse rounded-md border bg-muted/30"
        role="status"
      />
    </main>
  );
}
