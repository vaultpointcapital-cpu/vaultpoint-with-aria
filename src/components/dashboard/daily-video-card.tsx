'use client';

import { useState } from 'react';
import { PlayCircle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { VideoEmbed } from '@/components/academy/video-embed';
import type { AcademyVideo } from '@/types/database';

interface DailyVideoCardProps {
  video: AcademyVideo | null;
}

/**
 * Renders nothing if there's no active daily_short row — a missing daily
 * video is a maintenance gap on the founder's end, not something worth
 * an error or empty state for what's a nice-to-have re-engagement card.
 */
export function DailyVideoCard({ video }: DailyVideoCardProps) {
  const [open, setOpen] = useState(false);

  if (!video) return null;

  return (
    <>
      <Card
        onClick={() => setOpen(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="flex cursor-pointer items-center gap-3 transition-colors hover:border-accent/50"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/10">
          <PlayCircle className="h-5 w-5 text-accent" />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
            Today&apos;s lesson
          </p>
          <p className="truncate text-sm font-semibold text-text-primary">{video.title}</p>
        </div>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{video.title}</DialogTitle>
          </DialogHeader>
          <VideoEmbed provider={video.video_provider} videoId={video.video_id} title={video.title} />
        </DialogContent>
      </Dialog>
    </>
  );
}
