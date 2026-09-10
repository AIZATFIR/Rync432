import { MusicSourceType } from '../types.js';

export class PublicAudioSource {
  constructor() {
    this.type = MusicSourceType.PUBLIC_AUDIO;
    this.presets = [
      {
        id: 'public_acoustic_wav',
        title: 'Acoustic Master WAV',
        artist: 'Studio Session',
        duration: 3.0,
        playableUrl: '/sample.wav',
        mimeType: 'audio/wav',
        thumbnailUrl: ''
      },
      {
        id: 'public_synthwave',
        title: 'Neon Cyber Synth',
        artist: 'Rync Synth Lab',
        duration: 8.0,
        isSynthetic: true,
        mimeType: 'audio/wav',
        thumbnailUrl: ''
      }
    ];
  }

  canHandle(input) {
    if (typeof input !== 'string') return false;
    return input.startsWith('public_') || input === '/sample.wav';
  }

  async resolve(idOrUrl) {
    const preset = this.presets.find(p => p.id === idOrUrl || p.playableUrl === idOrUrl);
    if (!preset) {
      return {
        trackId: 'public_sample',
        title: 'Public Audio Track',
        artist: 'Demo',
        duration: 0,
        sourceType: this.type,
        playableUrl: idOrUrl,
        streamUrl: idOrUrl,
        mimeType: 'audio/wav'
      };
    }

    return {
      trackId: preset.id,
      title: preset.title,
      artist: preset.artist,
      duration: preset.duration,
      sourceType: this.type,
      playableUrl: preset.playableUrl || '',
      streamUrl: preset.playableUrl || '',
      isSynthetic: preset.isSynthetic || false,
      mimeType: preset.mimeType
    };
  }
}
