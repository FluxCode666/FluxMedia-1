/**
 * 模型广场加载骨架。
 *
 * 使用方：Models 页面首次进入或筛选路由切换；该页需要读取运行时模型目录，使用
 * 与真实页面一致的头部和卡片形状，降低动态查询期间的空白与布局跳动。
 */

/** 渲染公开模型广场的结构化加载占位。 */
export default function ModelsLoading() {
  return (
    <div
      aria-hidden="true"
      className="animate-pulse border-b bg-background motion-reduce:animate-none"
    >
      <section className="border-b border-border/60 bg-muted/20">
        <div className="container space-y-5 px-4 py-16 sm:py-20 lg:py-24">
          <div className="h-3 w-32 rounded bg-muted" />
          <div className="h-14 w-2/3 max-w-3xl rounded bg-muted" />
          <div className="h-4 w-full max-w-2xl rounded bg-muted" />
          <div className="h-4 w-5/6 max-w-xl rounded bg-muted" />
        </div>
      </section>
      <section className="container space-y-6 px-4 py-10 sm:py-14 lg:py-16">
        <div className="flex items-center justify-between gap-4">
          <div className="h-9 w-56 rounded bg-muted" />
          <div className="h-9 w-28 rounded bg-muted" />
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {["one", "two", "three", "four", "five", "six"].map((key) => (
            <div className="overflow-hidden rounded-xl border" key={key}>
              <div className="aspect-[4/3] bg-muted" />
              <div className="space-y-3 p-4">
                <div className="h-5 w-2/3 rounded bg-muted" />
                <div className="h-3 w-full rounded bg-muted" />
                <div className="h-3 w-4/5 rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
