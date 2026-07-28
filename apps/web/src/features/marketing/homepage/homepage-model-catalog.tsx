/**
 * 官网首页图像与视频模型目录。
 *
 * 使用方：首页连续内容；把模型广场允许首页展示的模型按优先级截取为视觉预览，并以
 * 编辑式大卡片展示。展示截断不修改传给快速集成的完整目录。
 */
import { Link } from "@/i18n/routing";

import type {
  HomepageModelCatalogState,
  HomepageModelItem,
} from "./homepage-page-data";

/** 首页公开展示所需的最小目录状态。 */
export type HomepageVisibleModelCatalogState =
  | { status: "ready"; models: HomepageModelItem[] }
  | { status: "unavailable" };

/** 首页混合模型区的本地化文案。 */
export type HomepageModelCatalogCopy = {
  eyebrow: string;
  title: string;
  description: string;
  previewLabel: string;
  countLabel: string;
  unavailable: string;
  supportedLabel: string;
  viewAll: string;
  label: string;
  empty: string;
  categories: {
    image: {
      label: string;
      description: string;
    };
    video: {
      label: string;
      description: string;
    };
  };
};

/** 首页模型区的最大视觉卡片数，不影响快速集成使用的完整图像目录。 */
export const HOMEPAGE_MODEL_PREVIEW_LIMIT = 6;

/**
 * 将模型广场完整图像目录截取为官网视觉预览。
 *
 * @param catalog - 已由首页数据层校验的完整公开目录与首页候选项。
 * @returns 按优先级升序选择的最多六个公开图像或视频模型；同优先级保持目录顺序。
 * @sideEffects 无；排序只作用于副本，不会修改底层运行时配置。
 */
export function getHomepageVisibleModelCatalog(
  catalog: HomepageModelCatalogState
): HomepageVisibleModelCatalogState {
  if (catalog.status === "unavailable") return catalog;

  return {
    status: "ready",
    models: catalog.homepage
      .map((model, sourceIndex) => ({
        ...model,
        id: model.id.trim(),
        sourceIndex,
      }))
      .filter((model) => model.id)
      .sort(
        (left, right) =>
          left.priority - right.priority || left.sourceIndex - right.sourceIndex
      )
      .slice(0, HOMEPAGE_MODEL_PREVIEW_LIMIT)
      .map((model) => ({
        id: model.id,
        category: model.category,
        priority: model.priority,
      })),
  };
}

/**
 * 为首页视觉预览和快速集成拆分同一公开目录的两个消费视图。
 *
 * @param catalog - 页面数据层交付的完整公开目录。
 * @returns 预览使用截断副本，快速集成保留原完整状态和稳定顺序。
 * @sideEffects 无；不会修改或排序输入目录。
 */
export function getHomepageModelCatalogConsumers(
  catalog: HomepageModelCatalogState
): {
  preview: HomepageVisibleModelCatalogState;
  integration: HomepageModelCatalogState;
} {
  return {
    preview: getHomepageVisibleModelCatalog(catalog),
    integration: catalog,
  };
}

/**
 * 渲染图像与视频混合模型目录及诚实降级状态。
 *
 * @param props - 已投影的可见目录和双语文案。
 * @returns 无 JavaScript 也完整可读的混合模型大卡片网格。
 */
export function HomepageModelCatalog({
  catalog,
  copy,
}: {
  catalog: HomepageVisibleModelCatalogState;
  copy: HomepageModelCatalogCopy;
}) {
  const models = catalog.status === "ready" ? catalog.models : null;

  return (
    <section
      aria-labelledby="homepage-models-title"
      className="scroll-mt-24 bg-background px-4 py-20 sm:px-6 lg:px-8 lg:py-28"
      id="models"
    >
      <div className="mx-auto w-full max-w-7xl">
        <div className="grid gap-8 border-b border-foreground/70 pb-10 lg:grid-cols-[1.15fr_0.85fr] lg:items-end">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">
              {copy.eyebrow}
            </p>
            <h2
              className="mt-4 max-w-4xl font-serif text-4xl font-medium leading-[1.04] tracking-[-0.025em] sm:text-5xl"
              id="homepage-models-title"
            >
              {copy.title}
            </h2>
          </div>
          <p className="max-w-xl text-sm leading-7 text-muted-foreground lg:justify-self-end">
            {copy.description}
          </p>
        </div>

        <div className="mt-8 flex items-center justify-between gap-6">
          <div className="inline-flex items-baseline gap-3 rounded-full border border-foreground bg-foreground px-4 py-2 text-background">
            <span className="text-sm">{copy.label}</span>
            <span className="font-mono text-xs">
              {models === null ? "—" : `${models.length} ${copy.countLabel}`}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <p className="hidden font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground sm:block">
              {copy.previewLabel}
            </p>
            <Link
              className="text-sm font-medium underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
              href="/models"
            >
              {copy.viewAll}
            </Link>
          </div>
        </div>

        <article
          aria-labelledby="homepage-models-title"
          className="mt-5"
          data-model-category="mixed"
        >
          {models === null ? (
            <p className="rounded-md border border-destructive/25 bg-destructive/5 px-5 py-4 text-sm text-muted-foreground">
              {copy.unavailable}
            </p>
          ) : models.length === 0 ? (
            <p className="rounded-md border border-border bg-background px-5 py-4 text-sm text-muted-foreground">
              {copy.empty}
            </p>
          ) : (
            <ul
              className={
                models.length === 1
                  ? "w-full max-w-md overflow-hidden rounded-lg border border-border bg-background"
                  : "grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-3"
              }
            >
              {models.map((model, index) => {
                const categoryCopy = copy.categories[model.category];
                return (
                  <li
                    className="group flex min-h-64 min-w-0 flex-col justify-between bg-background p-5 transition-colors duration-300 hover:bg-muted/35 motion-reduce:transition-none sm:p-6"
                    key={`${model.category}:${model.id}`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                        {String(index + 1).padStart(2, "0")} /{" "}
                        {categoryCopy.label}
                      </span>
                      <span
                        aria-hidden="true"
                        className="size-5 rotate-45 border border-muted-foreground/60 transition-transform duration-300 group-hover:rotate-90 motion-reduce:transition-none"
                      />
                    </div>
                    <div>
                      <code className="block break-words font-serif text-2xl leading-tight tracking-[-0.02em] sm:text-3xl">
                        {model.id}
                      </code>
                      <div className="mt-6 flex items-center justify-between gap-4 border-t border-border pt-4">
                        <span className="text-xs text-muted-foreground">
                          {categoryCopy.description}
                        </span>
                        <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.16em] text-destructive">
                          {copy.supportedLabel}
                        </span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </article>
      </div>
    </section>
  );
}
