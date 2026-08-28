/**
 * 管理端单模型配置的安全 multipart HTTP 适配器。
 *
 * 本 Route 固定执行 Origin、声明长度、真实会话、真实流上限和严格 FormData 校验，再把
 * 传输输入交给 UOL；不直接访问数据库、存储服务或模型配置领域服务。
 */

import {
  videoCreditsPerSecondByResolutionSchema,
  videoModelCreditPricesSchema,
} from "@repo/shared/adobe";
import { auth } from "@repo/shared/auth";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { isSuperAdminRole } from "@repo/shared/auth/roles";
import { logError } from "@repo/shared/logger";
import {
  MAX_MODEL_MARKETPLACE_COVER_BYTES,
  type ModelMarketplaceCoverChange,
  type ModelMarketplaceImagePricing,
  modelMarketplaceCustomModelSchema,
  type UpdateModelConfigurationEntryInput,
  type UpdateModelConfigurationEntryOutput,
  updateModelConfigurationEntryInputSchema,
} from "@repo/shared/model-marketplace";
import {
  invokeOperation,
  OperationError,
  type Principal,
} from "@repo/shared/uol";

import {
  BoundedMultipartError,
  parseBoundedContentLength,
  parseBoundedMultipartFormData,
} from "@/features/model-configuration/bounded-multipart";
import { hasTrustedModelConfigurationOrigin } from "@/features/model-configuration/request-origin";
import { ensureUolInitialized } from "@/server/uol-init";

const IMAGE_PRICE_FIELDS = [
  "base1024Credits",
  "base1kCredits",
  "base2kCredits",
  "base4kCredits",
  "base8kCredits",
] as const;

const KNOWN_FORM_FIELDS = new Set([
  "category",
  "configKey",
  "expectedRevision",
  "clientRequestId",
  "enabled",
  "visible",
  "homepageVisible",
  "homepagePriority",
  "description",
  "coverChange",
  "cover",
  "creditsPerSecondByResolution",
  "creditsPerItemByResolution",
  "billingMode",
  "maxReferenceImages",
  "isCustom",
  "supportedResolutions",
  "supportsQuality",
  "supportsAutoSize",
  ...IMAGE_PRICE_FIELDS,
]);

const COMMON_SCALAR_FIELDS = [
  "category",
  "configKey",
  "expectedRevision",
  "clientRequestId",
  "isCustom",
] as const;
const MARKETPLACE_SCALAR_FIELDS = [
  ...COMMON_SCALAR_FIELDS,
  "enabled",
  "visible",
  "homepageVisible",
  "homepagePriority",
  "description",
  "coverChange",
] as const;

/** Route 自身的客户端输入错误，不携带原始字段值或文件信息。 */
class ModelConfigurationFormError extends Error {
  /** 创建稳定的表单错误；该错误没有外部副作用。 */
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigurationFormError";
  }
}

interface CollectedFormData {
  readonly scalars: ReadonlyMap<string, string>;
  readonly covers: readonly File[];
}

/**
 * 返回稳定 JSON 错误响应。
 *
 * @param error - 面向客户端的固定英文摘要。
 * @param code - 稳定机器码。
 * @param status - HTTP 状态码。
 * @returns 不包含内部异常消息或堆栈的 JSON Response。
 */
function errorResponse(error: string, code: string, status: number): Response {
  return Response.json({ error, code }, { status });
}

/**
 * 将有界正文错误映射为安全 HTTP 响应。
 *
 * @param error - 正文读取器给出的稳定错误。
 * @returns 超限为 413，其余客户端正文错误为 400。
 */
function boundedMultipartErrorResponse(error: BoundedMultipartError): Response {
  if (error.code === "body_too_large") {
    return errorResponse("Request body too large", error.code, 413);
  }
  return errorResponse("Invalid multipart request", error.code, 400);
}

/**
 * 编码模型配置 operation 错误，并把已安全分类的封面错误暴露为前端稳定机器码。
 *
 * @param error - UOL 网关交付的稳定错误；details 不可信且只读取固定 reason。
 * @returns 不包含底层异常消息、图片字节、对象路径或凭据的 JSON Response。
 * @sideEffects 无。
 * @failure details 缺失或类型非法时退回通用 operation code。
 */
