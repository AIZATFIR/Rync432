#!/usr/bin/env bash
set -euo pipefail

if [[ ! -t 0 ]]; then
  printf 'Jalankan script ini langsung di terminal agar key tidak terlihat saat diketik.\n' >&2
  exit 1
fi

if ! IFS= read -r -s -p 'API key YouTube (input tersembunyi): ' youtube_key; then
  printf '\nGagal membaca API key.\n' >&2
  exit 1
fi
printf '\n'

if [[ ! "$youtube_key" =~ ^[A-Za-z0-9_-]{20,}$ ]]; then
  unset youtube_key
  printf 'Format key tidak valid. Periksa key YouTube Data API v3 lalu coba lagi.\n' >&2
  exit 1
fi

config_dir="$HOME/.config/rync432"
dropin_dir="$HOME/.config/systemd/user/rync432.service.d"
env_file="$config_dir/youtube.env"
dropin_file="$dropin_dir/25-youtube-api-key.conf"
env_tmp=''
dropin_tmp=''
cleanup() {
  [[ -z "$env_tmp" ]] || rm -f -- "$env_tmp"
  [[ -z "$dropin_tmp" ]] || rm -f -- "$dropin_tmp"
  unset youtube_key
}
trap cleanup EXIT

umask 077
mkdir -p -- "$config_dir" "$dropin_dir"
chmod 700 "$config_dir"

if [[ -e "$dropin_file" ]] && ! grep -Fqx 'EnvironmentFile=%h/.config/rync432/youtube.env' "$dropin_file"; then
  printf 'Drop-in %s sudah ada dengan konfigurasi berbeda; tidak ditimpa.\n' "$dropin_file" >&2
  exit 1
fi

env_tmp="$(mktemp "$config_dir/.youtube.env.XXXXXX")"
printf 'YOUTUBE_DATA_API_KEY=%s\n' "$youtube_key" > "$env_tmp"
chmod 600 "$env_tmp"
mv -f -- "$env_tmp" "$env_file"
env_tmp=''
unset youtube_key

if [[ ! -e "$dropin_file" ]]; then
  dropin_tmp="$(mktemp "$dropin_dir/.25-youtube-api-key.XXXXXX")"
  printf '[Service]\nEnvironmentFile=%%h/.config/rync432/youtube.env\n' > "$dropin_tmp"
  chmod 600 "$dropin_tmp"
  mv -f -- "$dropin_tmp" "$dropin_file"
  dropin_tmp=''
fi

systemctl --user daemon-reload
systemctl --user restart rync432.service

for attempt in {1..10}; do
  if ! systemctl --user is-active --quiet rync432.service; then
    sleep 2
    continue
  fi
  health="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:4320/api/health 2>/dev/null || true)"
  if [[ "$health" == *'"youtubeSearch":true'* ]]; then
    printf 'Key sudah dimuat oleh Rync. Coba pencarian musik di Home.\n'
    exit 0
  fi
  sleep 2
done

printf 'Service sudah direstart, tetapi health check belum menunjukkan key aktif. Periksa status service tanpa menampilkan isi file key.\n' >&2
exit 1
