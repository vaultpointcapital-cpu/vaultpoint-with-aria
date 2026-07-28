'use client';

import { useEffect, useState } from 'react';

interface PodArcProps {
  progress: number; // 0-100
  color: string;
  size?: number;
}

const STROKE_WIDTH = 6;

/**
 * SVG donut progress ring for a pod's card — replaces a flat linear bar
 * with an animated arc fill that draws in on mount (stroke-dashoffset
 * transition), per the spec's "animated fill on mount" requirement.
 */
export function PodArc({ progress, color, size = 56 }: PodArcProps) {
  const clamped = Math.min(100, Math.max(0, progress));
  const radius = (size - STROKE_WIDTH) / 2;
  const circumference = 2 * Math.PI * radius;

  // Starts at 0 and animates to the real value on mount/update — a CSS
  // transition on strokeDashoffset needs the "before" state committed to
  // the DOM first, so the target value is applied one tick later.
  const [displayProgress, setDisplayProgress] = useState(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDisplayProgress(clamped));
    return () => cancelAnimationFrame(frame);
  }, [clamped]);

  const offset = circumference - (displayProgress / 100) * circumference;

  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90" aria-hidden>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE_WIDTH}
        className="text-border"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        style={{ transition: 'stroke-dashoffset 800ms ease-out' }}
      />
    </svg>
  );
}
