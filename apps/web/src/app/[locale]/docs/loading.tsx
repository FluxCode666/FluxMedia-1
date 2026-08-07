/**
 * 管理文档路由的加载骨架。
 *
 * 使用方：Fumadocs 文档布局与系统文档数据读取期间；保留顶部、侧栏和正文比例，
 * 避免鉴权或文档数据等待期间出现旧页面空白。
 */

const DOCS_NAV_SKELETON_KEYS = [
  "overview",
  "getting-started",
  "authentication",
  "models",
  "generation",
  "tasks",
  "errors",
] as const;

const DOCS_LINE_SKELETONS = [
  "100%",
  "83%",
  "96%",
  "74%",
  "89%",
  "68%",
  "94%",
  "79%",
  "86%",
] as const;

/** 渲染文档阅读区的结构化加载占位。 */
export default function DocsLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading documentation"
      className="container grid min-h-[60vh] gap-8 px-4 py-8 md:grid-cols-[220px_minmax(0,1fr)] md:px-6 md:py-12"
      role="status"
    >
      <aside className="hidden space-y-3 md:block">
        {DOCS_NAV_SKELETON_KEYS.map((key) => (
          <div
            className="h-4 animate-pulse rounded bg-muted motion-reduce:animate-none"
            key={key}
          />
        ))}
      </aside>
      <main className="max-w-3xl space-y-6">
        <div className="h-10 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        <div className="space-y-3">
          {DOCS_LINE_SKELETONS.map((width) => (
            <div
              className="h-4 animate-pulse rounded bg-muted motion-reduce:animate-none"
              key={width}
              style={{ width }}
            />
          ))}
        </div>
      </main>
    </div>
  );
}
