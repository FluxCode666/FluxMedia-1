/**
 * 简易生图菜单页路由。
 *
 * 使用方：控制台侧边栏的“简易生图”入口。
 * 关键依赖：复用既有创作页的服务端数据装配，客户端根据当前路由仅渲染合并式生图工作区；
 * 旧创作页继续保留在 /dashboard/create，且不再作为菜单入口。
 */
import CreatePage from "../create/page";

/**
 * 渲染独立的简易生图页面。
 *
 * @returns 与旧创作页共用鉴权、额度、模型目录及近期生成数据的服务端页面。
 * @sideEffects 无；数据读取由被复用的服务端页面处理。
 */
export default function GeneratePage() {
  return <CreatePage />;
}
