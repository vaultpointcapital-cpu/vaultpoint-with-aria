'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import type { DisputeSettings } from '@/types/database';

interface DisputeSettingsFormProps {
  settings: DisputeSettings;
}

export function DisputeSettingsForm({ settings }: DisputeSettingsFormProps) {
  const router = useRouter();
  const [tier2Name, setTier2Name] = useState(settings.tier2_support_owner_name ?? '');
  const [tier3Threshold, setTier3Threshold] = useState(settings.tier3_max_authorization_ngn?.toString() ?? '');
  const [tier4Contact, setTier4Contact] = useState(settings.tier4_legal_contact ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    const response = await fetch('/api/admin/dispute-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tier2SupportOwnerName: tier2Name || null,
        tier3MaxAuthorizationNgn: tier3Threshold ? Number(tier3Threshold) : null,
        tier4LegalContact: tier4Contact || null,
      }),
    });
    setSaving(false);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error ?? 'Could not save dispute settings.');
      return;
    }
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-text-primary">Dispute policy settings</h1>
        <p className="mt-1 text-sm text-text-tertiary">
          Per the escalation spec&apos;s &quot;Open Items for Pells to Fill In Before Build.&quot; While the Tier 3
          threshold is unset, no refund/adjustment can be authorized at Tier 3 — resolutions requiring one are
          blocked until it&apos;s set here, or escalated to Tier 4.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Tier 2 — Support</CardTitle>
        </CardHeader>
        <CardContent>
          <input
            type="text"
            value={tier2Name}
            onChange={(e) => setTier2Name(e.target.value)}
            placeholder="Named Tier 2 support owner"
            className="w-full rounded-lg border border-border bg-background p-2 text-sm text-text-primary"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tier 3 — Founder/Compliance refund authorization threshold</CardTitle>
        </CardHeader>
        <CardContent>
          <input
            type="number"
            min={0}
            step="0.01"
            value={tier3Threshold}
            onChange={(e) => setTier3Threshold(e.target.value)}
            placeholder="Maximum ₦ amount Tier 3 may authorize without Tier 4 sign-off"
            className="w-full rounded-lg border border-border bg-background p-2 text-sm text-text-primary"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tier 4 — Legal contact</CardTitle>
        </CardHeader>
        <CardContent>
          <input
            type="text"
            value={tier4Contact}
            onChange={(e) => setTier4Contact(e.target.value)}
            placeholder="External legal counsel name/firm (SEC Nigeria approval process)"
            className="w-full rounded-lg border border-border bg-background p-2 text-sm text-text-primary"
          />
        </CardContent>
      </Card>

      {error && <p className="text-sm text-warning">{error}</p>}

      <Button isLoading={saving} onClick={handleSave}>
        Save
      </Button>
    </div>
  );
}
