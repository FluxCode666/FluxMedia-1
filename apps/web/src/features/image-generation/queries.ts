import "server-only";

import { db } from "@repo/database";
import { generation } from "@repo/database/schema";
import { expireStalePendingGenerations } from "@repo/shared/generation-maintenance";
import { and, count, desc, eq, gte, isNotNull, or, sum } from "drizzle-orm";

export async function getUserRecentGenerations(userId: string, limit = 12) {
  return db
    .select()
    .from(generation)
    .where(
      and(
        eq(generation.userId, userId),
        or(
          and(
            eq(generation.status, "completed"),
            isNotNull(generation.storageKey)
          ),
          eq(generation.status, "pending")
        )
      )
    )
    .orderBy(desc(generation.createdAt))
    .limit(limit);
}

export async function getGenerationById(id: string) {
  await expireStalePendingGenerations({ limit: 100 });
  const rows = await db
    .select()
    .from(generation)
    .where(eq(generation.id, id))
    .limit(1);
  return rows[0] || null;
}

export async function getUserGenerations(
  userId: string,
  opts?: { limit?: number; offset?: number; status?: string }
) {
  await expireStalePendingGenerations({ userId, limit: 100 });
  const conditions = [eq(generation.userId, userId)];
  if (opts?.status) {
    conditions.push(
      eq(generation.status, opts.status as "pending" | "completed" | "failed")
    );
  }

  return db
    .select()
    .from(generation)
    .where(and(...conditions))
    .orderBy(desc(generation.createdAt))
    .limit(opts?.limit || 20)
    .offset(opts?.offset || 0);
}

export async function getUserGenerationsCount(userId: string, status?: string) {
  await expireStalePendingGenerations({ userId, limit: 100 });
  const conditions = [eq(generation.userId, userId)];
  if (status) {
    conditions.push(
      eq(generation.status, status as "pending" | "completed" | "failed")
    );
  }

  const result = await db
    .select({ count: count() })
    .from(generation)
    .where(and(...conditions));
  return result[0]?.count || 0;
}

export async function getGenerationStats() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [totalResult, todayResult, completedResult, creditsResult] =
    await Promise.all([
      db.select({ count: count() }).from(generation),
      db
        .select({ count: count() })
        .from(generation)
        .where(gte(generation.createdAt, todayStart)),
      db
        .select({ count: count() })
        .from(generation)
        .where(eq(generation.status, "completed")),
      db.select({ total: sum(generation.creditsConsumed) }).from(generation),
    ]);

  return {
    total: totalResult[0]?.count || 0,
    today: todayResult[0]?.count || 0,
    completed: completedResult[0]?.count || 0,
    creditsConsumed: Number(creditsResult[0]?.total) || 0,
  };
}
