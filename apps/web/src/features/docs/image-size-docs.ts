/**
 * 站内生图比例与分辨率选项在文档中的像素参考。
 *
 * 表格只说明常见目标像素，不构成可提交的 size 枚举；请求使用比例与分辨率。
 */

export const IMAGE_SIZE_DOC_TABLE_HEADERS_ZH = [
  "分辨率",
  "1:1",
  "3:2",
  "2:3",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "21:9",
] as const;

export const IMAGE_SIZE_DOC_TABLE_HEADERS_EN = [
  "Resolution",
  "1:1",
  "3:2",
  "2:3",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "21:9",
] as const;

export const IMAGE_SIZE_DOC_TABLE_ROWS = [
  [
    "1K",
    "1248x1248",
    "1248x832",
    "832x1248",
    "1248x704",
    "704x1248",
    "1248x944",
    "944x1248",
    "1248x528",
  ],
  [
    "2K",
    "2048x2048",
    "2048x1360",
    "1360x2048",
    "2048x1152",
    "1152x2048",
    "2048x1536",
    "1536x2048",
    "2048x880",
  ],
  [
    "4K",
    "2880x2880",
    "3520x2352",
    "2352x3520",
    "3840x2160",
    "2160x3840",
    "3312x2496",
    "2496x3312",
    "3840x1648",
  ],
] as const;

export const IMAGE_SIZE_DOC_TABLE_NOTE_ZH =
  "表中像素仅作为比例与分辨率组合的目标参考。客户端应传 aspectRatio（或 aspect_ratio）和 resolution；不接受 auto、WIDTHxHEIGHT 或 size 参数。供应商选择尺寸配置后，平台才会在内部映射为其上游 size。";

export const IMAGE_SIZE_DOC_TABLE_NOTE_EN =
  "Pixel values are target references for resolution/aspect-ratio combinations. Clients send aspectRatio (or aspect_ratio) and resolution; auto, WIDTHxHEIGHT, and size are not accepted. FluxMedia maps them to an upstream size only when the provider selects a size configuration.";
