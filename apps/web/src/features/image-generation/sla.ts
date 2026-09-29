import { db } from "@repo/database";
import { generation } from "@repo/database/schema";
import { desc, inArray } from "drizzle-orm";
export {
  classifyGenerationError,
  type GenerationErrorCategory,
} from "./sla-classification";
import { classifyGenerationError } from "./sla-classification";

export type GenerationSlaStats = {
  sampleSize: number;
  completed: number;
  failed: number;
  successRate: number;
  platformErrors: number;
  moderationErrors: number;
  userRequestErrors: number;
};

export async function getRecentGenerationSlaStats(
  limit = 1000
): Promise<GenerationSlaStats> {
  // 样本只取已完结记录(completed/failed):pending 在途任务既不属于成功也
  // 不属于失败,混进样本会让"样本数"与各分类卡片的合计对不上(差额即在途数)。
  const rows = await db
    .select({
      status: generation.status,
      error: generation.error,
    })
    .from(generation)
    .where(inArray(generation.status, ["completed", "failed"]))
    .orderBy(desc(generation.createdAt))
    .limit(limit);

  let completed = 0;
  let failed = 0;
  let platformErrors = 0;
  let moderationErrors = 0;
  let userRequestErrors = 0;

  for (const row of rows) {
    if (row.status === "completed") {
      completed += 1;
      continue;
    }
    if (row.status !== "failed") continue;

    failed += 1;
    const category = classifyGenerationError(row.error);
    if (category === "moderation") {
      moderationErrors += 1;
    } else if (category === "user_request") {
      userRequestErrors += 1;
    } else {
      platformErrors += 1;
    }
  }

  const denominator = completed + platformErrors;
  const successRate = denominator > 0 ? completed / denominator : 1;

  return {
    sampleSize: rows.length,
    completed,
    failed,
    successRate,
    platformErrors,
    moderationErrors,
    userRequestErrors,
  };
}
