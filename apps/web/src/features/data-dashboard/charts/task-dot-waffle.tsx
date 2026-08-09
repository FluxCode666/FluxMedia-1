/**
 * 成功任务构成 G4 Dot Waffle React SVG。
 *
 * 来源：lieflat-charts glance gallery “Where sign-ups come from”。每个点表示 1% 而非
 * 一个任务；原始图片/视频任务数持续展示，总任务为零时不生成伪比例点。
 */
import { allocateTaskWaffleDots } from "./chart-geometry";
import { LIEFLAT_MONO_TOKENS } from "./chart-tokens";

type TaskDotWaffleProps = {
  imageTaskCount: number;
  videoTaskCount: number;
  accessibleTitle: string;
  imageLabel: string;
  videoLabel: string;
  emptyLabel: string;
  titleId: string;
  descriptionId: string;
};

/** 渲染两类 100 点 Waffle 与原始任务数图例。 */
export function TaskDotWaffle({
  imageTaskCount,
  videoTaskCount,
  accessibleTitle,
  imageLabel,
  videoLabel,
  emptyLabel,
  titleId,
  descriptionId,
}: TaskDotWaffleProps) {
  const allocation = allocateTaskWaffleDots(imageTaskCount, videoTaskCount);
  const [imagePercent, videoPercent] = allocation.allocations;
  return (
    <svg
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="block h-auto max-h-[300px] w-full"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      viewBox="0 0 400 260"
    >
      <title>{accessibleTitle}</title>
      {allocation.dots.map((dot, index) => {
        const row = Math.floor(index / 10);
        const column = index % 10;
        return (
          <circle
            className="lieflat-pop"
            cx={18 + column * 17}
            cy={24 + row * 17}
            data-waffle-dot={dot.kind}
            fill={
              dot.kind === "image"
                ? LIEFLAT_MONO_TOKENS.ink
                : LIEFLAT_MONO_TOKENS.ladder[3]
            }
            key={dot.id}
            r="6.2"
            style={{ animationDelay: `${index * 8}ms` }}
          />
        );
      })}
      {allocation.dots.length === 0 ? (
        <text
          fill="var(--chart-muted)"
          fontSize="12"
          textAnchor="middle"
          x="90"
          y="108"
        >
          {emptyLabel}
        </text>
      ) : null}
      <circle cx="230" cy="72" fill={LIEFLAT_MONO_TOKENS.ink} r="6" />
      <text
        fill="var(--chart-ink)"
        fontSize="11"
        fontWeight="600"
        x="244"
        y="68"
      >
        {imageLabel}
      </text>
      <text
        fill="var(--chart-ink)"
        fontSize="16"
        fontWeight="800"
        x="244"
        y="86"
      >
        {imageTaskCount} · {imagePercent}%
      </text>
      <circle cx="230" cy="132" fill={LIEFLAT_MONO_TOKENS.ladder[3]} r="6" />
      <text
        fill="var(--chart-ink)"
        fontSize="11"
        fontWeight="600"
        x="244"
        y="128"
      >
        {videoLabel}
      </text>
      <text
        fill="var(--chart-muted)"
        fontSize="16"
        fontWeight="800"
        x="244"
        y="146"
      >
        {videoTaskCount} · {videoPercent}%
      </text>
      <text
        fill="var(--chart-faint)"
        fontSize="7"
        fontWeight="600"
        letterSpacing="0.12em"
        textAnchor="middle"
        x="200"
        y="244"
      >
        ONE DOT = ONE PERCENT OF SUCCESSFUL TASKS
      </text>
    </svg>
  );
}
