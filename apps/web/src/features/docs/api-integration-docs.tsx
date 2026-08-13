/**
 * 公开页与控制台镜像共用的 API 接入文档展示层。
 *
 * 使用 @repo/ui 原语渲染参数表、响应表和代码示例，并把滚动高亮交给独立客户端
 * 电梯；数据与视图分离，确保公开页不会意外展示扩展字段。
 */
import { Badge } from "@repo/ui/components/badge";
import { Card, CardContent } from "@repo/ui/components/card";
import { CodeBlock } from "@repo/ui/components/code-block";
import { cn } from "@repo/ui/utils";
import { KeyRound, Link2, TriangleAlert } from "lucide-react";

import { ApiDocsElevator } from "./api-docs-elevator";
import {
  type ApiIntegrationDocsContent,
  type ApiIntegrationEndpoint,
  type ApiIntegrationEndpointGroup,
  type ApiIntegrationParameter,
  type ApiIntegrationResponseField,
  getApiIntegrationDocs,
} from "./api-integration-docs-data";

/** 渲染响应式请求参数表；窄屏退化为逐字段卡片。 */
function ParameterTable({
  content,
  parameters,
}: {
  content: ApiIntegrationDocsContent;
  parameters: readonly ApiIntegrationParameter[];
}) {
  return (
    <div>
      <h4 className="text-sm font-medium">{content.parametersTitle}</h4>
      <div className="mt-2 overflow-hidden rounded-lg border border-border">
        <div className="hidden grid-cols-[0.9fr_0.7fr_1fr_2fr] border-b bg-muted/50 text-xs font-medium text-muted-foreground md:grid">
          {content.parameterHeaders.map((header) => (
            <div className="px-4 py-2.5" key={header}>
              {header}
            </div>
          ))}
        </div>
        {parameters.map((parameter) => (
          <div
            className="grid gap-2 border-b border-border p-4 text-sm last:border-b-0 md:grid-cols-[0.9fr_0.7fr_1fr_2fr]"
            key={parameter.name}
          >
            <code className="font-mono text-xs text-foreground">
              {parameter.name}
            </code>
            <span className="text-xs text-muted-foreground md:text-sm">
              {parameter.requirement}
            </span>
            <span className="break-words text-xs text-muted-foreground md:text-sm">
              <span className="mr-2 font-medium text-foreground md:hidden">
                {content.parameterHeaders[2]}:
              </span>
              {parameter.defaultValue ?? "—"}
            </span>
            <span className="text-sm leading-relaxed text-muted-foreground">
              {parameter.description}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 渲染响应字段表，保持字段名等宽并允许长名称换行。 */
function ResponseTable({
  content,
  responses,
}: {
  content: ApiIntegrationDocsContent;
  responses: readonly ApiIntegrationResponseField[];
}) {
  return (
    <div>
      <h4 className="text-sm font-medium">{content.responsesTitle}</h4>
      <div className="mt-2 overflow-hidden rounded-lg border border-border">
        <div className="hidden grid-cols-[1.1fr_2fr] border-b bg-muted/50 text-xs font-medium text-muted-foreground md:grid">
          {content.responseHeaders.map((header) => (
            <div className="px-4 py-2.5" key={header}>
              {header}
            </div>
          ))}
        </div>
        {responses.map((response) => (
          <div
            className="grid gap-2 border-b border-border p-4 text-sm last:border-b-0 md:grid-cols-[1.1fr_2fr]"
            key={response.name}
          >
            <code className="break-words font-mono text-xs text-foreground">
              {response.name}
            </code>
            <span className="text-sm leading-relaxed text-muted-foreground">
              {response.description}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 按模块声明的端点 ID 提取正文端点，并保持目录定义的展示顺序。 */
function getGroupEndpoints(
  group: ApiIntegrationEndpointGroup,
  endpoints: readonly ApiIntegrationEndpoint[]
): readonly ApiIntegrationEndpoint[] {
  return group.endpointIds.flatMap((endpointId) => {
    const endpoint = endpoints.find((item) => item.id === endpointId);
    return endpoint ? [endpoint] : [];
  });
}

/** 渲染单个端点的契约、示例与说明，不发起网络请求。 */
function EndpointSection({
  content,
  endpoint,
  index,
}: {
  content: ApiIntegrationDocsContent;
  endpoint: ApiIntegrationEndpoint;
  index: number;
}) {
  return (
    <section className="scroll-mt-32" id={endpoint.id}>
      <Card className="overflow-hidden rounded-lg">
        <div className="border-b border-border bg-muted/20 p-5 md:p-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground/70">
              {String(index + 1).padStart(2, "0")}
            </span>
            <Badge className="rounded-sm font-mono" variant="outline">
              {endpoint.method}
            </Badge>
            <code className="font-mono text-sm font-medium">
              {endpoint.path}
            </code>
            <Badge
              className="rounded-sm font-mono text-[10px]"
              variant="secondary"
            >
              {endpoint.operation}
            </Badge>
          </div>
          <h3 className="mt-4 font-serif text-xl font-medium tracking-tight">
            {endpoint.title}
          </h3>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {endpoint.description}
          </p>
          {endpoint.deprecationNotice ? (
            <div className="mt-2 flex max-w-3xl items-start gap-2 text-sm leading-relaxed text-destructive">
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
              />
              <p>{endpoint.deprecationNotice}</p>
            </div>
          ) : null}
          <p className="mt-3 font-mono text-xs text-muted-foreground">
            {endpoint.contentType}
          </p>
        </div>
        <CardContent className="space-y-6 p-5 md:p-6">
          <div className="grid gap-5 xl:grid-cols-2">
            <div className="min-w-0">
              <h4 className="text-sm font-medium">
                {content.requestExampleTitle}
              </h4>
              <CodeBlock
                className="mt-2"
                code={endpoint.requestExample}
                labels={content.copyLabels}
                language="bash"
              />
            </div>
            <div className="min-w-0">
              <h4 className="text-sm font-medium">
                {content.responseExampleTitle}
              </h4>
              <CodeBlock
                className="mt-2"
                code={endpoint.responseExample}
                labels={content.copyLabels}
                language="json"
              />
            </div>
          </div>
          <ParameterTable content={content} parameters={endpoint.parameters} />
          <ResponseTable content={content} responses={endpoint.responses} />
          <div>
            <h4 className="text-sm font-medium">{content.notesTitle}</h4>
            <ul className="mt-2 space-y-2 text-sm leading-relaxed text-muted-foreground">
              {endpoint.notes.map((note) => (
                <li className="flex gap-2" key={note}>
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

/**
 * 渲染可独立展示或嵌入控制台的 API 接入文档。
 *
 * @param baseUrl - 当前请求对应的 HTTP(S) origin。
 * @param locale - 当前路由语言。
 * @param embedded - 是否嵌入已有横向内边距的控制台内容区。
 * @returns 双语、响应式且只包含现行公开参数的文档页面。
 */
export function ApiIntegrationDocs({
  baseUrl,
  embedded = false,
  locale,
}: {
  baseUrl: string;
  embedded?: boolean;
  locale?: string;
}) {
  const content = getApiIntegrationDocs(locale, baseUrl);

  return (
    <div
      className={cn(
        "mx-auto w-full max-w-7xl py-12 md:py-16",
        embedded ? "px-0" : "px-4 sm:px-6 lg:px-8"
      )}
    >
      <header className="max-w-4xl animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          {content.eyebrow}
        </p>
        <h1 className="mt-3 font-serif text-4xl font-medium tracking-tight md:text-5xl">
          {content.title}
        </h1>
        <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground md:text-lg">
          {content.subtitle}
        </p>
      </header>

      <div className="mt-8 grid gap-3 md:grid-cols-2">
        <div className="flex min-w-0 items-start gap-3 rounded-lg border border-border bg-card p-4 shadow-whisper">
          <Link2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              {content.baseUrlLabel}
            </p>
            <code className="mt-1 block overflow-x-auto font-mono text-sm">
              {content.baseUrl}
            </code>
          </div>
        </div>
        <div className="flex min-w-0 items-start gap-3 rounded-lg border border-border bg-card p-4 shadow-whisper">
          <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{content.authLabel}</p>
            <code className="mt-1 block overflow-x-auto font-mono text-sm">
              {content.authValue}
            </code>
          </div>
        </div>
      </div>

      <div className="mt-12 lg:grid lg:grid-cols-[15.5rem_minmax(0,1fr)] lg:items-start lg:gap-8">
        <ApiDocsElevator
          ariaLabel={content.directoryTitle}
          description={content.directoryDescription}
          endpoints={content.endpoints}
          groups={content.groups}
        />
        <div className="mt-10 min-w-0 lg:mt-0">
          <h2 className="font-serif text-2xl font-medium tracking-tight md:text-3xl">
            {content.endpointsTitle}
          </h2>
          <div className="mt-8 space-y-14">
            {content.groups.map((group, groupIndex) => {
              const groupEndpoints = getGroupEndpoints(
                group,
                content.endpoints
              );

              return (
                <section className="scroll-mt-32" id={group.id} key={group.id}>
                  <div className="flex items-start gap-4 border-b border-border pb-5">
                    <span className="mt-1 font-mono text-xs text-muted-foreground/70">
                      {String(groupIndex + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <h3 className="font-serif text-2xl font-medium tracking-tight">
                        {group.title}
                      </h3>
                      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                        {group.description}
                      </p>
                    </div>
                  </div>
                  <div className="mt-6 space-y-8">
                    {groupEndpoints.map((endpoint) => (
                      <EndpointSection
                        content={content}
                        endpoint={endpoint}
                        index={content.endpoints.findIndex(
                          (item) => item.id === endpoint.id
                        )}
                        key={endpoint.id}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
