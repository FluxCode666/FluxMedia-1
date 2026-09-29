import { usePathname } from "@repo/shared/platform/navigation";
import { useCallback, useEffect, useState } from "react";

import type { AppUserRole } from "@repo/shared/auth/roles";

export type CurrentSession = {
  user?: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
    role?: AppUserRole;
  };
} | null;

export function useCurrentSession(initialData?: CurrentSession) {
  const pathname = usePathname();
  const [data, setData] = useState<CurrentSession>(initialData ?? null);
  const [isPending, setIsPending] = useState(!initialData);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => {
    setReloadToken((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function loadSession() {
      setIsPending(true);

      try {
        const requestTag = `${Date.now().toString(36)}-${reloadToken}-${encodeURIComponent(pathname)}`;
        const response = await fetch(
          `/api/session/current?t=${requestTag}`,
          {
            cache: "no-store",
            credentials: "include",
            method: "POST",
            headers: {
              "Cache-Control": "no-store",
            },
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          setData(null);
          return;
        }

        setData((await response.json()) as CurrentSession);
      } catch {
        if (!controller.signal.aborted) {
          setData((current) => current ?? null);
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsPending(false);
        }
      }
    }

    loadSession();

    return () => controller.abort();
  }, [pathname, reloadToken]);

  useEffect(() => {
    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    // 首次加载也会触发 pageshow；只在从往返缓存恢复时刷新，避免取消刚发出的首个请求。
    const refreshOnRestore = (event: PageTransitionEvent) => {
      if (event.persisted) reload();
    };

    window.addEventListener("focus", reload);
    window.addEventListener("pageshow", refreshOnRestore);
    document.addEventListener("visibilitychange", refreshOnVisible);

    return () => {
      window.removeEventListener("focus", reload);
      window.removeEventListener("pageshow", refreshOnRestore);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [reload]);

  return { data, isPending, reload };
}
