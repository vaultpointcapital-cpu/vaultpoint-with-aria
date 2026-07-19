'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils/cn';
import type { ManagedAccountNotificationType } from '@/types/database';

interface Notification {
  id: string;
  type: ManagedAccountNotificationType;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

interface NotificationsListProps {
  accountId: string;
}

export function NotificationsList({ accountId }: NotificationsListProps) {
  const [notifications, setNotifications] = useState<Notification[] | null>(null);

  useEffect(() => {
    fetch(`/api/managed-accounts/${accountId}/notifications`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => setNotifications(body?.notifications ?? []));
  }, [accountId]);

  function markRead(id: string) {
    setNotifications((prev) => prev?.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)) ?? null);
    fetch(`/api/managed-accounts/${accountId}/notifications/${id}`, { method: 'PATCH' });
  }

  if (!notifications || notifications.length === 0) return null;

  const unreadCount = notifications.filter((n) => !n.read_at).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Notifications{unreadCount > 0 ? ` (${unreadCount} new)` : ''}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {notifications.slice(0, 10).map((notification) => (
            <button
              key={notification.id}
              type="button"
              onClick={() => markRead(notification.id)}
              className={cn(
                'w-full rounded-lg border p-3 text-left text-sm transition-colors',
                notification.read_at
                  ? 'border-border bg-surface'
                  : 'border-accent/30 bg-accent/5'
              )}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-text-primary">{notification.title}</span>
                <span className="text-xs text-text-tertiary">
                  {new Date(notification.created_at).toLocaleDateString()}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-text-secondary">{notification.body}</p>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
