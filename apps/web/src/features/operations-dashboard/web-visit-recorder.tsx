"use client";

/**
 * Dashboard 跨应用自然日访问记录器。
 *
 * 使用方：dashboard 公共布局。首次服务端渲染已记录访问，本组件仅在页面重新可见且
 * 应用自然日变化后补一次请求；页面内导航不会重复写入或增加客户端身份字段。
 */
import { useAction } from "next-safe-action/hooks";
import { useEffect, useRef } from "react";

import { recordDashboardWebVisitAction } from "./actions";
import {
  formatClientAppDate,
  shouldRecordVisibleVisit,
} from "./web-visit-recorder-core";

/**
 * 监听可见性并在跨应用自然日后重新记录访问。
 *
 * @param appTimeZone 服务端部署应用时区。
 * @param initialRecordedAppDate 首屏由服务端成功确认的自然日，失败时为 null。
 * @returns 不渲染可见 DOM。
 * @sideEffects 新自然日页面可见时调用一次受保护 Server Action。
 */
export function DashboardWebVisitRecorder({
  appTimeZone,
  initialRecordedAppDate,
}: {
  appTimeZone: string;
  initialRecordedAppDate: string | null;
}) {
  const lastRecordedDateRef = useRef(initialRecordedAppDate);
  const requestInFlightRef = useRef(false);
  const { execute } = useAction(recordDashboardWebVisitAction, {
    onSuccess: ({ data }) => {
      requestInFlightRef.current = false;
      if (data?.status === "recorded") {
        lastRecordedDateRef.current = data.appDate;
      }
    },
    onError: () => {
      requestInFlightRef.current = false;
    },
  });

  useEffect(() => {
    /** 页面可见时只根据客户端日期决定是否发请求，事实日期仍由服务端确定。 */
    function recordIfNewAppDate(): void {
      if (
        document.visibilityState !== "visible" ||
        requestInFlightRef.current
      ) {
        return;
      }
      const currentAppDate = formatClientAppDate(new Date(), appTimeZone);
      if (
        !shouldRecordVisibleVisit(currentAppDate, lastRecordedDateRef.current)
      ) {
        return;
      }
      requestInFlightRef.current = true;
      execute();
    }

    document.addEventListener("visibilitychange", recordIfNewAppDate);
    return () => {
      document.removeEventListener("visibilitychange", recordIfNewAppDate);
    };
  }, [appTimeZone, execute]);

  return null;
}
