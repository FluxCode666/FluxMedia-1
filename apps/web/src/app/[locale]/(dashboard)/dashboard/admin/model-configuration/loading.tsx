/**
 * 模型配置路由加载骨架。
 *
 * 使用方是独立模型配置页面的 App Router loading 边界；骨架保持主标题和首个内容卡片
 * 的视觉层级，并通过 aria-busy 告知辅助技术当前仍在读取服务端配置。
 */
export default function ModelConfigurationLoading() {
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
      <div className="space-y-4 rounded-lg border p-6">
        <div className="h-6 w-40 animate-pulse rounded bg-muted" />
        <div className="h-10 w-full animate-pulse rounded bg-muted" />
        <div className="h-40 w-full animate-pulse rounded bg-muted" />
      </div>
    </main>
  );
}
