import { describe, it, expect } from 'vitest';
import { getVideoEmbedUrl } from '@/lib/utils/academy';

describe('getVideoEmbedUrl', () => {
  it('builds a YouTube embed URL', () => {
    expect(getVideoEmbedUrl('youtube', 'dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ'
    );
  });

  it('builds a Vimeo embed URL', () => {
    expect(getVideoEmbedUrl('vimeo', '76979871')).toBe('https://player.vimeo.com/video/76979871');
  });
});
