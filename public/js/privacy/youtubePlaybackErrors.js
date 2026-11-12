export function getYouTubePlaybackError(error, videoId = '') {
  if (error?.message === 'VIDEO_MADE_FOR_KIDS') {
    return {
      message: 'Video ini ditandai Made for Kids dan hanya bisa dibuka langsung di YouTube.',
      retryable: false,
      sourceUrl: `https://www.youtube.com/watch?v=${videoId}`
    };
  }
  if (error?.message === 'VIDEO_NOT_EMBEDDABLE') {
    return {
      message: 'Video ini tidak mengizinkan pemutaran di Rync.',
      retryable: false,
      sourceUrl: `https://www.youtube.com/watch?v=${videoId}`
    };
  }
  if (error?.message === 'VIDEO_NOT_FOUND') {
    return { message: 'Video YouTube ini sudah tidak tersedia. Pilih video lain.', retryable: false };
  }
  return { message: 'Player YouTube tidak bisa dimuat. Periksa koneksi lalu coba lagi.', retryable: true };
}
