/**
 * 站内生图尺寸选择器在文档中的公开契约。
 *
 * 这些值与 image-size-selection.ts 的 1K/2K/4K 基准和比例选项保持一致；表格
 * 展示的是经过 16px 步长、最小/最大像素和最大宽高比约束规整后的最终尺寸。
 */

export const IMAGE_SIZE_DOC_ENUM_VALUES = [
  "auto",
  "1248x1248",
  "1248x832",
  "832x1248",
  "1248x704",
  "704x1248",
  "1248x944",
  "944x1248",
  "1248x528",
  "2048x2048",
  "2048x1360",
  "1360x2048",
  "2048x1152",
  "1152x2048",
  "2048x1536",
  "1536x2048",
  "2048x880",
  "2880x2880",
  "3520x2352",
  "2352x3520",
  "3840x2160",
  "2160x3840",
  "3312x2496",
  "2496x3312",
  "3840x1648",
] as const;

export const IMAGE_SIZE_DOC_ENUM_ZH = IMAGE_SIZE_DOC_ENUM_VALUES.join("、");
export const IMAGE_SIZE_DOC_ENUM_EN = IMAGE_SIZE_DOC_ENUM_VALUES.join(", ");

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
  "auto 表示由后端决定。标准比例尺寸会自动规整为 16 的倍数；宽高均须在 256–3840px 之间，总像素为 655,360–8,294,400，宽高比不超过 3:1。4K 档的方图和部分比例会受总像素上限约束，表中为规整后的实际尺寸。除上述标准枚举外，也可传入符合这些约束的自定义 WIDTHxHEIGHT。";

export const IMAGE_SIZE_DOC_TABLE_NOTE_EN =
  "auto lets the backend decide. Standard ratio sizes are rounded to multiples of 16; each edge must be 256–3840px, total pixels 655,360–8,294,400, and the aspect ratio must not exceed 3:1. The 4K square and some 4K ratios are reduced by the total-pixel cap; the table shows the resulting dimensions. Custom WIDTHxHEIGHT values that satisfy these constraints are also accepted.";
