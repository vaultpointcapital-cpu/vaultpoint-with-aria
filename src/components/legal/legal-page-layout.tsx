import type { ReactNode } from 'react';

interface LegalPageLayoutProps {
  title: string;
  lastUpdated: string;
  children: ReactNode;
}

/**
 * Shared wrapper for /terms, /privacy, /risk-disclosure — enforces the
 * one requirement that must never be skipped on any of them: the draft
 * watermark. No `prose` classes (no @tailwindcss/typography plugin is
 * installed in this project) — plain utility-styled sections instead,
 * matching the rest of the app's own dark theme rather than an
 * unconfigured class that would silently do nothing.
 */
export function LegalPageLayout({ title, lastUpdated, children }: LegalPageLayoutProps) {
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div
        role="alert"
        className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm font-medium text-warning"
      >
        Draft — pending review by licensed counsel.
      </div>

      <div>
        <h1 className="font-display text-2xl font-semibold text-text-primary">{title}</h1>
        <p className="mt-1 text-xs text-text-tertiary">Last updated {lastUpdated}</p>
      </div>

      <div className="space-y-5 text-sm leading-relaxed text-text-secondary [&_h2]:font-display [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-text-primary [&_p]:mt-2 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:mt-1">
        {children}
      </div>

      <div
        role="alert"
        className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm font-medium text-warning"
      >
        Draft — pending review by licensed counsel.
      </div>
    </div>
  );
}
