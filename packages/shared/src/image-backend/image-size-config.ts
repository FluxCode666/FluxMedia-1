import { z } from "zod";

const valueSchema = z.string().trim().min(1).max(64);

export const imageSizeConfigMappingSchema = z
  .object({
    resolution: valueSchema,
    aspectRatio: valueSchema,
    size: valueSchema,
  })
  .strict()
  .transform((value) => ({
    resolution: value.resolution.trim(),
    aspectRatio: value.aspectRatio.trim(),
    size: value.size.trim(),
  }));

export const imageSizeConfigMappingsSchema = z
  .array(imageSizeConfigMappingSchema)
  .max(500)
  .superRefine((mappings, context) => {
    if (mappings.length === 0) {
      context.addIssue({
        code: "custom",
        message: "至少需要一条尺寸映射",
      });
    }
    const keys = new Set<string>();
    for (const [index, mapping] of mappings.entries()) {
      const key = `${mapping.resolution.toLowerCase()}|${mapping.aspectRatio.toLowerCase()}`;
      if (keys.has(key)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "resolution + aspectRatio 映射不能重复",
        });
      }
      keys.add(key);
    }
  });

export const imageSizeConfigSnapshotSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(120),
    mappings: imageSizeConfigMappingsSchema,
  })
  .strict();

export const imageSizeConfigInputSchema = z
  .object({
    id: z.string().trim().min(1).max(128).optional(),
    name: z.string().trim().min(1).max(120),
    mappings: imageSizeConfigMappingsSchema,
  })
  .strict();

export const imageSizeConfigOptionSchema = z
  .object({ id: z.string(), name: z.string() })
  .strict();

export type ImageSizeConfigMapping = z.infer<typeof imageSizeConfigMappingSchema>;
export type ImageSizeConfigMappings = z.infer<typeof imageSizeConfigMappingsSchema>;
export type ImageSizeConfigSnapshot = z.infer<typeof imageSizeConfigSnapshotSchema>;
export type ImageSizeConfigInput = z.infer<typeof imageSizeConfigInputSchema>;

export function normalizeImageSizeConfigKey(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveImageSizeConfigMapping(
  config: ImageSizeConfigSnapshot | null | undefined,
  resolution: string | undefined,
  aspectRatio: string | undefined
): ImageSizeConfigMapping | null {
  if (!config || !resolution || !aspectRatio) return null;
  const resolutionKey = normalizeImageSizeConfigKey(resolution);
  const aspectRatioKey = normalizeImageSizeConfigKey(aspectRatio);
  return (
    config.mappings.find(
      (mapping) =>
        normalizeImageSizeConfigKey(mapping.resolution) === resolutionKey &&
        normalizeImageSizeConfigKey(mapping.aspectRatio) === aspectRatioKey
    ) ?? null
  );
}
