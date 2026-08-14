'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/client';

export function DangerZone() {
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    const confirmed = window.confirm(
      'Delete your VaultPoint account? This permanently removes your broker connections, positions, savings pods, alerts, and manual assets. This cannot be undone.'
    );
    if (!confirmed) return;

    setIsDeleting(true);
    setError(null);

    const res = await fetch('/api/users/me', { method: 'DELETE' });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? 'Could not delete your account. Please try again.');
      setIsDeleting(false);
      return;
    }

    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <Card className="border-warning/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-warning">
          <AlertTriangle className="h-4 w-4" />
          Danger zone
        </CardTitle>
        <CardDescription>
          Permanently deletes your account and everything tied to it — broker connections,
          positions, savings pods, alerts, and manual assets. This cannot be undone.
        </CardDescription>
      </CardHeader>

      {error && (
        <div
          role="alert"
          className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
        >
          {error}
        </div>
      )}

      <Button variant="destructive" onClick={handleDelete} isLoading={isDeleting}>
        Delete account
      </Button>
    </Card>
  );
}
