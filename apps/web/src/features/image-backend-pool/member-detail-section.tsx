/**
 * 供应商账号详情页的统一配置区块。
 *
 * 使用方：成员详情表单。组件只提供标题、说明和稳定的内容层级，不持有表单状态，
 * 让模型能力、请求响应处理和默认参数在视觉上保持一致。
 */
import type { ReactNode } from "react";

/**
 * 渲染带标题栏的账号详情配置区块。
 *
 * @param props 标题、辅助说明及区块表单内容。
 * @returns 不持有状态的语义化 section。
 * @sideEffects 无；保存与校验仍由外层成员表单负责。
 */
export function MemberDetailSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-5 border-b border-border/70 pb-8 last:border-b-0">
      <header className="space-y-1">
        <h3 className="text-base font-semibold tracking-tight">{title}</h3>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </header>
      <div className="space-y-5">{children}</div>
    </section>
  );
}
