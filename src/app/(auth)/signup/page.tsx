'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { signupSchema, type SignupInput } from '@/lib/validations/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function SignupPage() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignupInput>({
    resolver: zodResolver(signupSchema),
  });

  async function onSubmit(data: SignupInput) {
    setServerError(null);
    setIsSubmitting(true);

    // Goes through our own API route (which sends its own branded
    // confirmation email via Resend) rather than calling
    // supabase.auth.signUp() directly — see
    // src/app/api/auth/signup/route.ts's own comment for why.
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    setIsSubmitting(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      // The route's own error messages are already safe to show — same
      // as Supabase's own error strings were (e.g. "User already
      // registered").
      setServerError(body?.error ?? 'Could not create your account. Please try again.');
      return;
    }

    router.push('/verify-email');
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="font-display text-2xl font-bold text-accent">VaultPoint</h1>
          <p className="mt-2 text-sm text-text-secondary">
            Create your account to start tracking your portfolio
          </p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 rounded-xl border border-border bg-surface p-6">
          {serverError && (
            <div
              role="alert"
              className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
            >
              {serverError}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="fullName">Full name</Label>
            <Input
              id="fullName"
              type="text"
              autoComplete="name"
              placeholder="Pells Meir"
              {...register('fullName')}
            />
            {errors.fullName && (
              <p className="text-xs text-warning">{errors.fullName.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              {...register('email')}
            />
            {errors.email && <p className="text-xs text-warning">{errors.email.message}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              placeholder="At least 8 characters"
              {...register('password')}
            />
            {errors.password && (
              <p className="text-xs text-warning">{errors.password.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Confirm password</Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              {...register('confirmPassword')}
            />
            {errors.confirmPassword && (
              <p className="text-xs text-warning">{errors.confirmPassword.message}</p>
            )}
          </div>

          <Button type="submit" className="w-full" isLoading={isSubmitting}>
            Create account
          </Button>

          <p className="text-center text-xs text-text-tertiary">
            By signing up you agree this is a tracking tool only — VaultPoint never executes
            trades on your behalf.
          </p>
        </form>

        <p className="mt-6 text-center text-sm text-text-secondary">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-accent hover:underline">
            Log in
          </Link>
        </p>
      </div>
    </div>
  );
}