function modelConfigurationOperationErrorResponse(
  error: OperationError
): Response {
  const responseCode =
    error.code === "validation_error" &&
    error.details?.reason === "invalid_cover"
      ? "invalid_cover"
      : error.code;
  return errorResponse("Operation failed", responseCode, error.httpStatus);
}

/**
 * 收集全部 FormData 项并拒绝未知字段、重复标量和非 cover 文件。
 *
 * @param formData - 平台从有界正文解析出的数据。
 * @returns 唯一标量映射和最多一个候选封面文件。
 * @throws ModelConfigurationFormError - 任意字段结构不严格时失败。
 */
function collectStrictFormData(formData: FormData): CollectedFormData {
  const scalars = new Map<string, string>();
  const covers: File[] = [];
  for (const [field, value] of formData.entries()) {
    if (!KNOWN_FORM_FIELDS.has(field)) {
      throw new ModelConfigurationFormError("表单包含未知字段");
    }
    if (field === "cover") {
      if (typeof value === "string") {
        throw new ModelConfigurationFormError("封面字段必须是文件");
      }
      covers.push(value);
      if (covers.length > 1) {
        throw new ModelConfigurationFormError("只能上传一个封面文件");
      }
      continue;
    }
    if (typeof value !== "string") {
      throw new ModelConfigurationFormError("标量字段不能包含文件");
    }
    if (scalars.has(field)) {
      throw new ModelConfigurationFormError("标量字段不能重复");
    }
    scalars.set(field, value);
  }
  return { scalars, covers };
}

/**
 * 读取必填标量字段。
 *
 * @param scalars - 已去重的标量映射。
 * @param field - 必填字段名。
 * @returns 字段原始字符串，后续由共享 schema 规范化。
 * @throws ModelConfigurationFormError - 字段缺失时失败。
 */
function requireScalar(
  scalars: ReadonlyMap<string, string>,
  field: string
): string {
  const value = scalars.get(field);
  if (value === undefined) {
    throw new ModelConfigurationFormError("表单缺少必填字段");
  }
  return value;
}

/**
 * 拒绝当前联合分支不接受的已知标量字段。
 *
 * @param scalars - 已去重的标量映射。
 * @param allowedFields - 当前模型类别允许的字段集合。
 * @throws ModelConfigurationFormError - 出现跨分支字段时失败，避免静默忽略输入。
 */
function assertOnlyAllowedScalars(
  scalars: ReadonlyMap<string, string>,
  allowedFields: ReadonlySet<string>
): void {
  for (const field of scalars.keys()) {
    if (!allowedFields.has(field)) {
      throw new ModelConfigurationFormError("表单包含当前模型类型不接受的字段");
    }
  }
}

/**
 * 严格解析十进制有限数值。
 *
 * @param value - FormData 中的数字文本。
 * @returns 可交给共享 schema 做范围校验的有限 number。
 * @throws ModelConfigurationFormError - 空值、非十进制或非有限数值时失败。
 */
function parseFiniteNumber(value: string): number {
  const normalized = value.trim();
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(normalized)) {
    throw new ModelConfigurationFormError("数字字段格式无效");
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new ModelConfigurationFormError("数字字段必须是有限数值");
  }
  return parsed;
}

/**
 * 解析非负安全整数 revision。
 *
 * @param value - revision 文本。
 * @returns 非负安全整数。
 * @throws ModelConfigurationFormError - 格式、范围或精度非法时失败。
 */
function parseRevision(value: string): number {
  const parsed = parseFiniteNumber(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ModelConfigurationFormError("revision 必须是非负安全整数");
  }
  return parsed;
}

/**
 * 解析无业务硬上限的正安全整数能力值。
 *
 * @param value - multipart 中的十进制整数文本。
 * @returns 1 至 Number.MAX_SAFE_INTEGER 的整数。
 * @throws ModelConfigurationFormError - 零、符号、小数、指数或不安全整数时失败。
 */
function parsePositiveSafeInteger(value: string): number {
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new ModelConfigurationFormError("能力值必须是正整数");
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new ModelConfigurationFormError("能力值超过安全整数范围");
  }
  return parsed;
}

