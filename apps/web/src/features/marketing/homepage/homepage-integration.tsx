/**
 * 首页快速集成服务端展示组件。
 *
 * 使用方：首页连续内容编排；由服务端页面传入已校验的当前请求 origin，无请求上下文
 * 时回退公开站点配置。组件始终输出三步与 API Docs/API Key 入口，仅在安全构建成功时
 * 输出 CodeBlock。
 */
import { getSiteBaseUrl } from "@repo/shared/config";
import { Button } from "@repo/ui/components/button";
import { CodeBlock } from "@repo/ui/components/code-block";
import { ArrowUpRight, CircleCheck, KeyRound } from "lucide-react";

import { Link } from "@/i18n/routing";

import {
  buildHomepageIntegrationExample,
  getHomepageIntegrationContent,
  type HomepageIntegrationCatalogState,
} from "./integration-example";

/**
 * 渲染三步服务端集成说明、安全 cURL 示例和固定开发者入口。
 *
 * @param baseUrl - 当前请求对应的 HTTP(S) origin；无请求上下文时回退公开站点配置。
 * @param catalog - 已由模型广场公开 DTO 投影的完整图像目录状态。
 * @param locale - 当前路由语言。
 * @returns 无 JavaScript 也可阅读的三步说明；复制交互由共享 CodeBlock 渐进增强。
 * @sideEffects 无；不读取请求头、不发起目录请求，也不接收或渲染真实 API Key。
 * @failure 目录或 origin 不可用时显示对应说明，仍保留 API Docs 与 API Key 入口。
 */
export function HomepageIntegration({
  baseUrl = getSiteBaseUrl(),
  catalog,
  locale,
}: {
  baseUrl?: string;
  catalog: HomepageIntegrationCatalogState;
  locale?: string;
}) {
  const content = getHomepageIntegrationContent(locale);
  const example = buildHomepageIntegrationExample({
    catalog,
    origin: baseUrl,
    runtime:
      process.env.NODE_ENV === "production" ? "production" : "development",
  });

  return (
    <section
      aria-labelledby="homepage-integration-title"
      className="scroll-mt-24 bg-background px-4 py-20 sm:px-6 lg:px-8 lg:py-28"
      id="integration"
    >
      <div className="mx-auto w-full max-w-7xl">
        <div className="grid gap-8 border-b border-foreground/70 pb-10 lg:grid-cols-[1.15fr_0.85fr] lg:items-end">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground">
              {content.eyebrow}
            </p>
            <h2
              className="mt-4 max-w-4xl font-serif text-4xl font-medium leading-[1.04] tracking-[-0.025em] sm:text-5xl lg:text-6xl"
              id="homepage-integration-title"
            >
              {content.title}
            </h2>
          </div>
          <p className="max-w-xl text-sm leading-7 text-muted-foreground lg:justify-self-end">
            {content.description}
          </p>
        </div>

        <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:items-stretch">
          <div className="flex flex-col justify-between">
            <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background">
              {content.steps.map((step, index) => (
                <li className="flex gap-5 px-5 py-6" key={step.title}>
                  <span className="mt-1 shrink-0 font-mono text-[10px] text-destructive">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <h3 className="font-serif text-2xl font-medium">
                      {step.title}
                    </h3>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {step.description}
                    </p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild className="rounded-full px-6">
                <Link href={content.links.apiDocs}>
                  {content.linkLabels.apiDocs}
                  <ArrowUpRight className="size-4" />
                </Link>
              </Button>
              <Button asChild className="rounded-full px-6" variant="outline">
                <Link href={content.links.apiKeys}>
                  <KeyRound className="size-4" />
                  {content.linkLabels.apiKeys}
                </Link>
              </Button>
            </div>
          </div>

          <div className="min-w-0 overflow-hidden rounded-lg border border-[#11100f] bg-[#11100f] p-3 shadow-menu sm:p-5">
            {example.status === "available" ? (
              <>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-white/15 pb-4 text-xs text-white/50">
                  <span className="inline-flex items-center gap-2">
                    <CircleCheck className="size-4" />
                    {content.modelLabel}
                  </span>
                  <code className="break-all font-mono text-[#f6f1e7]">
                    {example.modelId}
                  </code>
                </div>
                <CodeBlock
                  className="min-h-[28rem] rounded-md border-white/15 bg-[#11100f] shadow-none [&>div]:border-white/15 [&>div]:bg-[#171615] [&_button]:text-white/65 [&_code]:min-w-0 [&_code>span]:break-all [&_code>span]:whitespace-pre-wrap [&_figcaption]:text-white/55 [&_pre]:max-h-none [&_pre]:text-[#f6f1e7]"
                  code={example.curl}
                  labels={content.copyLabels}
                  language="bash"
                  showLineNumbers={false}
                  title={content.exampleTitle}
                />
              </>
            ) : (
              <div className="flex min-h-[28rem] flex-col justify-center rounded-md border border-dashed border-white/20 bg-white/[0.03] p-6 text-[#f6f1e7]">
                <h3 className="font-serif text-xl font-medium">
                  {content.unavailableTitle}
                </h3>
                <p className="mt-3 max-w-lg text-sm leading-6 text-white/55">
                  {content.unavailableMessages[example.reason]}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
