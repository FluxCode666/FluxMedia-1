import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function buildStorageUrl(bucket: string | null, key: string | null) {
  return buildSignedStorageImageUrl(key, bucket) || undefined;
}

export function getPromptRepairNotice(metadata: unknown) {
  const repair = asRecord(asRecord(metadata).moderationPromptRepair);
  if (repair.succeeded !== true) return undefined;
  return (
    stringValue(repair.notice) ||
    "The original prompt was rejected by safety checks, so this request was generated after additional prompt adjustments."
  );
}

export function getImageOutputs(metadata: unknown, bucket: string | null) {
  const outputImage = asRecord(asRecord(metadata).outputImage);
  const outputs = outputImage.imageOutputs;
  const promptRepairNotice = getPromptRepairNotice(metadata);
  if (!Array.isArray(outputs)) return [];
  return outputs.flatMap((item, index) => {
    const output = asRecord(item);
    const storageKey = stringValue(output.storageKey);
    const imageUrl =
      (storageKey ? buildStorageUrl(bucket, storageKey) : undefined) ||
      stringValue(output.imageUrl);
    const generationId = stringValue(output.generationId);
    if (!imageUrl && !generationId) return [];
    return [
      {
        generationId,
        imageUrl,
        imageFileId: stringValue(output.imageFileId),
        size: stringValue(output.size),
        revisedPrompt: stringValue(output.revisedPrompt),
        upstreamRevisedPrompt: stringValue(output.upstreamRevisedPrompt),
        promptRepairNotice,
        index,
        outputRole:
          output.role === "choice" || output.role === "final"
            ? output.role
            : undefined,
      },
    ];
  });
}
