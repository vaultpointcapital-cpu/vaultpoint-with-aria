/**
 * Small hand-drawn-style line illustration for the empty Pods state —
 * a stack of coins growing into a jar, in brand tokens only (accent +
 * success), no external image asset needed.
 */
export function EmptyPodsIllustration() {
  return (
    <svg width="120" height="96" viewBox="0 0 120 96" fill="none" aria-hidden>
      <ellipse cx="60" cy="86" rx="40" ry="6" className="fill-surface-elevated" />
      <path
        d="M34 40c0-13 12-24 26-24s26 11 26 24v30a8 8 0 0 1-8 8H42a8 8 0 0 1-8-8V40Z"
        className="fill-surface-elevated stroke-accent"
        strokeWidth="2"
      />
      <path d="M34 46h52" className="stroke-accent" strokeWidth="2" strokeDasharray="4 4" />
      <rect x="52" y="20" width="16" height="8" rx="3" className="fill-accent" />
      <circle cx="60" cy="60" r="9" className="fill-success/20 stroke-success" strokeWidth="2" />
      <text x="60" y="64" textAnchor="middle" className="fill-success text-[10px] font-bold">
        $
      </text>
      <circle cx="42" cy="70" r="6" className="fill-success/20 stroke-success" strokeWidth="1.5" />
      <circle cx="78" cy="68" r="6" className="fill-success/20 stroke-success" strokeWidth="1.5" />
    </svg>
  );
}
