const IFRAME_API_URL = 'https://www.youtube.com/iframe_api';
const PLAYER_STARTUP_TIMEOUT_MS = 12_000;
let apiPromise;

function loadIframeApi(deadline = Date.now() + PLAYER_STARTUP_TIMEOUT_MS) {
  if (globalThis.YT?.Player) return Promise.resolve(globalThis.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve, reject) => {
    const previousReady = globalThis.onYouTubeIframeAPIReady;
    const timeout = setTimeout(() => reject(new Error('YOUTUBE_PLAYER_TIMEOUT')), Math.max(0, deadline - Date.now()));
    globalThis.onYouTubeIframeAPIReady = () => {
      clearTimeout(timeout);
      try { previousReady?.(); } catch (error) {}
      if (globalThis.YT?.Player) resolve(globalThis.YT);
      else reject(new Error('YOUTUBE_PLAYER_UNAVAILABLE'));
    };
    let script = document.querySelector(`script[src="${IFRAME_API_URL}"]`);
    if (!script) {
      script = document.createElement('script');
      script.src = IFRAME_API_URL;
      script.async = true;
      script.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('YOUTUBE_PLAYER_UNAVAILABLE'));
      };
      document.head.appendChild(script);
    }
  }).catch(error => {
    apiPromise = null;
    throw error;
  });
  return apiPromise;
}

export class YouTubeEmbedPlayer {
  constructor(elementId, { onStateChange = () => {}, onError = () => {}, onAutoplayBlocked = () => {}, clockSync = null } = {}) {
    this.elementId = elementId;
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.onAutoplayBlocked = onAutoplayBlocked;
    this.clockSync = clockSync;
    this.player = null;
    this.readyPromise = null;
    this.videoId = null;
    this.scheduledPlay = null;
    this.playRequestId = 0;
  }

  cancelScheduledPlay() {
    this.playRequestId += 1;
    clearTimeout(this.scheduledPlay);
    this.scheduledPlay = null;
    return this.playRequestId;
  }

  preload() {
    return loadIframeApi().then(() => true);
  }

  async ensurePlayer(videoId = '') {
    if (!this.readyPromise) {
      const initialVideoId = videoId;
      const startupDeadline = Date.now() + PLAYER_STARTUP_TIMEOUT_MS;
      this.readyPromise = loadIframeApi(startupDeadline).then(YT => new Promise((resolve, reject) => {
        let settled = false;
        const readinessTimeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('YOUTUBE_PLAYER_READY_TIMEOUT'));
        }, Math.max(0, startupDeadline - Date.now()));
        try {
          this.player = new YT.Player(this.elementId, {
            width: '480',
            height: '270',
            videoId: initialVideoId || undefined,
            playerVars: {
              autoplay: 0,
              controls: 1,
              enablejsapi: 1,
              playsinline: 1,
              origin: globalThis.location?.origin || ''
            },
            events: {
              onReady: event => {
                if (settled) return;
                settled = true;
                clearTimeout(readinessTimeout);
                this.videoId = initialVideoId || null;
                resolve(event.target);
              },
              onStateChange: event => {
                this.onStateChange(event.data, event.target);
              },
              onError: event => this.onError(event.data),
              onAutoplayBlocked: () => this.onAutoplayBlocked()
            },
          });
        } catch (error) {
          settled = true;
          clearTimeout(readinessTimeout);
          reject(error);
        }
      })).catch(error => {
        try { this.player?.destroy?.(); } catch (destroyError) {}
        this.player = null;
        this.readyPromise = null;
        throw error;
      });
    }
    const player = await this.readyPromise;
    if (videoId && videoId !== this.videoId) {
      player.cueVideoById({ videoId });
      this.videoId = videoId;
    }
    return player;
  }

  async cueVideo(videoId, startSeconds = 0) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) throw new Error('INVALID_YOUTUBE_VIDEO_ID');
    const requestId = this.cancelScheduledPlay();
    const player = await this.ensurePlayer();
    if (requestId !== this.playRequestId) return;
    player.cueVideoById({ videoId, startSeconds: Math.max(0, Number(startSeconds) || 0) });
    this.videoId = videoId;
  }

  hasVideo(videoId) {
    return this.videoId === videoId;
  }

  async playAt(videoId, targetServerTime, startSeconds = 0) {
    if (videoId && !/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error('INVALID_YOUTUBE_VIDEO_ID');
    const requestId = this.cancelScheduledPlay();
    const player = await this.ensurePlayer();
    if (requestId !== this.playRequestId) return;
    if (videoId && videoId !== this.videoId) {
      player.cueVideoById({ videoId, startSeconds: Math.max(0, Number(startSeconds) || 0) });
      this.videoId = videoId;
    }
    const targetLocalTime = Number.isFinite(targetServerTime)
      ? this.clockSync?.toClientLocalTime?.(targetServerTime) ?? targetServerTime
      : targetServerTime;
    const playAtTarget = () => {
      if (requestId !== this.playRequestId) return;
      const elapsedSeconds = Number.isFinite(targetLocalTime)
        ? Math.max(0, (Date.now() - targetLocalTime) / 1000)
        : 0;
      player.seekTo(Math.max(0, Number(startSeconds) || 0) + elapsedSeconds, true);
      player.playVideo();
    };
    if (Number.isFinite(targetLocalTime) && targetLocalTime > Date.now()) {
      this.scheduledPlay = setTimeout(() => {
        this.scheduledPlay = null;
        playAtTarget();
      }, targetLocalTime - Date.now());
    } else {
      playAtTarget();
    }
  }

  async pause() {
    const requestId = this.cancelScheduledPlay();
    if (this.player && this.readyPromise) {
      const player = await this.readyPromise;
      if (requestId === this.playRequestId) player.pauseVideo();
    }
  }

  playFromUserGesture() {
    if (!this.player || !this.readyPromise) return false;
    this.cancelScheduledPlay();
    this.player.playVideo();
    return true;
  }

  async seekTo(seconds) {
    if (this.player && this.readyPromise) (await this.readyPromise).seekTo(Math.max(0, Number(seconds) || 0), true);
  }

  async setVolume(value) {
    if (this.player && this.readyPromise) {
      (await this.readyPromise).setVolume(Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100));
    }
  }

  getCurrentTime() {
    try { return this.player?.getCurrentTime?.() || 0; } catch (error) { return 0; }
  }

  getDuration() {
    try { return this.player?.getDuration?.() || 0; } catch (error) { return 0; }
  }

  destroy() {
    this.cancelScheduledPlay();
    try { this.player?.destroy?.(); } catch (error) {}
    this.player = null;
    this.readyPromise = null;
    this.videoId = null;
  }
}
