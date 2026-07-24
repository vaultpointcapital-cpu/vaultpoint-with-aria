import Link from 'next/link';

export default function VerifyEmailPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 text-2xl">
          ✉️
        </div>
        <h1 className="font-display text-xl font-semibold text-text-primary">
          Verify your email
        </h1>
        <p className="mt-2 text-sm text-text-secondary">
          We&apos;ve sent a confirmation link to your email address. Click it to activate your
          account, then come back here to log in.
        </p>
        <Link href="/login" className="mt-4 inline-block text-sm text-accent-light hover:underline">
          Back to login
        </Link>
      </div>
    </div>
  );
}
