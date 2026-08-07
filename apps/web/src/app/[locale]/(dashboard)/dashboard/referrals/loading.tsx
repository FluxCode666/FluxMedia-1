/**
 * 推广页面加载骨架。
 *
 * 使用方：推广服务端数据读取期间的 Dashboard 路由边界；布局尺寸对应邀请统计、链接
 * 卡片和近期邀请列表，不虚构业务数据。
 */

/** 渲染推广看板的结构化加载占位。 */
export default function ReferralsLoading() {
  return (
    <div
      aria-hidden="true"
      className="animate-pulse space-y-6 motion-reduce:animate-none"
    >
      <div className="space-y-2">
        <div className="h-8 w-32 rounded bg-muted" />
        <div className="h-4 w-72 max-w-full rounded bg-muted" />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {["one", "two", "three"].map((key) => (
          <div className="h-28 rounded-lg border bg-background" key={key} />
        ))}
      </div>
      <div className="space-y-5 rounded-lg border bg-background p-6">
        <div className="h-5 w-32 rounded bg-muted" />
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="h-9 flex-1 rounded bg-muted" />
          <div className="h-9 w-24 rounded bg-muted" />
        </div>
        <div className="h-3 w-64 max-w-full rounded bg-muted" />
      </div>
      <div className="space-y-4 rounded-lg border bg-background p-6">
        <div className="h-5 w-40 rounded bg-muted" />
        {["one", "two", "three"].map((key) => (
          <div className="h-12 rounded bg-muted/60" key={key} />
        ))}
      </div>
    </div>
  );
}
