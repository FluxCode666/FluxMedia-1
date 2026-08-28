"use client";

/**
 * API 上游六操作管理表单。
 *
 * 职责：编辑共享认证模式，并按文生图、图生图和生视频组织六个固定操作；
 * 密钥仍由外层成员表单单独处理且不会读回浏览器。
 */
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@repo/ui/components/accordion";
import { Checkbox } from "@repo/ui/components/checkbox";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/ui/components/tabs";

import {
  API_UPSTREAM_MEDIA_SECTIONS,
  type ApiUpstreamAdapterFormDraft,
  hasApiUpstreamQueryPath,
} from "./api-upstream-adapter-draft";
import { ApiUpstreamOperationSection } from "./api-upstream-operation-section";

/** 渲染 API 账号认证与默认收起的三个媒体折叠区。 */
export function ApiUpstreamAdapterForm({
  value,
  disabled = false,
  onChange,
  showVideoInputCapabilities = true,
}: {
  value: ApiUpstreamAdapterFormDraft;
  disabled?: boolean;
  onChange: (value: ApiUpstreamAdapterFormDraft) => void;
  /** 是否在请求响应配置中显示视频输入能力；详情页会将其归入模型能力。 */
  showVideoInputCapabilities?: boolean;
}) {
  /** 更新一个操作且保留其余五个不可变草稿。 */
  function updateOperation(
    operation: keyof ApiUpstreamAdapterFormDraft["operations"],
    operationValue: ApiUpstreamAdapterFormDraft["operations"][typeof operation]
  ): void {
    onChange({
      ...value,
      operations: { ...value.operations, [operation]: operationValue },
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>视频上游协议模式</Label>
        <Select
          value={value.videoProtocolMode}
          disabled={disabled}
          onValueChange={(mode) =>
            onChange({
              ...value,
              videoProtocolMode:
                mode as ApiUpstreamAdapterFormDraft["videoProtocolMode"],
            })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="gemini">Gemini</SelectItem>
            <SelectItem value="seedance">Seedance</SelectItem>
            <SelectItem value="custom">Custom（当前脚本/内置路径）</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          仅决定该成员发送给上游的视频请求格式，不根据模型名称推断供应商；存量成员默认使用
          custom。
        </p>
      </div>
      <div className="space-y-2">
        <Label>认证模式</Label>
        <Select
          value={value.authentication.mode}
          disabled={disabled}
          onValueChange={(mode) =>
            onChange({
              ...value,
              authentication:
                mode === "custom_header"
                  ? { mode, headerName: "X-API-Key" }
                  : {
                      mode: mode as "bearer" | "raw_authorization" | "none",
                    },
            })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bearer">Bearer</SelectItem>
            <SelectItem value="raw_authorization">Raw Authorization</SelectItem>
            <SelectItem value="custom_header">自定义认证 Header</SelectItem>
            <SelectItem value="none">无认证</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          六个操作共享认证模式；脚本不可读取或覆盖认证值。
        </p>
      </div>
      {value.authentication.mode === "custom_header" && (
        <div className="space-y-2">
          <Label htmlFor="api-auth-header-name">认证 Header 名称</Label>
          <Input
            id="api-auth-header-name"
            value={value.authentication.headerName}
            disabled={disabled}
            maxLength={256}
            onChange={(event) =>
              onChange({
                ...value,
                authentication: {
                  mode: "custom_header",
                  headerName: event.target.value,
                },
              })
            }
          />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="api-video-submission-retry-count">
          生视频创建额外重试次数
        </Label>
        <Input
          id="api-video-submission-retry-count"
          type="number"
          min={0}
          max={10}
          step={1}
          value={value.videoSubmissionRetryCount}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...value,
              videoSubmissionRetryCount: Number(event.target.value),
            })
          }
        />
        <p className="text-xs text-muted-foreground">
          0 表示只请求一次；默认 2
          表示首次请求后最多再重试两次。任务首次选择该账号时固定配置。
        </p>
      </div>

      {showVideoInputCapabilities ? (
        <div className="space-y-2">
          <Label>视频输入能力标签</Label>
          <div className="space-y-2 rounded-md border p-3">
            <label
              htmlFor="api-reference-video-capability"
              className="flex items-center gap-2 text-sm"
            >
              <Checkbox
                id="api-reference-video-capability"
                checked={value.videoInputCapabilities.referenceVideos}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onChange({
                    ...value,
                    videoInputCapabilities: {
                      ...value.videoInputCapabilities,
                      referenceVideos: checked === true,
                    },
                  })
                }
              />
              支持参考视频输入
            </label>
            <label
              htmlFor="api-reference-audio-capability"
              className="flex items-center gap-2 text-sm"
            >
              <Checkbox
                id="api-reference-audio-capability"
                checked={value.videoInputCapabilities.referenceAudios}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onChange({
                    ...value,
                    videoInputCapabilities: {
                      ...value.videoInputCapabilities,
                      referenceAudios: checked === true,
                    },
                  })
                }
              />
              支持参考音频输入
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            请求携带对应参考素材时，只会调度到已勾选能力的 API 账号。
          </p>
        </div>
      ) : null}

      <Accordion type="multiple" className="rounded-md border px-4">
        {API_UPSTREAM_MEDIA_SECTIONS.map((section) => {
          const queryPathAvailable = hasApiUpstreamQueryPath(
            section.queryOperation,
            value.operations[section.queryOperation].path
          );
          return (
            <AccordionItem key={section.id} value={section.id}>
              <AccordionTrigger>
                <span>
                  <span className="block">{section.title}</span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    {section.description}
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <Tabs defaultValue="generate">
                  <TabsList>
                    <TabsTrigger value="generate">生成</TabsTrigger>
                    <TabsTrigger value="query">查询进度</TabsTrigger>
                  </TabsList>
                  <TabsContent value="generate">
                    <ApiUpstreamOperationSection
                      operation={section.generateOperation}
                      value={value.operations[section.generateOperation]}
                      queryPathAvailable={queryPathAvailable}
                      disabled={disabled}
                      onChange={(operationValue) =>
                        updateOperation(
                          section.generateOperation,
                          operationValue
                        )
                      }
                    />
                  </TabsContent>
                  <TabsContent value="query">
                    <ApiUpstreamOperationSection
                      operation={section.queryOperation}
                      value={value.operations[section.queryOperation]}
                      queryPathAvailable
                      disabled={disabled}
                      onChange={(operationValue) =>
                        updateOperation(section.queryOperation, operationValue)
                      }
                    />
                  </TabsContent>
                </Tabs>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
    </div>
  );
}
