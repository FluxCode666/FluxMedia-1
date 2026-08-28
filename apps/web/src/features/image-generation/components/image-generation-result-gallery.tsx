/**
 * 统一生图表单的当前结果展示区。
 *
 * 使用方是 `SimpleImageCreatePanel`。组件只呈现本次请求的加载状态和结果图片，不负责
 * 请求、扣费或把结果写入最近图片。
 */

import { Loader2 } from "lucide-react";
import Image from "next/image";

type ImageGenerationResultGalleryProps = {
  busy: boolean;
  resultUrls: readonly string[];
};

/**
 * 在提交按钮所在表单之后呈现本次生成状态与图片。
 *
 * @param props 当前生成状态和经过父组件校验的站内结果 URL。
 * @returns 生成中状态、响应式结果网格或无内容。
 * @sideEffects 用户点击结果时在新标签页打开原图。
 * @failure 空结果不占据布局；图片加载失败交由浏览器呈现缺失状态。
 */
export function ImageGenerationResultGallery({
  busy,
  resultUrls,
}: ImageGenerationResultGalleryProps) {
  if (busy && resultUrls.length === 0) {
    return (
      <div
        role="status"
        className="flex min-h-64 items-center justify-center border-t border-border bg-muted/15 px-4 text-sm text-muted-foreground sm:px-5"
      >
        <Loader2 className="mr-2 size-5 animate-spin" />
        正在生成图片…
      </div>
    );
  }

  if (resultUrls.length === 0) return null;

  return (
    <section
      aria-labelledby="simple-image-results-title"
      className="border-t border-border p-4 sm:p-5"
    >
      <h2
        id="simple-image-results-title"
        className="mb-3 text-sm font-semibold text-foreground"
      >
        本次结果
      </h2>
      <div
        className={
          resultUrls.length > 1 ? "grid gap-4 sm:grid-cols-2" : "grid gap-4"
        }
      >
        {resultUrls.map((url, index) => (
          <a key={url} href={url} target="_blank" rel="noreferrer">
            <Image
              src={url}
              alt={`生成结果 ${index + 1}`}
              width={1024}
              height={1024}
              unoptimized
              className="h-auto w-full rounded-lg border object-contain"
            />
          </a>
        ))}
      </div>
    </section>
  );
}
