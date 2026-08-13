/**
 * 模型配置管理列表的 URL 分页与筛选状态。
 *
 * 使用方：ModelConfigurationPanel。所有参数使用 model namespace，筛选或页大小变化
 * 回到第一页，并保留同一设置页中 member/group 的独立状态。
 */

import type {
  ModelConfigurationCategoryFilter,
  ModelConfigurationListInput,
} from "@repo/shared/model-marketplace";
import type { PaginationConfig } from "@repo/shared/pagination/config";
import { parsePaginationState } from "@repo/shared/pagination/state";
import { createPaginationUrlParamNames } from "@repo/shared/pagination/url-adapter";

export const MODEL_CONFIGURATION_PAGINATION_NAMES =
  createPaginationUrlParamNames("model");
export const MODEL_CONFIGURATION_QUERY_PARAM = "modelQuery";
export const MODEL_CONFIGURATION_CATEGORY_PARAM = "modelCategory";

/** 把 URL 的类别值收窄为允许的管理筛选。 */
function parseCategory(
  value: string | string[] | undefined
): ModelConfigurationCategoryFilter {
  return value === "image" || value === "video" ? value : "all";
}

/** 从当前查询参数解析严格模型列表条件。 */
export function parseModelConfigurationListInput(
  searchParams: URLSearchParams,
  paginationConfig: PaginationConfig
): ModelConfigurationListInput {
  const state = parsePaginationState(
    {
      page: readSingleValue(
        searchParams,
        MODEL_CONFIGURATION_PAGINATION_NAMES.page
      ),
      pageSize: readSingleValue(
        searchParams,
        MODEL_CONFIGURATION_PAGINATION_NAMES.pageSize
      ),
    },
    paginationConfig
  );
  const queryValues = searchParams.getAll(MODEL_CONFIGURATION_QUERY_PARAM);
  const categoryValues = searchParams.getAll(
    MODEL_CONFIGURATION_CATEGORY_PARAM
  );
  return {
    page: state.page,
    pageSize:
      state.pageSize === 10 || state.pageSize === 50 ? state.pageSize : 20,
    query:
      queryValues.length === 1 ? (queryValues[0]?.slice(0, 240) ?? "") : "",
    category: parseCategory(
      categoryValues.length === 1 ? categoryValues[0] : undefined
    ),
  };
}

/** 重复查询参数视为无效输入并交给共享默认值收敛。 */
function readSingleValue(
  searchParams: URLSearchParams,
  name: string
): string | string[] | undefined {
  const values = searchParams.getAll(name);
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : values;
}
