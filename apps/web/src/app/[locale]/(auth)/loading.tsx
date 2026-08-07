/**
 * 认证路由组的加载骨架。
 *
 * 使用方：登录、注册、找回密码与重置密码页面。认证布局保持不变，只占位表单卡片
 * 内容，避免服务端读取配置或查询参数时出现空白。
 */

/** 渲染与认证卡片尺寸一致的静态加载占位。 */
export default function AuthLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading authentication page"
      className="space-y-6"
      role="status"
    >
      <div className="mx-auto h-8 w-40 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      <div className="space-y-3">
        <div className="h-10 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="h-10 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="h-10 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      </div>
      <div className="mx-auto h-4 w-32 animate-pulse rounded bg-muted motion-reduce:animate-none" />
    </div>
  );
}
