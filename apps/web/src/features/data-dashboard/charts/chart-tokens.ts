/**
 * 用户数据看板内联的 Lieflat Mono token 正本。
 *
 * 使用方：四张 React SVG 与 ChartFrame。黑灰数据 token 来自 lieflat-charts
 * `mono-tokens.js`；纸面按产品要求改为纯白，不读取应用 primary 或主题品牌色。
 */

/** 纯白纸面、炭黑与七级灰阶；明度是唯一系列区分。 */
export const LIEFLAT_MONO_TOKENS = {
  ink: "#1C1C1A",
  paper: "#FFFFFF",
  muted: "#8F8E88",
  faint: "#C6C5BF",
  grid: "#DEDDD6",
  ladder: [
    "#1C1C1A",
    "#4A4944",
    "#6A6963",
    "#8F8E88",
    "#B0AFA9",
    "#C6C5BF",
    "#D8D7D1",
  ],
} as const;

/** 规划审计锁定的四个真实 gallery 模板标识。 */
export const DATA_DASHBOARD_CHART_TEMPLATES = {
  images: "F2-hairline-line",
  credits: "F3-hairline-area",
  videos: "L3-barcode-lollipop",
  composition: "G4-dot-waffle",
} as const;

/**
 * Lieflat 手写 SVG 入场动画。
 *
 * reduced-motion 下完全移除 pop/fade/draw 动画和 dash 偏移，避免持续运动。
 */
export const LIEFLAT_CHART_MOTION_CSS = `
  .lieflat-pop { transform-box: fill-box; transform-origin: center; animation: lieflat-pop .5s cubic-bezier(.25,1,.5,1) both; }
  .lieflat-fade { animation: lieflat-fade .9s cubic-bezier(.25,1,.5,1) both; }
  .lieflat-draw { stroke-dasharray: 1; stroke-dashoffset: 1; animation: lieflat-draw 1s cubic-bezier(.25,1,.5,1) both; }
  .lieflat-reveal[data-revealed="false"] .lieflat-pop,
  .lieflat-reveal[data-revealed="false"] .lieflat-fade,
  .lieflat-reveal[data-revealed="false"] .lieflat-draw { animation-play-state: paused; }
  @keyframes lieflat-pop { from { transform: scale(0); } to { transform: none; } }
  @keyframes lieflat-fade { from { opacity: 0; } }
  @keyframes lieflat-draw { to { stroke-dashoffset: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .lieflat-pop, .lieflat-fade { animation: none; }
    .lieflat-draw { animation: none; stroke-dasharray: none; stroke-dashoffset: 0; }
  }
`;