/**
 * 解析官网首页排序优先级。
 *
 * @param value - 只允许非负安全整数的优先级文本。
 * @returns 可继续由共享 schema 校验业务上限的 number。
 * @throws ModelConfigurationFormError - 小数、负数或越过安全整数范围时失败。
 */
function parseHomepagePriority(value: string): number {
  const parsed = parseFiniteNumber(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ModelConfigurationFormError("首页优先级必须是非负整数");
  }
  return parsed;
}

/**
 * 解析严格布尔文本。
 *
 * @param value - 只允许 true 或 false 的文本。
 * @returns 对应布尔值。
 * @throws ModelConfigurationFormError - 其他拼写或数值形式时失败。
 */
function parseBoolean(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ModelConfigurationFormError("布尔字段格式无效");
}

/**
 * 解析完整四档图像价格。
 *
 * @param scalars - 已去重标量映射。
 * @returns 四个字段均存在的图像价格对象。
 * @throws ModelConfigurationFormError - 字段缺失或数字格式非法时失败。
 */
function parseImagePricing(
  scalars: ReadonlyMap<string, string>
): ModelMarketplaceImagePricing {
  return {
    base1024Credits: parseFiniteNumber(
      requireScalar(scalars, "base1024Credits")
    ),
    base1kCredits: parseFiniteNumber(requireScalar(scalars, "base1kCredits")),
    base2kCredits: parseFiniteNumber(requireScalar(scalars, "base2kCredits")),
    base4kCredits: parseFiniteNumber(requireScalar(scalars, "base4kCredits")),
    ...(scalars.has("base8kCredits") && scalars.get("base8kCredits")?.trim()
      ? { base8kCredits: parseFiniteNumber(scalars.get("base8kCredits") ?? "") }
      : {}),
  };
}

/**
 * 解析视频分辨率价格 JSON。
 *
 * @param value - multipart 中唯一的 JSON 标量。
 * @returns 通过共享财务 schema 的分辨率每秒价格。
 * @throws ModelConfigurationFormError - JSON 语法非法时失败；结构错误由 Zod 报告。
 * @sideEffects 无。
 */
function parseVideoPricing(value: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ModelConfigurationFormError("视频分辨率价格格式无效");
  }
  return videoCreditsPerSecondByResolutionSchema.parse(parsed);
}

/**
 * 解析视频按条分辨率价格 JSON。
 *
 * @param value - multipart 中唯一的 JSON 标量。
 * @returns 通过共享正数价格 schema 的分辨率映射。
 * @throws ModelConfigurationFormError - JSON 语法非法时失败；数值边界由 Zod 拒绝。
 */
function parseVideoItemPricing(value: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ModelConfigurationFormError("视频按条价格格式无效");
  }
  return videoModelCreditPricesSchema.parse(parsed);
}

/**
 * 解析自定义图像模型支持的分辨率 JSON。
 *
 * @param value - multipart 中唯一的 JSON 数组标量。
 * @returns 去空白、保持管理员顺序的分辨率标签。
 * @throws ModelConfigurationFormError - JSON 语法或结构非法时失败。
 */
function parseSupportedResolutions(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ModelConfigurationFormError("支持的分辨率格式无效");
  }
  return modelMarketplaceCustomModelSchema.parse({
    modelId: "validation-probe",
    category: "image",
    supportedResolutions: parsed,
  }).supportedResolutions;
}

/**
 * 校验封面动作并在 replace 时读取实际文件字节。
 *
 * @param action - keep、remove 或 replace。
 * @param covers - 严格收集到的候选封面文件。
 * @returns 与共享契约一致的封面动作。
 * @throws ModelConfigurationFormError - 文件数量、动作或实际大小非法时失败。
 * @sideEffects replace 时读取唯一 File 的内存字节；不写入存储。
 */
