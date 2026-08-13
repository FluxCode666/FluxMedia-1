/**
 * 管理端运营总览加载骨架。
 *
 * 使用方：App Router 在 session、URL 与单一 UOL 快照解析期间立即展示。
 */
const METRIC_KEYS = ["total", "new", "login", "creation", "d1", "d7"];
const MODULE_KEYS = ["growth", "commercial", "content", "health"];

/** 渲染与增长优先纵向布局一致的静态占位。 */
export default function OperationsDashboardLoading() {
  return (
    <main className="container mx-auto animate-pulse space-y-8 px-4 py-6 motion-reduce:animate-none md:px-6">
      <header className="space-y-3">
        <div className="h-8 w-40 rounded bg-muted" />
        <div className="h-4 w-full max-w-xl rounded bg-muted" />
        <div className="flex flex-wrap gap-2 pt-2">
          <div className="h-9 w-72 max-w-full rounded bg-muted" />
          <div className="h-9 w-44 rounded bg-muted" />
        </div>
      </header>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {METRIC_KEYS.map((key) => (
          <div className="h-28 rounded-xl border bg-muted/20" key={key} />
        ))}
      </div>
      <div className="space-y-5">
        {MODULE_KEYS.map((key) => (
          <div className="h-72 rounded-xl border bg-muted/20" key={key} />
        ))}
      </div>
    </main>
  );
}
