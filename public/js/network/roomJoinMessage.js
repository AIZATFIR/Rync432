export function roomJoinMessage(code) {
  if (code === 'ROOM_FULL') return 'Room sudah penuh (maksimal 5 perangkat). Minta host kosongkan satu slot, lalu coba lagi.';
  if (code === 'ROOM_NOT_FOUND') return 'Room tidak ditemukan atau sudah kedaluwarsa. Periksa link/kode dari host.';
  if (code === 'PEER_ID_IN_USE') return 'Perangkat ini masih tercatat di room. Muat ulang halaman lalu coba lagi.';
  return 'Room tidak bisa dimasuki. Periksa kode atau koneksi.';
}
