"use client";

/**
 * 管理员设置页的按权限惰性页签编排器。
 *
 * 使用方是管理员设置页面；超管可查看系统设置和模型配置，其他后台角色仅进入自身获准的
 * 后端池入口。各业务面板自行通过服务端权限再次校验，本组件不作为授权边界。
 */
import { SystemSettingsPanel } from "@repo/shared/system-settings/components";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/ui/components/tabs";
import { useState } from "react";

import { ImageBackendPoolAdminPanel } from "@/features/image-backend-pool";
import { ModelConfigurationPanel } from "@/features/model-configuration";

type AdminSettingsTabsProps = {
  timeZone: string;
  // 是否允许管理系统设置（含 BETTER_AUTH_SECRET 等密钥）。仅超管为 true；普通 admin
  // 和 observer_admin 可查看模型配置，但不应看到/进入系统设置 tab（见审计 S-C1）。
  canManageSystemSettings: boolean;
  canViewModelConfiguration: boolean;
  imageBackendPoolReadOnly: boolean;
};

type AdminSettingsTab = "system" | "model-configuration" | "image-backends";

/**
 * 按页面服务端交付的超管能力渲染并惰性挂载管理页签。
 *
 * @param props - 时区、系统设置能力、模型配置查看能力和后端池只读状态。
 * @returns 受控 Tabs，已访问页签保持挂载以避免表单切换丢失。
 * @sideEffects 用户切换时更新本地 active/mounted 集合；不执行服务端写入。
 * @failure 未授权页签值一律回落到后端池，真实权限仍由各 Action/UOL 校验。
 */
export function AdminSettingsTabs({
  timeZone,
  canManageSystemSettings,
  canViewModelConfiguration,
  imageBackendPoolReadOnly,
}: AdminSettingsTabsProps) {
  const defaultTab: AdminSettingsTab = canManageSystemSettings
    ? "system"
    : "image-backends";
  const [activeTab, setActiveTab] = useState<AdminSettingsTab>(defaultTab);
  const [mountedTabs, setMountedTabs] = useState<Set<AdminSettingsTab>>(
    () => new Set([defaultTab])
  );

  const handleTabChange = (value: string) => {
    // 非超管禁止进入系统设置和模型配置，强制回落到后端池。
    const requestedTab = value as AdminSettingsTab;
    const nextTab: AdminSettingsTab =
      (value === "system" && canManageSystemSettings) ||
      (value === "model-configuration" && canViewModelConfiguration)
        ? requestedTab
        : "image-backends";
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
        {canViewModelConfiguration ? (
          <TabsTrigger
            value="model-configuration"
            className="rounded-md border border-transparent px-3 py-2 data-[state=active]:border-foreground/20 data-[state=active]:bg-foreground/5 data-[state=active]:text-foreground data-[state=active]:shadow-none"
          >
            模型配置
          </TabsTrigger>
        ) : null}
        <TabsTrigger
          value="image-backends"
          className="rounded-md border border-transparent px-3 py-2 data-[state=active]:border-foreground/20 data-[state=active]:bg-foreground/5 data-[state=active]:text-foreground data-[state=active]:shadow-none"
        >
          生图后端池
        </TabsTrigger>
      </TabsList>
      {canManageSystemSettings ? (
        <TabsContent value="system" className="mt-6">
          {mountedTabs.has("system") ? (
            <SystemSettingsPanel timeZone={timeZone} />
          ) : null}
        </TabsContent>
      ) : null}
      {canViewModelConfiguration ? (
        <TabsContent value="model-configuration" className="mt-6">
          {mountedTabs.has("model-configuration") ? (
            <ModelConfigurationPanel />
          ) : null}
        </TabsContent>
      ) : null}
      <TabsContent value="image-backends" className="mt-6">
        {mountedTabs.has("image-backends") ? (
          <ImageBackendPoolAdminPanel
            readOnly={imageBackendPoolReadOnly}
            timeZone={timeZone}
          />
        ) : null}
      </TabsContent>
    </Tabs>
  );
}