async function parseCoverChange(
  action: string,
  covers: readonly File[]
): Promise<ModelMarketplaceCoverChange> {
  if (action === "keep" || action === "remove") {
    if (covers.length !== 0) {
      throw new ModelConfigurationFormError("当前封面动作不接受文件");
    }
    return { action };
  }
  if (action !== "replace" || covers.length !== 1) {
    throw new ModelConfigurationFormError("替换封面时必须上传一个文件");
  }
  const cover = covers[0];
  if (!cover || cover.size > MAX_MODEL_MARKETPLACE_COVER_BYTES) {
    throw new ModelConfigurationFormError("封面文件不能超过 5 MiB");
  }
  const bytes = new Uint8Array(await cover.arrayBuffer());
  if (bytes.byteLength > MAX_MODEL_MARKETPLACE_COVER_BYTES) {
    throw new ModelConfigurationFormError("封面文件不能超过 5 MiB");
  }
  return { action: "replace", bytes };
}

/**
 * 解析图像模型表单分支。
 *
 * @param data - 已严格收集的表单数据。
 * @returns 只包含真实图像模型完整价格与展示字段的保存输入。
 * @throws ModelConfigurationFormError - 字段或封面组合非法时失败。
 */
async function parseImageInput(
  data: CollectedFormData
): Promise<UpdateModelConfigurationEntryInput> {
  assertOnlyAllowedScalars(
    data.scalars,
    new Set([
      ...MARKETPLACE_SCALAR_FIELDS,
      ...IMAGE_PRICE_FIELDS,
      "supportedResolutions",
      "supportsQuality",
      "supportsAutoSize",
    ])
  );
  const isCustom = data.scalars.get("isCustom");
  const supportedResolutions = data.scalars.get("supportedResolutions");
  const supportsQuality = data.scalars.get("supportsQuality");
  const supportsAutoSize = data.scalars.get("supportsAutoSize");
  return updateModelConfigurationEntryInputSchema.parse({
    category: "image" as const,
    configKey: requireScalar(data.scalars, "configKey"),
    expectedRevision: parseRevision(
      requireScalar(data.scalars, "expectedRevision")
    ),
    clientRequestId: requireScalar(data.scalars, "clientRequestId"),
    ...(isCustom !== undefined ? { isCustom: parseBoolean(isCustom) } : {}),
    enabled: parseBoolean(requireScalar(data.scalars, "enabled")),
    visible: parseBoolean(requireScalar(data.scalars, "visible")),
    homepageVisible: parseBoolean(
      requireScalar(data.scalars, "homepageVisible")
    ),
    homepagePriority: parseHomepagePriority(
      requireScalar(data.scalars, "homepagePriority")
    ),
    description: requireScalar(data.scalars, "description"),
    coverChange: await parseCoverChange(
      requireScalar(data.scalars, "coverChange"),
      data.covers
    ),
    pricing: parseImagePricing(data.scalars),
    ...(supportedResolutions !== undefined
      ? {
          supportedResolutions: parseSupportedResolutions(supportedResolutions),
        }
      : {}),
    ...(supportsQuality !== undefined
      ? { supportsQuality: parseBoolean(supportsQuality) }
      : {}),
    ...(supportsAutoSize !== undefined
      ? { supportsAutoSize: parseBoolean(supportsAutoSize) }
      : {}),
  });
}

/**
 * 解析视频模型表单分支。
 *
 * @param data - 已严格收集的表单数据。
 * @returns 视频模型保存输入。
 * @throws ModelConfigurationFormError - 出现跨分支字段或封面组合非法时失败。
 */
