interface SparklineProps {
  data: number[];
  positive: boolean;
  width?: number;
  height?: number;
}

const SPARKLINE_HEIGHT = 40;

/**
 * Minimal trend-only line, no axes/labels/gridlines — per spec: 40px
 * tall, colored by trend direction, smooth (quadratic-curve-through-
 * midpoints, not a jagged polyline). Hand-rolled instead of pulling in
 * recharts for a chart this small — recharts is already a dependency
 * (used elsewhere for the bigger portfolio charts) but its SVG/DOM
 * overhead isn't worth it for a 40px trend line repeated per ticker chip.
 */
export function Sparkline({ data, positive, width = 96, height = SPARKLINE_HEIGHT }: SparklineProps) {
  if (data.length < 2) {
    // Not enough history yet (e.g. just after page load) — a flat
    // midline beats an empty gap or a misleadingly single-point "trend".
    return (
      <svg width={width} height={height} className="shrink-0" aria-hidden>
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="currentColor"
          strokeWidth={1.5}
          className="text-text-tertiary"
        />
      </svg>
    );
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);

  const points = data.map((value, i) => ({
    x: i * stepX,
    // Inset vertically so the line never clips at the very top/bottom edge.
    y: height - 4 - ((value - min) / range) * (height - 8),
  }));

  // Quadratic-through-midpoints: each segment curves toward the midpoint
  // of the next pair, using the current point as the control — a small,
  // dependency-free way to get a rounded line through scattered points
  // without a real Catmull-Rom/Bezier spline library. `points.length >= 2`
  // is guaranteed by the early return above, so the indexing below is safe.
  const first = points[0]!;
  let path = `M ${first.x} ${first.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const point = points[i]!;
    const next = points[i + 1]!;
    const midX = (point.x + next.x) / 2;
    const midY = (point.y + next.y) / 2;
    path += ` Q ${point.x} ${point.y} ${midX} ${midY}`;
  }
  const last = points[points.length - 1]!;
  const secondLast = points[points.length - 2]!;
  path += ` Q ${secondLast.x} ${secondLast.y} ${last.x} ${last.y}`;

  return (
    <svg width={width} height={height} className={cnColor(positive)} aria-hidden>
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  );
}

function cnColor(positive: boolean): string {
  return positive ? 'text-success' : 'text-warning';
}
