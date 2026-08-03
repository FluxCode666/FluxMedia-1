/**
 * 控制台接入文档的路由级加载骨架。
 *
 * 在服务端会话和文档内容解析期间保持页面结构稳定，不读取数据或触发副作用。
 */

/** 渲染与接入文档标题、入口信息和端点卡片对应的加载占位。 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-7xl animate-pulse space-y-8 py-12 md:py-16">
      <div className="max-w-3xl space-y-3">
        <div className="h-3 w-24 rounded bg-muted" />
        <div className="h-10 w-64 max-w-full rounded bg-muted" />
        <div className="h-5 w-full rounded bg-muted" />
        <div className="h-5 w-3/4 rounded bg-muted" />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="h-20 rounded-lg bg-muted" />
        <div className="h-20 rounded-lg bg-muted" />
      </div>
      <div className="grid gap-8 lg:grid-cols-[15.5rem_minmax(0,1fr)]">
        <div className="h-80 rounded-2xl bg-muted" />
        <div className="space-y-8">
          <div className="h-72 rounded-lg bg-muted" />
          <div className="h-72 rounded-lg bg-muted" />
        </div>
      </div>
    </div>
  );
}
