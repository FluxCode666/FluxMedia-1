"use client";

/**
 * API 上游单操作编辑区。
 *
 * 职责：展示固定 Method、相对路径、请求与响应脚本及各自无网络测试入口；
 * Method 不进入草稿，避免管理员或脚本修改传输语义。
 */
import {
  API_UPSTREAM_MAX_SCRIPT_CHARACTERS,
  type ApiUpstreamAdapterOperationId,
} from "@repo/shared/image-backend/api-upstream-script-contract";
import type { ApiUpstreamOperationConfig } from "@repo/shared/image-backend/api-upstream-adaptation";
import { Badge } from "@repo/ui/components/badge";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/ui/components/tabs";
import { Textarea } from "@repo/ui/components/textarea";

import {
  getApiUpstreamBuiltInPathHint,
  getApiUpstreamOperationMethod,
} from "./api-upstream-adapter-draft";
import { ApiUpstreamScriptTester } from "./api-upstream-script-tester";

/** 渲染生成或查询中的一个固定供应商操作。 */
export function ApiUpstreamOperationSection({
  operation,
  value,
  queryPathAvailable,
  disabled = false,
  onChange,
}: {
  operation: ApiUpstreamAdapterOperationId;
  value: ApiUpstreamOperationConfig;
  queryPathAvailable: boolean;
  disabled?: boolean;
  onChange: (value: ApiUpstreamOperationConfig) => void;
}) {
  const method = getApiUpstreamOperationMethod(operation);
  const pathId = `api-upstream-${operation.replaceAll(".", "-")}-path`;
  const requestPlaceholder = operation.includes("query")
    ? 'return { query: { ...request.query, detail: "full" } };'
    : "return { body: request.body };";
  const responsePlaceholder = operation.startsWith("images.")
    ? 'return { status: "completed", outputs: [{ kind: "image", url: "https://cdn.example/image.png" }] };'
    : 'return { status: "completed", outputs: [{ kind: "video", url: "https://cdn.example/video.mp4" }] };';

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div className="flex items-center gap-2">
        <Badge variant="outline">{method}</Badge>
        <code className="text-xs text-muted-foreground">{operation}</code>
      </div>
      <div className="space-y-2">
        <Label htmlFor={pathId}>相对路径</Label>
        <Input
          id={pathId}
          value={value.path}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, path: event.target.value })}
          placeholder={`留空使用：${getApiUpstreamBuiltInPathHint(operation)}`}
          maxLength={2_048}
        />
        <p className="text-xs text-muted-foreground">
          路径只能相对 Base URL；GET 查询必须包含一个
          <code>{"{task_id}"}</code>。
        </p>
        {!operation.includes("query") &&
          operation.startsWith("images.") &&
          !queryPathAvailable && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              此图片生成操作未配置查询路径。若供应商返回异步任务（pending/
              processing），任务将以配置错误结束；请在“查询进度”中填写包含
              <code>{"{task_id}"}</code> 的 GET 路径。
            </p>
          )}
      </div>
      <Tabs defaultValue="request">
        <TabsList>
          <TabsTrigger value="request">请求脚本</TabsTrigger>
          <TabsTrigger value="response">响应脚本</TabsTrigger>
        </TabsList>
        <TabsContent value="request" className="space-y-3">
          <Textarea
            aria-label={`${operation} 请求脚本`}
            rows={10}
            className="font-mono text-xs"
            value={value.requestScript}
            disabled={disabled}
            maxLength={API_UPSTREAM_MAX_SCRIPT_CHARACTERS}
            spellCheck={false}
            onChange={(event) =>
              onChange({ ...value, requestScript: event.target.value })
            }
            placeholder={requestPlaceholder}
          />
          <p className="text-xs text-muted-foreground">
            返回可省略 query、headers、body 的部分信封；省略字段表示保留内置值。
          </p>
          <ApiUpstreamScriptTester
            operation={operation}
            stage="request"
            script={value.requestScript}
            disabled={disabled}
          />
        </TabsContent>
        <TabsContent value="response" className="space-y-3">
          <Textarea
            aria-label={`${operation} 响应脚本`}
            rows={10}
            className="font-mono text-xs"
            value={value.responseScript}
            disabled={disabled}
            maxLength={API_UPSTREAM_MAX_SCRIPT_CHARACTERS}
            spellCheck={false}
            onChange={(event) =>
              onChange({ ...value, responseScript: event.target.value })
            }
            placeholder={responsePlaceholder}
          />
          <p className="text-xs text-muted-foreground">
            非空脚本必须返回 pending、processing、completed 或 failed 标准结果。
          </p>
          <ApiUpstreamScriptTester
            operation={operation}
            stage="response"
            script={value.responseScript}
            queryPathAvailable={queryPathAvailable}
            disabled={disabled}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
