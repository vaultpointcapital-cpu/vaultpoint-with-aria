import type { VideoProvider } from '@/types/database';

/**
 * Maps a video provider + id to its embeddable iframe src. Split out from
 * the VideoEmbed component so it's unit-testable without rendering.
 */
export function getVideoEmbedUrl(provider: VideoProvider, videoId: string): string {
  switch (provider) {
    case 'youtube':
      return `https://www.youtube.com/embed/${videoId}`;
    case 'vimeo':
      return `https://player.vimeo.com/video/${videoId}`;
  }
}
