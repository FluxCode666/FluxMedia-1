/**
 * Web SPA 入口。
 *
 * 由 Go backend 同源托管的 index.html 加载；路由树由 src/app 目录约定生成，
 * refreshRoutes()（原 router.refresh / revalidatePath）统一映射为重新执行当前路由 loader。
 */
import "@repo/ui/globals.css";

import { initSentryClient } from "@repo/shared/monitoring";
import { subscribeRouteRefresh } from "@repo/shared/platform/navigation";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";

import { createAppRoutes } from "@/platform/routes";

initSentryClient();

const router = createBrowserRouter(createAppRoutes());
subscribeRouteRefresh(() => {
  void router.revalidate();
});

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root container");

createRoot(container).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
