import { describe, expect, it } from 'vitest';
import { getYouTubePlaybackError } from '../public/js/privacy/youtubePlaybackErrors.js';

describe('YouTube playback policy messages', () => {
  it('directs Made for Kids and non-embeddable videos to the official source', () => {
    for (const code of ['VIDEO_MADE_FOR_KIDS', 'VIDEO_NOT_EMBEDDABLE']) {
      expect(getYouTubePlaybackError(new Error(code), 'dQw4w9WgXcQ')).toMatchObject({
        retryable: false,
        sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
      });
    }
  });

  it('offers retry only for transient provider failures', () => {
    expect(getYouTubePlaybackError(new Error('VIDEO_NOT_FOUND'))).toMatchObject({ retryable: false });
    expect(getYouTubePlaybackError(new Error('PROVIDER_TIMEOUT'))).toMatchObject({ retryable: true });
  });
});
