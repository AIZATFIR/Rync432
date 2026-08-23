export class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.peerToRoom = new Map();
  }

  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return this.rooms.has(code) ? this.generateRoomCode() : code;
  }

  createRoom(hostId, hostMetadata = {}) {
    const roomId = this.generateRoomCode();
    const room = {
      id: roomId,
      hostId,
      peers: new Map([
        [hostId, { id: hostId, isHost: true, latencyOffset: 0, ...hostMetadata }]
      ]),
      currentTrack: null,
      playbackState: { isPlaying: false, startServerTime: 0, startOffsetSec: 0, pauseOffset: 0 },
      createdAt: Date.now()
    };
    this.rooms.set(roomId, room);
    this.peerToRoom.set(hostId, roomId);
    return room;
  }

  joinRoom(roomId, peerId, metadata = {}) {
    if (!roomId) return null;
    const room = this.rooms.get(roomId.toUpperCase());
    if (!room) return null;
    room.peers.set(peerId, { id: peerId, isHost: false, latencyOffset: 0, ...metadata });
    this.peerToRoom.set(peerId, room.id);
    return room;
  }

  leaveRoom(peerId) {
    const roomId = this.peerToRoom.get(peerId);
    if (!roomId) return null;
    const room = this.rooms.get(roomId);
    if (!room) return null;

    room.peers.delete(peerId);
    this.peerToRoom.delete(peerId);

    // If host leaves, assign next peer or destroy room
    if (room.hostId === peerId) {
      const remainingPeers = Array.from(room.peers.keys());
      if (remainingPeers.length > 0) {
        room.hostId = remainingPeers[0];
        const newHost = room.peers.get(room.hostId);
        if (newHost) newHost.isHost = true;
      } else {
        this.rooms.delete(roomId);
      }
    }
    return { roomId, remainingPeersCount: room.peers.size };
  }

  getRoom(roomId) {
    return this.rooms.get(roomId?.toUpperCase()) || null;
  }

  getRoomByPeer(peerId) {
    const roomId = this.peerToRoom.get(peerId);
    return roomId ? this.rooms.get(roomId) : null;
  }
}
