/**
 * 管理端数据看板加载骨架。
 *
 * 使用方：App Router 在管理员看板服务端聚合期间立即展示；结构对齐页头、指标卡和
 * 四张图表，避免客户端导航停留在旧页。
 */
const METRIC_KEYS = ["images", "videos", "seconds", "tasks"];
const CHART_KEYS = ["image", "credits", "video", "composition"];

/** 渲染管理员全局数据看板的静态加载占位。 */
export default function AdminDataDashboardLoading() {
  return (
    <div className="container mx-auto animate-pulse space-y-8 px-4 py-6 motion-reduce:animate-none md:px-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <div className="h-7 w-48 rounded bg-muted" />
          <div className="h-4 w-96 max-w-full rounded bg-muted" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-9 w-64 rounded bg-muted" />
          <div className="h-9 w-20 rounded bg-muted" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {METRIC_KEYS.map((key) => (
          <div className="space-y-3 rounded-lg border p-5" key={key}>
            <div className="h-4 w-24 rounded bg-muted" />
            <div className="h-8 w-20 rounded bg-muted" />
            <div className="h-3 w-32 rounded bg-muted" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {CHART_KEYS.map((key) => (
          <div className="h-[370px] rounded-xl border bg-muted/20" key={key} />
        ))}
      </div>
    </div>
  );
}
