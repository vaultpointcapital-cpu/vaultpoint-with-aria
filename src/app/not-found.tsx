import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Page not found — VaultPoint' };

/**
 * Next.js App Router's special file for any unmatched route — was
 * falling back to the framework's generic default page before this.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10">
        <span className="font-display text-2xl font-bold text-accent">V</span>
      </div>
      <div>
        <h1 className="font-display text-xl font-semibold text-text-primary">Page not found</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-text-secondary">
          The page you&apos;re looking for doesn&apos;t exist or has moved.
        </p>
      </div>
      <Link
        href="/"
        className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
      >
        Back to VaultPoint
      </Link>
    </div>
  );
}
