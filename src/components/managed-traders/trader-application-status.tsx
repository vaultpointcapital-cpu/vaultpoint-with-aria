import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { cn } from '@/lib/utils/cn';

interface TraderApplicationStatusProps {
  application: {
    status: 'pending' | 'approved' | 'rejected' | 'suspended';
    proposed_profit_split: number;
    approved_profit_split: number | null;
    reviewer_notes: string | null;
    created_at: string;
    reviewed_at: string | null;
  };
}

const STATUS_COPY: Record<TraderApplicationStatusProps['application']['status'], { title: string; body: string }> = {
  pending: {
    title: 'Application under review',
    body: "Your Managed Trader application is being reviewed. This is a manual process — you'll be notified once a decision is made.",
  },
  approved: {
    title: "You're an approved Managed Trader",
    body: 'Your profile is live in the trader directory. Clients can now discover you and allocate capital.',
  },
  rejected: {
    title: 'Application not approved',
    body: 'Your application was not approved at this time. See the reviewer notes below, if any.',
  },
  suspended: {
    title: 'Trader status suspended',
    body: 'Your Managed Trader status has been suspended. Contact support for details.',
  },
};

export function TraderApplicationStatus({ application }: TraderApplicationStatusProps) {
  const copy = STATUS_COPY[application.status];

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Card className="space-y-4 p-6">
        <CardHeader className="p-0">
          <CardTitle
            className={cn(
              application.status === 'approved' && 'text-success',
              application.status === 'rejected' && 'text-warning'
            )}
          >
            {copy.title}
          </CardTitle>
          <CardDescription>{copy.body}</CardDescription>
        </CardHeader>

        <div className="space-y-2 border-t border-border pt-4 text-sm">
          <div className="flex justify-between">
            <span className="text-text-secondary">Proposed profit split</span>
            <span className="font-mono text-text-primary">{application.proposed_profit_split}%</span>
          </div>
          {application.approved_profit_split !== null && (
            <div className="flex justify-between">
              <span className="text-text-secondary">Approved profit split</span>
              <span className="font-mono text-success">{application.approved_profit_split}%</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-text-secondary">Submitted</span>
            <span className="text-text-primary">{new Date(application.created_at).toLocaleDateString()}</span>
          </div>
          {application.reviewed_at && (
            <div className="flex justify-between">
              <span className="text-text-secondary">Reviewed</span>
              <span className="text-text-primary">{new Date(application.reviewed_at).toLocaleDateString()}</span>
            </div>
          )}
        </div>

        {application.reviewer_notes && (
          <div className="rounded-lg border border-border bg-background p-3 text-sm text-text-secondary">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-text-tertiary">Reviewer notes</p>
            {application.reviewer_notes}
          </div>
        )}
      </Card>
    </div>
  );
}
