// Serverless In-Memory & Edge Room Mesh Relay for Rync432
// Supports Multi-Device Sync, Democratic Queue/Playlist, and WebRTC Signaling

const rooms = globalThis.__rync_rooms || new Map();
globalThis.__rync_rooms = rooms;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const query = req.query || {};
  let body = {};
  if (req.method === 'POST') {
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    } catch (e) {
      body = req.body || {};
    }
  }

  const action = query.action || body.action || '';
  const roomId = (query.roomId || body.roomId || '').toUpperCase();
  const peerId = query.peerId || body.peerId || '';
  const deviceName = query.deviceName || body.deviceName || 'Speaker';

  const now = Date.now();

  // Cleanup old inactive rooms (> 4 hours)
  for (const [id, room] of rooms.entries()) {
    if (now - (room.updatedAt || 0) > 4 * 3600 * 1000) {
      rooms.delete(id);
    }
  }

  if (action === 'create') {
    const newRoom = {
      roomId,
      hostId: peerId,
      state: 'IDLE',
      track: null,
      targetServerTime: 0,
      startOffsetSec: 0,
      updatedAt: now,
      queue: [],
      peers: {
        [peerId]: {
          id: peerId,
          deviceName,
          isHost: true,
          role: 'stereo',
          volume: 1.0,
          latencyOffset: 0,
          lastSeen: now
        }
      },
      signals: []
    };
    rooms.set(roomId, newRoom);
    return res.status(200).json({ success: true, room: newRoom });
  }

  if (action === 'join') {
    let room = rooms.get(roomId);
    if (!room) {
      room = {
        roomId,
        hostId: peerId,
        state: 'IDLE',
        track: null,
        targetServerTime: 0,
        startOffsetSec: 0,
        updatedAt: now,
        queue: [],
        peers: {},
        signals: []
      };
      rooms.set(roomId, room);
    }

    room.peers[peerId] = {
      id: peerId,
      deviceName,
      isHost: room.hostId === peerId || Object.keys(room.peers).length === 0,
      role: 'stereo',
      volume: 1.0,
      latencyOffset: 0,
      lastSeen: now
    };
    room.updatedAt = now;

    return res.status(200).json({
      success: true,
      room: {
        roomId,
        state: room.state,
        track: room.track,
        queue: room.queue || [],
        peers: Object.values(room.peers)
      }
    });
  }

  if (action === 'poll') {
    const room = rooms.get(roomId);
    if (!room) {
      return res.status(200).json({
        exists: false,
        peers: [{ id: peerId, deviceName, isHost: true, role: 'stereo', volume: 1.0 }],
        state: 'IDLE',
        track: null,
        queue: []
      });
    }

    // Update peer heartbeat
    if (peerId && room.peers[peerId]) {
      room.peers[peerId].lastSeen = now;
      if (deviceName && deviceName !== 'Speaker') {
        room.peers[peerId].deviceName = deviceName;
      }
    } else if (peerId) {
      room.peers[peerId] = {
        id: peerId,
        deviceName,
        isHost: room.hostId === peerId,
        role: 'stereo',
        volume: 1.0,
        latencyOffset: 0,
        lastSeen: now
      };
    }

    // Prune dead peers (> 25s inactive)
    for (const [pId, peer] of Object.entries(room.peers)) {
      if (pId !== peerId && now - (peer.lastSeen || 0) > 25000) {
        delete room.peers[pId];
      }
    }

    const incomingSignals = (room.signals || []).filter(s => s.to === peerId);
    room.signals = (room.signals || []).filter(s => s.to !== peerId);

    return res.status(200).json({
      exists: true,
      state: room.state,
      track: room.track,
      queue: room.queue || [],
      targetServerTime: room.targetServerTime,
      startOffsetSec: room.startOffsetSec,
      peers: Object.values(room.peers),
      signals: incomingSignals,
      serverTime: now
    });
  }

  if (action === 'update_playback') {
    const room = rooms.get(roomId);
    if (room) {
      if (body.state) room.state = body.state;
      if (body.targetServerTime !== undefined) room.targetServerTime = body.targetServerTime;
      if (body.startOffsetSec !== undefined) room.startOffsetSec = body.startOffsetSec;
      if (body.track) room.track = body.track;
      if (body.queue) room.queue = body.queue;
      room.updatedAt = now;
      return res.status(200).json({ success: true });
    }
    return res.status(404).json({ error: 'Room not found' });
  }

  // Queue actions: Add, Remove, Next
  if (action === 'add_queue') {
    const room = rooms.get(roomId);
    if (room) {
      if (!room.queue) room.queue = [];
      const item = {
        id: 'q_' + Math.random().toString(36).substring(2, 9),
        name: body.name || 'Untitled',
        artist: body.artist || 'Artist',
        duration: body.duration || 0,
        thumbnail: body.thumbnail || '',
        audioUrl: body.audioUrl || '',
        isSynthetic: !!body.isSynthetic,
        addedBy: deviceName
      };

      // If nothing is playing, play immediately
      if (!room.track) {
        room.track = item;
        room.state = 'PLAYING';
        room.targetServerTime = now + 400;
        room.startOffsetSec = 0;
      } else {
        room.queue.push(item);
      }

      room.updatedAt = now;
      return res.status(200).json({ success: true, track: room.track, queue: room.queue });
    }
    return res.status(404).json({ error: 'Room not found' });
  }

  if (action === 'remove_queue') {
    const room = rooms.get(roomId);
    if (room && room.queue) {
      const qId = body.queueId;
      room.queue = room.queue.filter(q => q.id !== qId);
      room.updatedAt = now;
      return res.status(200).json({ success: true, queue: room.queue });
    }
    return res.status(200).json({ success: false });
  }

  if (action === 'next_track') {
    const room = rooms.get(roomId);
    if (room) {
      if (room.queue && room.queue.length > 0) {
        const next = room.queue.shift();
        room.track = next;
        room.state = 'PLAYING';
        room.targetServerTime = now + 400;
        room.startOffsetSec = 0;
      } else {
        room.state = 'PAUSED';
        room.startOffsetSec = 0;
      }
      room.updatedAt = now;
      return res.status(200).json({ success: true, track: room.track, queue: room.queue });
    }
    return res.status(404).json({ error: 'Room not found' });
  }

  if (action === 'update_peer') {
    const room = rooms.get(roomId);
    const targetPeerId = body.targetPeerId;
    if (room && room.peers[targetPeerId]) {
      if (body.role) room.peers[targetPeerId].role = body.role;
      if (body.volume !== undefined) room.peers[targetPeerId].volume = body.volume;
      room.updatedAt = now;
      return res.status(200).json({ success: true });
    }
    return res.status(200).json({ success: false });
  }

  if (action === 'signal') {
    const room = rooms.get(roomId);
    if (room) {
      if (!room.signals) room.signals = [];
      room.signals.push({
        from: peerId,
        to: body.to,
        data: body.data,
        timestamp: now
      });
      return res.status(200).json({ success: true });
    }
    return res.status(404).json({ error: 'Room not found' });
  }

  return res.status(400).json({ error: 'Invalid action' });
}
