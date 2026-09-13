/**
 * 服务端展示时区解析与用户偏好持久化。
 *
 * 使用方包括 Dashboard Server Components 与 user-auth UOL 操作。部署默认值由 Go
 * 后端的运行时设置提供；用户偏好也由 Go API 读取和持久化，数据库时间本身仍统一为 UTC。
 */
import { requestGoBackendJson } from "../http/go-backend";
import {
  isValidTimeZone,
  normalizeUserTimeZonePreference,
  resolveDisplayTimeZone,
} from "./index";

export type UserTimeZoneSettings = {
  timeZone: string | null;
  defaultTimeZone: string;
  effectiveTimeZone: string;
};

/**
 * 读取部署环境的默认展示时区。
 *
 * @returns 合法 APP_TIME_ZONE；未配置或非法时返回 UTC；无外部副作用。
 */
export function getAppTimeZone(): string {
  return resolveDisplayTimeZone(null, process.env.APP_TIME_ZONE);
}

/**
 * 读取用户时区偏好及最终生效值。
 *
 * @param userId 当前用户 ID。
 * @returns 用户偏好、env 默认值和最终有效时区；用户不存在时按未设置处理。
 * @throws 数据库查询失败时原样上抛，避免静默掩盖基础设施故障。
 */
export async function getUserTimeZoneSettings(
  userId: string
): Promise<UserTimeZoneSettings> {
  const profile = await requestGoBackendJson<{
    id?: string;
    timeZone?: string | null;
    defaultTimeZone?: string | null;
  }>("/api/user/profile");
  // The Go endpoint is intentionally scoped to the authenticated session. A
  // mismatched id means a caller attempted to resolve another user's setting;
  // preserving the old safe fallback avoids exposing that user's preference.
  if (profile.id && profile.id !== userId) {
    return {
      timeZone: null,
      defaultTimeZone: getAppTimeZone(),
      effectiveTimeZone: getAppTimeZone(),
    };
  }
  const rowTimeZone = normalizeUserTimeZonePreference(profile.timeZone);
  const defaultTimeZone = resolveDisplayTimeZone(
    null,
    profile.defaultTimeZone || process.env.APP_TIME_ZONE
  );
  return {
    timeZone: rowTimeZone,
    defaultTimeZone,
    effectiveTimeZone: resolveDisplayTimeZone(rowTimeZone, defaultTimeZone),
  };
}

/**
 * 读取用户最终生效的展示时区。
 *
 * @param userId 当前用户 ID。
 * @returns 用户偏好优先、APP_TIME_ZONE 兜底的合法 IANA 时区。
 */
export async function getUserTimeZone(userId: string): Promise<string> {
  return (await getUserTimeZoneSettings(userId)).effectiveTimeZone;
}

/**
 * 保存或清除用户展示时区偏好。
 *
 * @param userId 当前用户 ID。
 * @param timeZone IANA 时区；null 表示恢复继承部署环境。
 * @returns 实际写入的规范化值。
 * @throws 非法时区或数据库更新失败时抛出；不会改写部署环境。
 */
export async function setUserTimeZone(
  userId: string,
  timeZone: string | null
): Promise<string | null> {
  // The Go endpoint scopes the mutation to the authenticated session. Keep
  // the parameter in the public contract for callers that already pass it.
  void userId;
  const normalized = timeZone?.trim() || null;
  if (normalized !== null && !isValidTimeZone(normalized)) {
    throw new RangeError("无效的 IANA 时区");
  }
  const result = await requestGoBackendJson<{
    data?: { timeZone?: string | null };
  }>("/api/user/time-zone", {
    method: "POST",
    body: JSON.stringify({ timeZone: normalized }),
  });
  const returned = result.data?.timeZone;
  if (returned !== undefined) {
    return normalizeUserTimeZonePreference(returned);
  }
  return normalized;
}
