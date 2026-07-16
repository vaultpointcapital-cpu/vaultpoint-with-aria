'use client';

import { useState } from 'react';
import { PlayCircle } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { VideoEmbed } from '@/components/academy/video-embed';
import type { AcademyVideo } from '@/types/database';

interface AcademyVideosSectionProps {
  videos: AcademyVideo[];
}

/**
 * Renders nothing if there are no long-form videos — this is bonus
 * content, not core functionality, so an empty state would just be
 * clutter on the Settings page rather than something worth explaining.
 */
export function AcademyVideosSection({ videos }: AcademyVideosSectionProps) {
  const [openVideo, setOpenVideo] = useState<AcademyVideo | null>(null);

  if (videos.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Meir FX Academy</CardTitle>
        <CardDescription>Short lessons from the Academy team.</CardDescription>
      </CardHeader>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {videos.map((video) => (
          <button
            key={video.id}
            type="button"
            onClick={() => setOpenVideo(video)}
            className="group flex flex-col overflow-hidden rounded-lg border border-border bg-surface-elevated text-left transition-colors hover:border-accent/50"
          >
            <div className="relative flex aspect-video items-center justify-center bg-black/40">
              {video.thumbnail_url && (
                // eslint-disable-next-line @next/next/no-img-element -- external, unconfigured host; not worth a next/image domains entry for an optional thumbnail
                <img src={video.thumbnail_url} alt="" className="h-full w-full object-cover" />
              )}
              <PlayCircle className="absolute h-10 w-10 text-white/80 transition-transform group-hover:scale-110" />
            </div>
            <div className="p-3">
              <p className="text-sm font-semibold text-text-primary">{video.title}</p>
              {video.description && (
                <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{video.description}</p>
              )}
            </div>
          </button>
        ))}
      </div>

      <Dialog open={openVideo !== null} onOpenChange={(open) => !open && setOpenVideo(null)}>
        <DialogContent className="max-w-2xl">
          {openVideo && (
            <>
              <DialogHeader>
                <DialogTitle>{openVideo.title}</DialogTitle>
              </DialogHeader>
              <VideoEmbed
                provider={openVideo.video_provider}
                videoId={openVideo.video_id}
                title={openVideo.title}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
