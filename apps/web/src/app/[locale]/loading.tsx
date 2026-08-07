/**
 * locale 路由组的兜底加载骨架。
 *
 * 使用方：跨 dashboard、营销、认证与文档布局切换时的 Next.js App Router 边界。
 * 具体页面若有更近的 loading.tsx，会优先渲染自身结构化骨架。
 */

/** 渲染不依赖数据的中性页面骨架，避免跨布局切换出现空白视图。 */
export default function LocaleLoading() {
  return (
    <div
      aria-hidden="true"
      className="min-h-screen animate-pulse bg-background motion-reduce:animate-none"
    >
      <div className="container space-y-8 px-4 py-16 md:px-6">
        <div className="h-4 w-24 rounded bg-muted" />
        <div className="h-12 w-2/3 max-w-xl rounded bg-muted" />
        <div className="h-4 w-full max-w-2xl rounded bg-muted" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {["one", "two", "three"].map((key) => (
            <div className="h-48 rounded-lg border bg-muted/50" key={key} />
          ))}
        </div>
      </div>
    </div>
  );
}
