/**
 * Dashboard 页面加载骨架屏。
 *
 * Next.js App Router 在页面数据获取时自动显示；结构与标题、账户支持、用量概览、
 * 模型占比和近期创作保持一致，减少切换时的布局跳动。
 */
/** 渲染与控制台实际布局对齐的无交互加载占位。 */
export default function DashboardLoading() {
  return (
    <div className="container mx-auto animate-pulse px-4 py-6 md:px-6 motion-reduce:animate-none">
      <div className="space-y-8">
        {/* 页面标题骨架:眉题 + 大号衬线标题 + 副行 */}
        <div className="space-y-2">
          <div className="h-3 w-14 rounded-md bg-muted" />
          <div className="h-9 w-44 rounded-md bg-muted" />
          <div className="h-4 w-56 rounded-md bg-muted" />
        </div>

        {/* 账户与官方支持双卡骨架 */}
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 2 }).map((_, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: 静态骨架无重排
              key={index}
              className="space-y-5 rounded-lg border border-border p-5"
            >
              <div className="h-3 w-28 rounded-md bg-muted" />
              <div className="flex items-center gap-4">
                <div className="size-20 shrink-0 rounded-lg bg-muted" />
                <div className="flex-1 space-y-3">
                  <div className="h-4 w-1/3 rounded-md bg-muted" />
                  <div className="h-3 w-2/3 rounded-md bg-muted" />
                  <div className="h-8 w-24 rounded-md bg-muted" />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Service & Support 列表骨架 */}
        <div className="space-y-4 rounded-lg border border-border p-5">
          <div className="h-5 w-40 rounded-md bg-muted" />
          <div className="grid gap-3 md:grid-cols-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: 静态骨架无重排
                key={index}
                className="flex items-center gap-4 rounded-lg border p-4"
              >
                <div className="size-10 shrink-0 rounded-md bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-1/3 rounded-md bg-muted" />
                  <div className="h-3 w-3/4 rounded-md bg-muted" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 用量概览统计骨架 */}
        <div className="space-y-3">
          <div className="h-5 w-28 rounded-md bg-muted" />
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, cardIndex) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: 静态骨架无重排
                key={cardIndex}
                className="space-y-4 rounded-lg border border-border p-6"
              >
                <div className="flex items-center justify-between">
                  <div className="h-3 w-24 rounded-md bg-muted" />
                  <div className="h-4 w-4 rounded-full bg-muted" />
                </div>
                <div className="space-y-2">
                  <div className="h-9 w-24 rounded-md bg-muted" />
                  <div className="h-3 w-3/4 rounded-md bg-muted" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 模型占比与近期创作骨架 */}
        <div className="grid gap-4 xl:grid-cols-[minmax(340px,.9fr)_minmax(0,1.7fr)]">
          <div className="space-y-4 rounded-lg border border-border p-6">
            <div className="h-5 w-32 rounded-md bg-muted" />
            <div className="h-[240px] w-full rounded-md bg-muted" />
          </div>
          <div className="rounded-lg border border-border p-6">
            <div className="mb-4 flex items-center justify-between">
              <div className="h-6 w-32 rounded-md bg-muted" />
              <div className="h-8 w-20 rounded-md bg-muted" />
            </div>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: 静态骨架无重排
                  key={index}
                  className="aspect-square rounded-lg bg-muted"
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
