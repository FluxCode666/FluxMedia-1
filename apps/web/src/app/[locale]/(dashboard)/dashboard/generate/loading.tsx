/**
 * 简易生图页加载骨架。
 *
 * 使用方：Next.js App Router 在额度、授权模型目录和近期图片就绪前自动渲染。
 */

/**
 * 渲染与旧版统一生图卡片尺寸接近的静态占位。
 *
 * @returns 不包含交互与外部副作用的加载骨架。
 */
export default function GenerateLoading() {
  return (
    <div className="container mx-auto max-w-5xl animate-pulse motion-reduce:animate-none px-4 py-8 md:px-6 md:py-12">
      <div className="overflow-hidden rounded-2xl border bg-background shadow-sm">
        <div className="space-y-4 p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="h-4 w-20 rounded bg-muted" />
            <div className="h-6 w-16 rounded-full bg-muted" />
          </div>
          <div className="h-32 rounded-xl bg-muted" />
          <div className="h-12 border-t pt-3">
            <div className="h-8 w-32 rounded-full bg-muted" />
          </div>
        </div>
        <div className="space-y-4 border-t bg-muted/20 p-4 sm:p-5">
          <div className="h-4 w-20 rounded bg-muted" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="h-9 rounded bg-muted sm:col-span-2" />
            <div className="h-9 rounded bg-muted" />
            <div className="h-9 rounded bg-muted" />
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t px-4 py-3 sm:px-5">
          <div className="h-4 w-40 rounded bg-muted" />
          <div className="h-9 w-28 rounded bg-muted" />
        </div>
      </div>
    </div>
  );
}
