/**
 * 模型配置管理请求的有界 multipart 正文读取器。
 *
 * 使用方是管理员模型配置 Route。本模块先校验声明长度，再逐块累计真实正文，并且只把
 * 有界副本交给平台 FormData 解析器；不负责鉴权、字段语义或封面文件内容校验。
 */

export const MAX_MODEL_CONFIGURATION_MULTIPART_BYTES = 6 * 1024 * 1024;

export type BoundedMultipartErrorCode =
  | "invalid_content_length"
  | "body_too_large"
  | "missing_body"
  | "invalid_body"
  | "invalid_multipart";

/** 有界正文读取的稳定失败类型，供 HTTP 适配器映射 400 或 413。 */
export class BoundedMultipartError extends Error {
  readonly code: BoundedMultipartErrorCode;

  /**
   * 创建有界正文错误。
   *
   * @param code - 稳定机器码。
   * @param message - 不含请求正文或内部平台细节的安全描述。
   * @returns 新错误实例。
   * @sideEffects 无；调用方负责决定 HTTP 状态码。
   */
  constructor(code: BoundedMultipartErrorCode, message: string) {
    super(message);
    this.name = "BoundedMultipartError";
    this.code = code;
  }
}

/**
 * 解析并预检 Content-Length。
 *
 * @param header - 原始 Content-Length；缺失表示必须依靠真实流累计上限。
 * @param maxBytes - 允许的最大正文长度。
 * @returns 缺失时返回 null，否则返回不超过上限的非负整数。
 * @throws BoundedMultipartError - 声明不是十进制整数或超过上限时失败。
 */
export function parseBoundedContentLength(
  header: string | null,
  maxBytes = MAX_MODEL_CONFIGURATION_MULTIPART_BYTES
): number | null {
  if (header === null) return null;
  const normalized = header.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new BoundedMultipartError(
      "invalid_content_length",
      "Content-Length 必须是非负十进制整数"
    );
  }

  const declaredBytes = BigInt(normalized);
  if (declaredBytes > BigInt(maxBytes)) {
    throw new BoundedMultipartError(
      "body_too_large",
      "multipart 正文超过允许上限"
    );
  }
  return Number(declaredBytes);
}

/**
 * 取消已超限或非法的正文 reader，并保留原始稳定失败语义。
 *
 * @param reader - 当前请求正文 reader。
 * @returns reader 取消完成后返回；底层取消异常被忽略。
 * @sideEffects 终止请求正文的后续读取，避免继续占用内存或连接资源。
 */
async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // WHY：取消仅是资源清理，不能覆盖更重要的正文超限或格式错误机器码。
  }
}

/**
 * 在真实字节维度读取有界请求正文。
 *
 * @param request - 尚未被消费的请求。
 * @param maxBytes - 允许累计的最大真实字节数。
 * @returns 按原顺序拼接且与各流 chunk 隔离的 Uint8Array。
 * @throws BoundedMultipartError - 缺失正文、非法 chunk 或声明/真实长度超限时失败。
 * @sideEffects 消费 request.body；超限或非法 chunk 时立即取消 reader。
 */
export async function readBoundedRequestBody(
  request: Request,
  maxBytes = MAX_MODEL_CONFIGURATION_MULTIPART_BYTES
): Promise<Uint8Array<ArrayBuffer>> {
  parseBoundedContentLength(request.headers.get("content-length"), maxBytes);
  if (!request.body) {
    throw new BoundedMultipartError("missing_body", "请求正文不能为空");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        throw new BoundedMultipartError("invalid_body", "请求正文读取失败");
      }
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        await cancelReader(reader);
        throw new BoundedMultipartError(
          "invalid_body",
          "请求正文包含非法数据块"
        );
      }
      if (result.value.byteLength > maxBytes - totalBytes) {
        await cancelReader(reader);
        throw new BoundedMultipartError(
          "body_too_large",
          "multipart 正文超过允许上限"
        );
      }
      chunks.push(result.value);
      totalBytes += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(new ArrayBuffer(totalBytes));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * 解析经过真实流上限保护的 multipart FormData。
 *
 * @param request - 带 multipart Content-Type 的原始 POST 请求。
 * @param maxBytes - 允许的最大正文长度。
 * @returns 平台解析得到的 FormData；字段严格性由上层业务适配器校验。
 * @throws BoundedMultipartError - 正文超限、缺失或 multipart 格式非法时失败。
 * @sideEffects 消费原始 request.body，并在内存中创建一份有界正文副本。
 */
export async function parseBoundedMultipartFormData(
  request: Request,
  maxBytes = MAX_MODEL_CONFIGURATION_MULTIPART_BYTES
): Promise<FormData> {
  const body = await readBoundedRequestBody(request, maxBytes);
  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data")) {
    throw new BoundedMultipartError(
      "invalid_multipart",
      "Content-Type 必须是 multipart/form-data"
    );
  }

  const boundedRequest = new Request(request.url, {
    method: "POST",
    headers: { "content-type": contentType },
    body: Uint8Array.from(body),
  });
  try {
    return await boundedRequest.formData();
  } catch {
    throw new BoundedMultipartError(
      "invalid_multipart",
      "multipart 正文格式无效"
    );
  }
}
