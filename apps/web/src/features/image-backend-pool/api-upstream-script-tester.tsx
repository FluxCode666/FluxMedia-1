"use client";

/**
 * API 上游脚本无网络测试器。
 *
 * 职责：编辑合成 JSON 样例、调用 human-only UOL Action 并展示严格预览；
 * 组件不接收账号 ID 或密钥，服务端 binding 也不会访问上游。
 */
import type { ApiUpstreamAdapterOperationId } from "@repo/shared/image-backend/api-upstream-script-contract";
import { Button } from "@repo/ui/components/button";
import { Textarea } from "@repo/ui/components/textarea";
import { Loader2 } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";

import { testApiUpstreamAdapterAction } from "./actions";
import {
  formatApiUpstreamScriptSample,
  getDefaultApiUpstreamScriptSample,
} from "./api-upstream-adapter-draft";

/** 判断响应测试结果是否要求后续查询。 */
function isPendingPreview(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = (value as Record<string, unknown>).status;
  return status === "pending" || status === "processing";
}

/** 渲染单个请求或响应脚本的合成样例测试器。 */
export function ApiUpstreamScriptTester({
  operation,
  stage,
  script,
  queryPathAvailable = true,
  disabled = false,
}: {
  operation: ApiUpstreamAdapterOperationId;
  stage: "request" | "response";
  script: string;
  queryPathAvailable?: boolean;
  disabled?: boolean;
}) {
  const [sampleText, setSampleText] = useState(() =>
    formatApiUpstreamScriptSample(
      getDefaultApiUpstreamScriptSample(operation, stage)
    )
  );
  const [preview, setPreview] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const usesBuiltInBehavior = !script.trim();
  const { execute, isPending } = useAction(testApiUpstreamAdapterAction, {
    onSuccess: ({ data }) => {
      if (
        stage === "response" &&
        !queryPathAvailable &&
        isPendingPreview(data.preview)
      ) {
        setPreview(null);
        setErrorMessage("响应进入异步状态，但当前媒体生成操作没有配置查询路径");
        return;
      }
      setErrorMessage(null);
      setPreview(formatApiUpstreamScriptSample(data.preview));
    },
    onError: ({ error }) => {
      setPreview(null);
      setErrorMessage(error.serverError || "脚本测试失败");
    },
  });

  /** 解析管理员合成样例并提交无网络脚本测试。 */
  function handleTest(): void {
    let sample: unknown;
    try {
      sample = JSON.parse(sampleText) as unknown;
    } catch {
      setErrorMessage("测试样例必须是合法 JSON");
      setPreview(null);
      return;
    }
    setErrorMessage(null);
    execute({ operation, stage, script, sample });
  }

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium">无网络测试样例</p>
          <p className="text-xs text-muted-foreground">
            `mock://media/*` 会替换为生产格式的宿主媒体令牌。
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || isPending || usesBuiltInBehavior}
          onClick={handleTest}
        >
          {isPending && <Loader2 className="size-3.5 animate-spin" />}
          测试脚本
        </Button>
      </div>
      {usesBuiltInBehavior && (
        <p className="text-xs text-muted-foreground">
          空脚本使用系统内置行为，无需执行 QuickJS 测试。
        </p>
      )}
      <Textarea
        aria-label={`${operation} ${stage} 测试样例`}
        rows={7}
        className="font-mono text-xs"
        value={sampleText}
        disabled={disabled || isPending || usesBuiltInBehavior}
        onChange={(event) => setSampleText(event.target.value)}
        spellCheck={false}
      />
      {errorMessage && (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage}
        </p>
      )}
      {preview && (
        <pre className="max-h-56 overflow-auto rounded-md bg-muted p-3 text-xs">
          {preview}
        </pre>
      )}
    </div>
  );
}
