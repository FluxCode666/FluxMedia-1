/**
 * 官网首页加载骨架。
 *
 * 使用方：首页动态数据装配期间的 `(home)` 路由边界；占位首页首屏、特性与内容卡片，
 * 让用户先看到目标页面结构，再等待服务端数据替换。
 */

/** 渲染官网首页首屏的结构化加载占位。 */
export default function HomeLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading homepage"
      className="animate-pulse bg-background motion-reduce:animate-none"
      role="status"
    >
      <section className="border-b border-border/60 bg-muted/20">
        <div className="container space-y-6 px-4 py-20 sm:py-28 lg:py-36">
          <div className="h-4 w-28 rounded bg-muted" />
          <div className="h-16 w-full max-w-3xl rounded bg-muted" />
          <div className="h-5 w-full max-w-2xl rounded bg-muted" />
          <div className="h-11 w-36 rounded-md bg-muted" />
        </div>
      </section>
      <section className="container space-y-6 px-4 py-12 sm:py-16">
        <div className="mx-auto h-8 w-48 rounded bg-muted" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {["one", "two", "three"].map((key) => (
            <div className="h-44 rounded-xl border bg-muted/50" key={key} />
          ))}
        </div>
      </section>
    </div>
  );
}
