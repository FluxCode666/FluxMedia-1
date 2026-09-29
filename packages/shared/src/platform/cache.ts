/**
 * 数据失效入口。
 *
 * 使用方：Action 在写操作成功后声明页面数据已过期。SPA 没有服务端缓存，
 * 统一退化为让当前挂载的路由重新执行加载函数。
 */
import { refreshRoutes } from "./navigation";

/** 标记路径数据过期；当前挂载的页面会重新加载。 */
export function revalidatePath(_path: string, _type?: "page" | "layout"): void {
  queueMicrotask(refreshRoutes);
}

/** 标记缓存标签过期；当前挂载的页面会重新加载。 */
export function revalidateTag(_tag: string): void {
  queueMicrotask(refreshRoutes);
}

export const updateTag = revalidateTag;
