/**
 * 账号池凭据健康状态批量读取服务。
 *
 * 职责：一次查询读取全部 Adobe Direct 成员的最小健康摘要，严格校验数据库结果并
 * 计算页面当前生效状态。使用方是 human-only UOL binding；不返回诊断或任何凭据。
 */
import { sql } from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";
import {
  type AdobeCredentialHealthStatus,
  getEffectiveAdobeCredentialHealthStatus,
} from "./adobe-credential-health-status";

/** 页面筛选所需的最小凭据健康状态项。 */
export interface AdobeCredentialHealthStatusListItem {
  memberId: string;
  status: AdobeCredentialHealthStatus;
}

const healthStatusRowSchema = z.object({
  member_id: z.string().trim().min(1).max(128),
  status: z
    .enum(["pending", "healthy", "degraded", "isolated", "overdue"])
    .nullable(),
  failure_profiles: z.unknown().nullable(),
  last_check_at: z.coerce.date().nullable(),
  last_success_at: z.coerce.date().nullable(),
  next_check_at: z.coerce.date().nullable(),
});

/** 从未知数据库 JSON 中只保留支持的凭据 Profile。 */
function parseFailureProfiles(value: unknown): Array<"express" | "firefly"> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (profile): profile is "express" | "firefly" =>
      profile === "express" || profile === "firefly"
  );
}

/**
 * 将批量数据库结果映射为不含诊断的当前健康状态。
 *
 * @param values 未信任的数据库结果行。
 * @param now 本次页面快照时间。
 * @returns 保持查询顺序的成员 ID 与当前生效状态；缺少摘要的旧成员视为待检查。
 * @sideEffects 无。
 * @failure 任一行字段不符合严格契约时抛出 ZodError。
 */
export function mapAdobeCredentialHealthStatusRows(
  values: readonly unknown[],
  now: Date
): AdobeCredentialHealthStatusListItem[] {
  return values.map((value) => {
    const row = healthStatusRowSchema.parse(value);
    return {
      memberId: row.member_id,
      status: row.status
        ? getEffectiveAdobeCredentialHealthStatus(
            {
              status: row.status,
              failureProfiles: parseFailureProfiles(row.failure_profiles),
              lastCheckedAt: row.last_check_at,
              lastSuccessAt: row.last_success_at,
              nextCheckAt: row.next_check_at,
            },
            now
          )
        : "pending",
    };
  });
}

/**
 * 一次查询列出全部 Adobe Direct 成员的当前凭据健康状态。
 *
 * @param now 本次页面快照时间，默认当前时间。
 * @returns 仅含 memberId 和 status 的安全列表。
 * @sideEffects 读取数据库；不补写摘要、不访问 Adobe、不记录诊断。
 * @failure 数据库失败或结果不符合契约时向上抛出。
 */
export async function listAdobeCredentialHealthStatuses(
  now = new Date()
): Promise<AdobeCredentialHealthStatusListItem[]> {
  const { db } = await import("@repo/database");
  const rows = extractExecuteRows(
    await db.execute(sql`
      select
        member.id as member_id,
        health.status,
        health.failure_profiles,
        health.last_check_at,
        health.last_success_at,
        health.next_check_at
      from image_backend_member as member
      inner join image_backend_member_adobe_config as adobe
        on adobe.member_id = member.id
        and adobe.mode = 'direct'
      left join adobe_credential_health as health
        on health.member_id = member.id
      where member.type = 'adobe'
      order by member.priority asc, member.id asc
    `)
  );
  return mapAdobeCredentialHealthStatusRows(rows, now);
}
