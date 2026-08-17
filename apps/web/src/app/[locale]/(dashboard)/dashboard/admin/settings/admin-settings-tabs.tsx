"use client";

/**
 * 管理员设置页的按权限惰性页签编排器。
 *
 * 使用方是管理员设置页面；这里只装配高敏系统设置和推广奖励两个页签，页面入口已经由
 * 服务端限制为 super_admin。各业务面板自行通过服务端权限再次校验，本组件不作为授权边界。
 */
import {
  ReferralRewardSettingsPanel,
  SystemSettingsPanel,
} from "@repo/shared/system-settings/components";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/ui/components/tabs";
import { useState } from "react";

import { AdobeCredentialNotificationSettingsCard } from "@/features/system-settings/adobe-credential-notification-settings-card";

type AdminSettingsTabsProps = {
  timeZone: string;
  // 是否允许管理系统设置（含 BETTER_AUTH_SECRET 等密钥）。仅超管为 true。
  canManageSystemSettings: boolean;
};

type AdminSettingsTab = "system" | "referrals";

/**
 * 按页面服务端交付的超管能力渲染并惰性挂载管理页签。
 *
 * @param props - 时区和系统设置能力。
 * @returns 受控 Tabs，已访问页签保持挂载以避免表单切换丢失。
 * @sideEffects 用户切换时更新本地 active/mounted 集合；不执行服务端写入。
 * @failure 非法页签值一律回落到系统设置，真实权限仍由各 Action/UOL 校验。
 */
export function AdminSettingsTabs({
  timeZone,
  canManageSystemSettings,
}: AdminSettingsTabsProps) {
  const defaultTab: AdminSettingsTab = "system";
  const [activeTab, setActiveTab] = useState<AdminSettingsTab>(defaultTab);
  const [mountedTabs, setMountedTabs] = useState<Set<AdminSettingsTab>>(
    () => new Set([defaultTab])
  );

  const handleTabChange = (value: string) => {
    // 页面入口已经限制为超管；仍对客户端伪造的 tab 值做收敛，避免非法状态进入面板。
    const requestedTab = value as AdminSettingsTab;
    const nextTab: AdminSettingsTab =
      canManageSystemSettings && (value === "system" || value === "referrals")
        ? requestedTab
        : "system";
    setActiveTab(nextTab);
    setMountedTabs((current) => {
      if (current.has(nextTab)) return current;
      const next = new Set(current);
      next.add(nextTab);
      return next;
    });
  };

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
      <TabsList className="h-auto flex-wrap justify-start bg-transparent p-0">
        {canManageSystemSettings ? (
          <TabsTrigger
            value="system"
            className="rounded-md border border-transparent px-3 py-2 data-[state=active]:border-foreground/20 data-[state=active]:bg-foreground/5 data-[state=active]:text-foreground data-[state=active]:shadow-none"
          >
            系统设置
          </TabsTrigger>
        ) : null}
        {canManageSystemSettings ? (
          <TabsTrigger
            value="referrals"
            className="rounded-md border border-transparent px-3 py-2 data-[state=active]:border-foreground/20 data-[state=active]:bg-foreground/5 data-[state=active]:text-foreground data-[state=active]:shadow-none"
          >
            推广奖励
          </TabsTrigger>
        ) : null}
      </TabsList>
      {canManageSystemSettings ? (
        <TabsContent value="system" className="mt-6">
          {mountedTabs.has("system") ? (
            <SystemSettingsPanel
              timeZone={timeZone}
              notificationModule={
                <AdobeCredentialNotificationSettingsCard disabled={false} />
              }
            />
          ) : null}
        </TabsContent>
      ) : null}
      {canManageSystemSettings ? (
        <TabsContent value="referrals" className="mt-6">
          {mountedTabs.has("referrals") ? (
            <ReferralRewardSettingsPanel />
          ) : null}
        </TabsContent>
      ) : null}
    </Tabs>
  );
}
