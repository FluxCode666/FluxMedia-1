/**
 * 营销路由组的通用加载骨架。
 *
 * 使用方：API 文档、博客、法律文档与 PSEO 页面；模型广场有更近的专用骨架时优先
 * 使用专用结构，其他页面统一提供首屏占位，避免跨页面切换停留在旧内容。
 */

/** 渲染营销页首屏与正文卡片的中性加载占位。 */
export default function MarketingLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading page"
      className="animate-pulse bg-background motion-reduce:animate-none"
      role="status"
    >
      <section className="border-b border-border/60 bg-muted/20">
        <div className="container space-y-5 px-4 py-16 sm:py-20 lg:py-24">
          <div className="h-3 w-28 rounded bg-muted" />
          <div className="h-12 w-2/3 max-w-2xl rounded bg-muted" />
          <div className="h-4 w-full max-w-2xl rounded bg-muted" />
        </div>
      </section>
      <section className="container space-y-5 px-4 py-10 sm:py-14">
        <div className="h-7 w-48 rounded bg-muted" />
        <div className="grid gap-5 md:grid-cols-2">
          {["one", "two", "three", "four"].map((key) => (
            <div className="h-40 rounded-xl border bg-muted/50" key={key} />
          ))}
        </div>
      </section>
    </div>
  );
}
