import Link from 'next/link';

/**
 * No footer existed anywhere in this codebase before the
 * production-readiness pass — added here, in the root layout, so it's
 * present on every page rather than duplicated per route group.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-border px-6 py-4 text-center text-xs text-text-tertiary">
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
        <Link href="/terms" className="hover:text-text-secondary hover:underline">
          Terms
        </Link>
        <Link href="/privacy" className="hover:text-text-secondary hover:underline">
          Privacy
        </Link>
        <Link href="/risk-disclosure" className="hover:text-text-secondary hover:underline">
          Risk Disclosure
        </Link>
        <span>© {new Date().getFullYear()} VaultPoint</span>
      </div>
    </footer>
  );
}
