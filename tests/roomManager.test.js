import { describe, it, expect, beforeEach } from 'vitest';
import { RoomManager } from '../server/roomManager.js';

describe('RoomManager', () => {
  let rm;
  beforeEach(() => {
    rm = new RoomManager();
  });

  it('creates a room with a 4-character code and assigns host', () => {
    const room = rm.createRoom('peer-1', { deviceName: 'Phone Host' });
    expect(room.id).toHaveLength(4);
    expect(room.hostId).toBe('peer-1');
    expect(room.peers.has('peer-1')).toBe(true);
    expect(room.peers.get('peer-1').deviceName).toBe('Phone Host');
  });

  it('allows peers to join and leave room', () => {
    const room = rm.createRoom('peer-1');
    const joinedRoom = rm.joinRoom(room.id, 'peer-2', { deviceName: 'Speaker 2' });
    expect(joinedRoom).toBeTruthy();
    expect(room.peers.has('peer-2')).toBe(true);
    expect(room.peers.get('peer-2').deviceName).toBe('Speaker 2');

    const leaveResult = rm.leaveRoom('peer-2');
    expect(leaveResult.roomId).toBe(room.id);
    expect(room.peers.has('peer-2')).toBe(false);
  });

  it('transfers host role when host leaves and other peers remain', () => {
    const room = rm.createRoom('peer-1');
    rm.joinRoom(room.id, 'peer-2');
    
    rm.leaveRoom('peer-1');
    expect(room.hostId).toBe('peer-2');
    expect(room.peers.get('peer-2').isHost).toBe(true);
  });

  it('cleans up room when all peers leave', () => {
    const room = rm.createRoom('peer-1');
    const roomId = room.id;
    rm.leaveRoom('peer-1');
    expect(rm.getRoom(roomId)).toBeNull();
  });
});
