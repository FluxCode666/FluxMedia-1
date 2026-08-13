"use client";

/**
 * 工单已读维护写入触发器。
 *
 * 使用方：工单详情页。组件只在详情成功渲染后独立调用标记 operation，分页读取
 * 失败时不会误写已读；写入失败不隐藏当前已成功读取的消息。
 */
import { useAction } from "next-safe-action/hooks";
import { useEffect } from "react";

import { markTicketSeenAction } from "./ticket-actions";

type MarkTicketSeenProps = { ticketId: string };

/** 在挂载后幂等标记当前工单视角已读。 */
export function MarkTicketSeen({ ticketId }: MarkTicketSeenProps) {
  const { execute, result } = useAction(markTicketSeenAction);

  useEffect(() => {
    execute({ ticketId });
  }, [execute, ticketId]);

  if (!result.serverError) return null;
  return (
    <p aria-live="polite" className="sr-only" role="status">
      {result.serverError}
    </p>
  );
}
