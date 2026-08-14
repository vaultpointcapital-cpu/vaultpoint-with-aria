'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { updateProfileSchema, COUNTRY_OPTIONS, type UpdateProfileInput } from '@/lib/validations/settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const SELECT_CLASSNAME =
  'flex h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-accent transition-colors';

interface ProfileFormProps {
  initialFullName: string;
  initialCountryCode: string;
}

export function ProfileForm({ initialFullName, initialCountryCode }: ProfileFormProps) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<UpdateProfileInput>({
    resolver: zodResolver(updateProfileSchema),
    defaultValues: {
      fullName: initialFullName,
      countryCode: initialCountryCode || undefined,
    },
  });

  async function onSubmit(data: UpdateProfileInput) {
    setServerError(null);
    setSaved(false);

    const res = await fetch('/api/users/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setServerError(body?.error ?? 'Could not save changes.');
      return;
    }

    setSaved(true);
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {serverError && (
        <div
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
        >
          {serverError}
        </div>
      )}
      {saved && (
        <div
          role="status"
          className="rounded-lg border border-success/30 bg-success/10 px-4 py-2 text-xs text-success"
        >
          Saved.
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="fullName">Full name</Label>
        <Input id="fullName" {...register('fullName')} />
        {errors.fullName && <p className="text-xs text-warning">{errors.fullName.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="countryCode">Country</Label>
        <select id="countryCode" className={SELECT_CLASSNAME} {...register('countryCode')}>
          <option value="">Select a country</option>
          {COUNTRY_OPTIONS.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
        {errors.countryCode && <p className="text-xs text-warning">{errors.countryCode.message}</p>}
      </div>

      <Button type="submit" isLoading={isSubmitting}>
        Save changes
      </Button>
    </form>
  );
}
