import "server-only";

import { requestGoJson } from "@/server/go-backend-client";

type GenerationResponse = {
  id: string;
  userId: string;
  prompt: string;
  revisedPrompt: string | null;
  model: string;
  size: string;
  status: "pending" | "completed" | "failed";
  storageKey: string | null;
  storageBucket: string | null;
  imageUrl: string | null;
  creditsConsumed: number;
  error: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  completedAt: Date | null;
};

type GenerationWireResponse = Omit<
  GenerationResponse,
  "createdAt" | "completedAt"
> & { createdAt: string; completedAt: string | null };

function normalizeGeneration(row: GenerationWireResponse): GenerationResponse {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    completedAt: row.completedAt ? new Date(row.completedAt) : null,
  };
}

export async function getUserRecentGenerations(userId: string, limit = 12) {
  // The Go session is authoritative for the user scope; retain the argument
  // for callers that still pass the authenticated user id.
  void userId;
  const rows = await requestGoJson<GenerationWireResponse[]>(
    `/api/image-generation/recent?limit=${encodeURIComponent(String(limit))}`
  );
  return rows.map(normalizeGeneration);
}

export async function getGenerationById(id: string) {
  try {
    const row = await requestGoJson<GenerationWireResponse>(
      `/api/image-generation/${encodeURIComponent(id)}`
    );
    return normalizeGeneration(row);
  } catch (error) {
    // Preserve the old nullable contract for an absent generation while
    // allowing transport/database failures to surface to the caller.
    if (error instanceof Error && /\b404\b/.test(error.message)) return null;
    throw error;
  }
}

export async function getUserGenerations(
  userId: string,
  opts?: { limit?: number; offset?: number; status?: string }
) {
  void userId;
  const params = new URLSearchParams();
  params.set("limit", String(opts?.limit || 20));
  params.set("offset", String(opts?.offset || 0));
  if (opts?.status) params.set("status", opts.status);
  const rows = await requestGoJson<GenerationWireResponse[]>(
    `/api/image-generation/list?${params.toString()}`
  );
  return rows.map(normalizeGeneration);
}

export async function getUserGenerationsCount(userId: string, status?: string) {
  void userId;
  const query = status
    ? `?status=${encodeURIComponent(status)}`
    : "";
  const result = await requestGoJson<{ count: number }>(
    `/api/image-generation/count${query}`
  );
  return result.count;
}

export async function getGenerationStats() {
  throw new Error(
    "Generation statistics are not exposed by the Go first-party API yet"
  );
}
