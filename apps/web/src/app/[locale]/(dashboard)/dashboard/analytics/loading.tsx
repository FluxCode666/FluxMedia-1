/**
 * 用户数据看板路由级加载骨架。
 *
 * 使用方：Next.js App Router。保持标题、筛选器、六项指标与四图区域的稳定空间，减少
 * 首次导航布局偏移；不显示伪造业务数值。
 */
/** 渲染与最终报告网格同形的无数据骨架。 */
export default function DataDashboardLoading() {
  return (
    <div aria-busy="true" className="mx-auto max-w-7xl space-y-8 px-1 py-2">
      <div className="space-y-3">
        <div className="h-8 w-56 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="h-4 w-full max-w-xl animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <div className="h-10 w-full animate-pulse rounded-md bg-muted motion-reduce:animate-none sm:w-72" />
          <div className="h-10 w-full animate-pulse rounded-md bg-muted motion-reduce:animate-none sm:w-28" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {["images", "video", "credits", "rate", "days", "model"].map(
          (key) => (
          <div
            className="h-28 animate-pulse rounded-xl bg-muted motion-reduce:animate-none"
            key={key}
          />
          )
        )}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {["credits", "images", "videos", "composition"].map((key) => (
          <div
            className="h-[320px] animate-pulse rounded-xl bg-muted motion-reduce:animate-none"
            key={key}
          />
        ))}
      </div>
    </div>
  );
}
