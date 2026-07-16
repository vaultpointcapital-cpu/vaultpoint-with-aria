'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutGrid, TrendingUp, Target, Bell } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils/cn';
import type { SubscriptionTier } from '@/types/database';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Portfolio', icon: LayoutGrid },
  { href: '/dashboard/markets', label: 'Markets', icon: TrendingUp },
  { href: '/dashboard/pods', label: 'Savings Pods', icon: Target },
  { href: '/dashboard/alerts', label: 'Alerts', icon: Bell },
];

export function DashboardNav({
  userName,
  tier,
}: {
  userName: string | null;
  tier: SubscriptionTier;
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  const initials = userName
    ? userName
        .split(' ')
        .map((n) => n[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : '?';

  return (
    <nav className="flex items-center gap-1 border-b border-border bg-surface px-5">
      <span className="mr-8 font-display text-lg font-bold text-accent">VaultPoint</span>

      {NAV_ITEMS.map((item) => {
        const isActive = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'border-b-2 px-4 py-3.5 text-sm font-medium transition-colors',
              isActive
                ? 'border-accent text-accent'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            )}
          >
            {item.label}
          </Link>
        );
      })}

      <div className="ml-auto flex items-center gap-3">
        <span className="text-[11px] font-semibold uppercase text-text-tertiary">{tier}</span>
        <button
          onClick={handleLogout}
          title="Log out"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-accent to-info text-xs font-semibold text-white"
        >
          {initials}
        </button>
      </div>
    </nav>
  );
}
