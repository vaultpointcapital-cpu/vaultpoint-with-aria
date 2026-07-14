'use client';

import { useState } from 'react';
import { Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PodCard } from '@/components/pods/pod-card';
import { CreatePodDialog } from '@/components/pods/create-pod-dialog';
import { PodDetailDialog } from '@/components/pods/pod-detail-dialog';
import { canCreateAnotherPod } from '@/lib/validations/pods';
import type { SavingsPod, SubscriptionTier } from '@/types/database';

interface PodsClientProps {
  initialPods: SavingsPod[];
  subscriptionTier: SubscriptionTier;
}

export function PodsClient({ initialPods, subscriptionTier }: PodsClientProps) {
  const [pods, setPods] = useState<SavingsPod[]>(initialPods);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedPodId, setSelectedPodId] = useState<string | null>(null);

  const canCreate = canCreateAnotherPod(subscriptionTier, pods.length);
  const selectedPod = pods.find((p) => p.id === selectedPodId) ?? null;

  function handleCreated(pod: SavingsPod) {
    setPods((prev) => [pod, ...prev]);
  }

  function handleContributed(podId: string, newCurrentAmount: number) {
    setPods((prev) =>
      prev.map((p) => (p.id === podId ? { ...p, current_amount: newCurrentAmount } : p))
    );
  }

  if (pods.length === 0) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6 p-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10">
          <Target className="h-7 w-7 text-accent" />
        </div>
        <div>
          <h2 className="font-display text-xl font-semibold text-text-primary">
            Start your first Savings Pod
          </h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-text-secondary">
            Set a target, pick a color, and start contributing whenever you like. We&apos;ll
            track your progress automatically.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>Create a pod</Button>

        <CreatePodDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={handleCreated} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-xl font-semibold text-text-primary">Savings Pods</h1>
        <div className="text-right">
          <span title={!canCreate ? `Your ${subscriptionTier} plan has reached its pod limit. Upgrade for more.` : undefined}>
            <Button onClick={() => setCreateOpen(true)} disabled={!canCreate}>
              + New Pod
            </Button>
          </span>
          {!canCreate && (
            <p className="mt-1 text-xs text-text-tertiary">
              Your {subscriptionTier} plan has reached its pod limit. Upgrade for more.
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {pods.map((pod) => (
          <PodCard key={pod.id} pod={pod} onClick={() => setSelectedPodId(pod.id)} />
        ))}
      </div>

      <CreatePodDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={handleCreated} />

      {selectedPod && (
        <PodDetailDialog
          pod={selectedPod}
          open={selectedPodId !== null}
          onOpenChange={(open) => {
            if (!open) setSelectedPodId(null);
          }}
          onContributed={handleContributed}
        />
      )}
    </div>
  );
}
