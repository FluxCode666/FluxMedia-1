/**
 * 非首页营销路由的共享布局。
 *
 * 使用方：Blog、API Docs、法律页、PSEO 与 Demo。
 * 关键边界：保留共享 Header 与独立 Footer，不承载 sibling `(home)` 首页。
 * 注意：不要在本布局引入 fumadocs-ui/style.css。它自带一套 @layer utilities，
 * 会覆盖响应式 Header 工具类；该样式只在需要的内容页局部引入。
 */
import { Footer, Header } from "@/features/marketing/components";

/**
 * 渲染非首页营销页面的共享站点框架。
 *
 * @param children - 当前营销子路由的服务端页面内容。
 * @returns 带营销 Header 与独立 Footer 的纵向布局。
 * @sideEffects 无。
 */
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}
