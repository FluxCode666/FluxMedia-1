/**
 * API Images 成员的请求字段映射模板服务。
 *
 * 职责：为统一号池管理页提供映射模板列表、保存和删除；
 * 所有字段规则在写入前用共享 schema 归一，不承载旧账号池调度语义。
 */
import {
  normalizeRequestParameterMappings,
  type RequestParameterMapping,
} from "@repo/shared/image-backend/request-parameter-mapping";
import { asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

const templateNameSchema = z.string().trim().min(1).max(120);
const templateIdSchema = z.string().trim().min(1).max(128);

/** 列出全部映射模板，返回可直接给 UOL 的已归一快照。 */
export async function listBackendParameterMappingTemplates() {
  const { db, imageBackendParameterMappingTemplate } = await import(
    "@repo/database"
  );
  const rows = await db
    .select({
      id: imageBackendParameterMappingTemplate.id,
      name: imageBackendParameterMappingTemplate.name,
      parameterMappings: imageBackendParameterMappingTemplate.parameterMappings,
      createdAt: imageBackendParameterMappingTemplate.createdAt,
      updatedAt: imageBackendParameterMappingTemplate.updatedAt,
    })
    .from(imageBackendParameterMappingTemplate)
    .orderBy(asc(imageBackendParameterMappingTemplate.name));
  return rows.map((row) => ({
    ...row,
    parameterMappings: normalizeRequestParameterMappings(row.parameterMappings),
  }));
}

/**
 * 新建或更新映射模板。
 *
 * @param input 可选模板 ID、名称和严格映射规则。
 * @returns 已保存的稳定 ID；更新不存在的 ID 时抛出可定位错误。
 */
export async function saveBackendParameterMappingTemplate(input: {
  id?: string;
  name: string;
  parameterMappings: RequestParameterMapping[];
}): Promise<string> {
  const { db, imageBackendParameterMappingTemplate } = await import(
    "@repo/database"
  );
  const name = templateNameSchema.parse(input.name);
  const parameterMappings = normalizeRequestParameterMappings(
    input.parameterMappings
  );
  const now = new Date();
  if (input.id) {
    const id = templateIdSchema.parse(input.id);
    const updated = await db
      .update(imageBackendParameterMappingTemplate)
      .set({ name, parameterMappings, updatedAt: now })
      .where(eq(imageBackendParameterMappingTemplate.id, id))
      .returning({ id: imageBackendParameterMappingTemplate.id });
    if (!updated[0]) throw new Error("请求字段映射模板不存在");
    return updated[0].id;
  }

  const id = nanoid();
  await db.insert(imageBackendParameterMappingTemplate).values({
    id,
    name,
    parameterMappings,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** 删除一个映射模板；重复删除保持幂等。 */
export async function deleteBackendParameterMappingTemplate(
  templateId: string
): Promise<void> {
  const { db, imageBackendParameterMappingTemplate } = await import(
    "@repo/database"
  );
  const id = templateIdSchema.parse(templateId);
  await db
    .delete(imageBackendParameterMappingTemplate)
    .where(eq(imageBackendParameterMappingTemplate.id, id));
}
