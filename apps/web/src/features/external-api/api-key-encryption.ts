/**
 * 外部 API Key 可恢复密文工具。
 *
 * 职责：使用由 BETTER_AUTH_SECRET 派生的 AES-256-GCM 密钥加密与解密 API Key，
 * 让设置页刷新后可再次复制，同时避免数据库直接保存明文。
 * 使用方：key-management-service.ts 的生产依赖适配器。
 * 关键依赖：Node.js crypto；不访问数据库。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const ENCRYPTION_VERSION = "v1";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_DERIVATION_CONTEXT = "FluxMedia external API key encryption v1";
const AAD = Buffer.from("external-api-key:v1", "utf8");

/**
 * 解析生产密钥材料，并拒绝空配置。
 *
 * @param secret 测试可显式注入；生产默认复用必需的 BETTER_AUTH_SECRET。
 * @returns 非空密钥材料。
 * @throws 未配置或仅包含空白时抛出配置错误。
 * @sideEffects 未显式传入时读取一次进程环境变量。
 */
function resolveEncryptionSecret(secret?: string): string {
  const resolved = secret ?? process.env.BETTER_AUTH_SECRET;
  if (!resolved?.trim()) {
    throw new Error("BETTER_AUTH_SECRET is required for API key encryption");
  }
  return resolved;
}

/**
 * 用稳定上下文从应用 Secret 派生独立的 256 位加密密钥。
 *
 * @param secret 应用级密钥材料。
 * @returns 32 字节 AES 密钥。
 * @throws 不主动抛错；调用方必须先保证 secret 非空。
 * @sideEffects 无。
 */
function deriveEncryptionKey(secret: string): Buffer {
  return createHash("sha256")
    .update(KEY_DERIVATION_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(secret, "utf8")
    .digest();
}

/**
 * 把 API Key 加密为带版本的 AES-GCM 密文。
 *
 * @param apiKey 待持久化的完整 API Key。
 * @param secret 测试可注入的应用 Secret；生产默认读取 BETTER_AUTH_SECRET。
 * @returns `v1.<iv>.<tag>.<ciphertext>` 格式的密文，不包含明文。
 * @throws API Key 为空、应用 Secret 缺失或系统随机源失败时抛错。
 * @sideEffects 读取 12 字节系统随机数作为每条记录独立的 IV。
 */
export function encryptExternalApiKey(apiKey: string, secret?: string): string {
  if (!apiKey) {
    throw new Error("API key is required for encryption");
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(
    ALGORITHM,
    deriveEncryptionKey(resolveEncryptionSecret(secret)),
    iv
  );
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(apiKey, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    ENCRYPTION_VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * 解密数据库中的版本化 API Key 密文。
 *
 * @param encryptedKey `encryptExternalApiKey` 生成的密文。
 * @param secret 测试可注入的应用 Secret；必须与加密时一致。
 * @returns 原始完整 API Key。
 * @throws 密文格式、版本、认证标签或 Secret 不匹配时抛出稳定错误。
 * @sideEffects 未显式传入 secret 时读取进程环境变量；不修改输入。
 */
export function decryptExternalApiKey(
  encryptedKey: string,
  secret?: string
): string {
  try {
    const [version, ivValue, authTagValue, ciphertextValue, extra] =
      encryptedKey.split(".");
    if (
      version !== ENCRYPTION_VERSION ||
      !ivValue ||
      !authTagValue ||
      !ciphertextValue ||
      extra !== undefined
    ) {
      throw new Error("Invalid encrypted API key format");
    }
    const iv = Buffer.from(ivValue, "base64url");
    const authTag = Buffer.from(authTagValue, "base64url");
    if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error("Invalid encrypted API key parameters");
    }
    const decipher = createDecipheriv(
      ALGORITHM,
      deriveEncryptionKey(resolveEncryptionSecret(secret)),
      iv
    );
    decipher.setAAD(AAD);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new Error("Stored API key could not be decrypted", { cause: error });
  }
}
