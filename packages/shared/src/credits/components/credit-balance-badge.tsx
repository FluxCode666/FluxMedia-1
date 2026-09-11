"use client";

/**
 * 积分余额徽章组件
 *
 * 显示在侧边栏中，展示用户当前可用积分
 */

import { Coins } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@repo/ui/components/badge";
import { formatCredits } from "../format";

/**
 * 积分余额徽章
 *
 * 特性:
 * - 自动获取用户积分余额
 * - 显示为闪电图标 + 数字格式
 * - 支持 Tooltip 显示详情
 */
export function CreditBalanceBadge() {
  const [balance, setBalance] = useState(0);
  const [isPending, setIsPending] = useState(true);

  useEffect(() => {
    let active = true;
    fetch("/api/go/api/user/credits", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("credits request failed");
        const payload = (await response.json()) as { data?: { balance?: number } };
        if (active) setBalance(payload.data?.balance ?? 0);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setIsPending(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // 加载状态
  if (isPending) {
    return (
      <Badge variant="secondary" className="gap-1 px-2 py-1">
        <Coins className="h-3 w-3" />
        <span className="text-xs">...</span>
      </Badge>
    );
  }

  return (
    <Badge
      variant="secondary"
      className="gap-1 px-2 py-1 bg-warning/15 text-warning hover:bg-warning/25"
      title="Available Credits"
    >
      <Coins className="h-3 w-3" />
      <span className="text-xs font-medium">{formatCredits(balance)}</span>
    </Badge>
  );
}
