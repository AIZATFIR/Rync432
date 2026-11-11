import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const ROOM_TTL_MS = 3 * 60 * 60 * 1000;

export function createRoomPersistence(filePath, { now = Date.now } = {}) {
  let lastSerialized = null;

  const serializeRooms = rooms => JSON.stringify({
    version: 1,
    rooms: Array.from(rooms.values(), room => {
      const { peers, signals, kickedPeers, ...persistentRoom } = room;
      return persistentRoom;
    }).filter(room => now() - (room.updatedAt || 0) <= ROOM_TTL_MS)
  });

  return {
    load() {
      if (!existsSync(filePath)) return new Map();
      const stored = JSON.parse(readFileSync(filePath, 'utf8'));
      if (stored?.version !== 1 || !Array.isArray(stored.rooms)) {
        throw new Error('Room store format is invalid');
      }

      const rooms = new Map();
      for (const room of stored.rooms) {
        if (!room || !/^[A-Z0-9]{4}$/.test(room.roomId || '') || !room.updatedAt) continue;
        if (now() - room.updatedAt > ROOM_TTL_MS) continue;
        rooms.set(room.roomId, { ...room, peers: {}, signals: [] });
      }
      lastSerialized = serializeRooms(rooms);
      return rooms;
    },

    save(rooms) {
      const serialized = serializeRooms(rooms);
      if (serialized === lastSerialized) return false;

      const directory = path.dirname(filePath);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporaryPath = `${filePath}.${process.pid}.${now()}.tmp`;
      writeFileSync(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, filePath);
      lastSerialized = serialized;
      return true;
    }
  };
}
