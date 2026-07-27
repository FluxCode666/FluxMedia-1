/**
 * 官网首页专属布局。
 *
 * 使用方：`/[locale]` 首页。
 * 关键边界：只复用 Header 与主内容容器，不渲染营销共享 Footer；首页唯一的
 * 合层 Footer 由页面正文负责。
 */
import { Header } from "@/features/marketing/components";

/**
 * 渲染首页专属站点框架。
 *
 * @param children - 首页服务端正文。
 * @returns 带首页导航变体且不附加第二个 Footer 的纵向布局。
 * @sideEffects 无。
 */
export default function HomeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="flex-1">{children}</main>
    </div>
  );
}