async function parseVideoInput(
  data: CollectedFormData
): Promise<UpdateModelConfigurationEntryInput> {
  assertOnlyAllowedScalars(
    data.scalars,
    new Set([
      ...MARKETPLACE_SCALAR_FIELDS,
      "creditsPerSecondByResolution",
      "creditsPerItemByResolution",
      "billingMode",
      "maxReferenceImages",
      "supportedResolutions",
    ])
  );
  const maxReferenceImages = data.scalars.get("maxReferenceImages");
  const billingMode = data.scalars.get("billingMode");
  const creditsPerItemByResolution = data.scalars.get(
    "creditsPerItemByResolution"
  );
  const isCustom = data.scalars.get("isCustom");
  const supportedResolutions = data.scalars.get("supportedResolutions");
  return updateModelConfigurationEntryInputSchema.parse({
    category: "video",
    configKey: requireScalar(data.scalars, "configKey"),
    expectedRevision: parseRevision(
      requireScalar(data.scalars, "expectedRevision")
    ),
    clientRequestId: requireScalar(data.scalars, "clientRequestId"),
    ...(isCustom !== undefined ? { isCustom: parseBoolean(isCustom) } : {}),
    enabled: parseBoolean(requireScalar(data.scalars, "enabled")),
    visible: parseBoolean(requireScalar(data.scalars, "visible")),
    homepageVisible: parseBoolean(
      requireScalar(data.scalars, "homepageVisible")
    ),
    homepagePriority: parseHomepagePriority(
      requireScalar(data.scalars, "homepagePriority")
    ),
    description: requireScalar(data.scalars, "description"),
    coverChange: await parseCoverChange(
      requireScalar(data.scalars, "coverChange"),
      data.covers
    ),
    creditsPerSecondByResolution: parseVideoPricing(
      requireScalar(data.scalars, "creditsPerSecondByResolution")
    ),
    ...(billingMode !== undefined ? { billingMode } : {}),
    ...(creditsPerItemByResolution !== undefined
      ? {
          creditsPerItemByResolution: parseVideoItemPricing(
            creditsPerItemByResolution
          ),
        }
      : {}),
    ...(supportedResolutions !== undefined
      ? {
          supportedResolutions: parseSupportedResolutions(supportedResolutions),
        }
      : {}),
    ...(maxReferenceImages !== undefined
      ? { maxReferenceImages: parsePositiveSafeInteger(maxReferenceImages) }
      : {}),
  });
}

/**
 * 将严格 FormData 转为共享判别联合输入。
 *
 * @param formData - 有界平台解析结果。
 * @returns 通过共享 Zod schema 的保存输入。
 * @throws ModelConfigurationFormError 或 ZodError - 字段结构或领域契约非法时失败。
 * @sideEffects replace 分支会读取封面 File 字节。
 */
async function parseModelConfigurationInput(
  formData: FormData
): Promise<UpdateModelConfigurationEntryInput> {
  const data = collectStrictFormData(formData);
  const category = requireScalar(data.scalars, "category");
  if (category === "image") return parseImageInput(data);
  if (category === "video") return parseVideoInput(data);
  throw new ModelConfigurationFormError("模型配置类别无效");
}

/**
 * 保存单个模型配置。
 *
 * @param request - 浏览器发送的 same-origin multipart 请求。
 * @returns 成功时返回 UOL 输出；失败时返回不泄露内部异常的稳定 JSON。
 * @sideEffects 读取真实会话和请求正文，并可能经 UOL 更新价格、展示设置及封面。
 */
export async function POST(request: Request): Promise<Response> {
  try {
    if (!hasTrustedModelConfigurationOrigin(request)) {
      return errorResponse("Forbidden", "forbidden", 403);
    }

    try {
      parseBoundedContentLength(request.headers.get("content-length"));
    } catch (error) {
      if (error instanceof BoundedMultipartError) {
        return boundedMultipartErrorResponse(error);
      }
      throw error;
    }

    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) {
      return errorResponse("Unauthorized", "unauthenticated", 401);
    }
    const role = await getUserRoleById(session.user.id);
    if (!isSuperAdminRole(role)) {
      return errorResponse("Forbidden", "forbidden", 403);
    }

    let input: UpdateModelConfigurationEntryInput;
    try {
      const formData = await parseBoundedMultipartFormData(request);
      input = await parseModelConfigurationInput(formData);
    } catch (error) {
      if (error instanceof BoundedMultipartError) {
        return boundedMultipartErrorResponse(error);
      }
      return errorResponse("Invalid form data", "validation_error", 400);
    }

    const principal: Principal = {
      type: "user",
      userId: session.user.id,
      role,
    };
    try {
      await ensureUolInitialized();
      const output = await invokeOperation<UpdateModelConfigurationEntryOutput>(
        "settings.updateModelConfigurationEntry",
        input,
        principal
      );
      return Response.json(output, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      if (error instanceof OperationError) {
        return modelConfigurationOperationErrorResponse(error);
      }
      logError(error, { source: "api.admin.model-configuration" });
      return errorResponse("Internal server error", "internal_error", 500);
    }
  } catch (error) {
    logError(error, { source: "api.admin.model-configuration.preflight" });
    return errorResponse("Internal server error", "internal_error", 500);
  }
}
