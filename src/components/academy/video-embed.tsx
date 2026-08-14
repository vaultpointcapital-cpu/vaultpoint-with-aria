import { getVideoEmbedUrl } from '@/lib/utils/academy';
import type { VideoProvider } from '@/types/database';

interface VideoEmbedProps {
  provider: VideoProvider;
  videoId: string;
  title: string;
}

/**
 * Videos are embedded via the provider's own player (YouTube/Vimeo), not
 * self-hosted — Supabase Storage isn't built for video streaming (no
 * adaptive bitrate, high bandwidth cost at even modest scale). This is a
 * simple embed, not video infrastructure.
 */
export function VideoEmbed({ provider, videoId, title }: VideoEmbedProps) {
  const src = getVideoEmbedUrl(provider, videoId);

  return (
    <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">
      <iframe
        src={src}
        title={title}
        className="h-full w-full"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
    </div>
  );
}
