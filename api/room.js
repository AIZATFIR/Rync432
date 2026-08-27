// Serverless In-Memory & Edge Room Mesh Relay for Rync432
// Supports Multi-Device Sync, Binary Audio Relay, Democratic Queue, and WebRTC

const rooms = globalThis.__rync_rooms || new Map();
const audioStore = globalThis.__rync_audio_store || new Map();
globalThis.__rync_rooms = rooms;
globalThis.__rync_audio_store = audioStore;

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '30mb'
    }
  }
};

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

  // Cleanup old inactive rooms & audio (> 3 hours)
  for (const [id, room] of rooms.entries()) {
    if (now - (room.updatedAt || 0) > 3 * 3600 * 1000) {
      rooms.delete(id);
      audioStore.delete(id);
    }
  }

  // 1. Binary Audio Relay for Uploaded Files (MP3 / WAV / FLAC)
  if (action === 'upload_audio') {
    const audioBase64 = body.audioBase64;
    const trackName = body.trackName || 'Uploaded Track';
    const duration = body.duration || 0;
    const targetQueueId = body.id || body.queueId;

    if (audioBase64 && roomId) {
      const audioId = 'aud_' + Math.random().toString(36).substring(2, 9);
      const audioEntry = {
        audioId,
        base64: audioBase64,
        contentType: body.contentType || 'audio/mpeg',
        trackName,
        duration,
        uploadedAt: now
      };

      audioStore.set(audioId, audioEntry);
      audioStore.set(roomId, audioEntry); // fallback for room

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

      const audioUrl = `/api/room?action=get_audio&audioId=${audioId}&roomId=${encodeURIComponent(roomId)}&v=${now}`;
      
      if (!room.queue) room.queue = [];
      let item = targetQueueId ? room.queue.find(q => q.id === targetQueueId) : null;
      if (item) {
        item.audioId = audioId;
        item.audioUrl = audioUrl;
      } else {
        item = {
          id: targetQueueId || ('q_' + Math.random().toString(36).substring(2, 9)),
          audioId,
          name: trackName,
          artist: 'File Audio',
          duration,
          audioUrl,
          addedBy: deviceName
        };
        const exists = room.queue.some(q => q.id === item.id || (q.name === item.name && Math.abs((q.duration || 0) - (item.duration || 0)) < 1));
        if (!exists) {
          room.queue.push(item);
        }
      }

      if (!room.track) {
        room.track = item;
        room.state = 'PAUSED';
        room.startOffsetSec = 0;
      } else if (room.track.id === item.id) {
        room.track.audioId = audioId;
        room.track.audioUrl = audioUrl;
      }
      room.updatedAt = now;

      return res.status(200).json({ success: true, audioUrl, track: room.track, queue: room.queue, item });
    }
    return res.status(400).json({ error: 'Missing audioBase64 or roomId' });
  }

  if (action === 'get_audio') {
    const audioId = query.audioId || body.audioId;
    const audioData = (audioId && audioStore.get(audioId)) || audioStore.get(roomId);
    if (audioData && audioData.base64) {
      const buffer = Buffer.from(audioData.base64, 'base64');
      res.setHeader('Content-Type', audioData.contentType || 'audio/mpeg');
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(audioData.trackName || 'track')}.mp3"`);
      res.setHeader('X-Track-Title', encodeURIComponent(audioData.trackName));
      return res.status(200).send(buffer);
    }
    return res.status(404).json({ error: 'Audio not found in room' });
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
    let room = rooms.get(roomId);
    const isThisHost = body.isHost === true || query.isHost === 'true';

    if (!room) {
      room = {
        roomId,
        hostId: isThisHost ? peerId : (body.hostId || null),
        state: body.state || 'IDLE',
        track: body.track || null,
        targetServerTime: body.targetServerTime || 0,
        startOffsetSec: body.startOffsetSec || 0,
        updatedAt: now,
        queue: Array.isArray(body.queue) ? body.queue : [],
        peers: {},
        signals: []
      };
      rooms.set(roomId, room);
    }

    if (isThisHost) {
      room.hostId = peerId;
      if (body.track) room.track = body.track;
      if (body.state) room.state = body.state;
      if (body.targetServerTime) room.targetServerTime = body.targetServerTime;
    }

    // Merge incoming queue from client with server queue to avoid serverless fragmentation
    if (Array.isArray(body.queue) && body.queue.length > 0) {
      const map = new Map();
      (room.queue || []).forEach(item => { if (item && item.id) map.set(item.id, item); });
      body.queue.forEach(item => { if (item && item.id) map.set(item.id, item); });
      room.queue = Array.from(map.values());
    }

    if (Array.isArray(body.deletedQueueIds) && body.deletedQueueIds.length > 0) {
      const delSet = new Set(body.deletedQueueIds);
      room.queue = (room.queue || []).filter(item => !delSet.has(item.id));
    }

    const isHostAssigned = isThisHost || (room.hostId === peerId);

    // Prune stale / disconnected peers (> 10s without poll)
    for (const [pId, p] of Object.entries(room.peers || {})) {
      if (pId !== room.hostId && (now - (p.lastSeen || 0) > 10000)) {
        delete room.peers[pId];
      }
    }

    // Check if this peer was removed / kicked by host
    if (room.kickedPeers && room.kickedPeers.includes(peerId)) {
      return res.status(200).json({
        exists: true,
        kicked: true,
        peers: Object.values(room.peers || {}),
        serverTime: now
      });
    }

    if (peerId && room.peers[peerId]) {
      room.peers[peerId].lastSeen = now;
      room.peers[peerId].isHost = isHostAssigned;
      if (deviceName && deviceName !== 'Speaker') {
        room.peers[peerId].deviceName = deviceName;
      }
    } else if (peerId) {
      room.peers[peerId] = {
        id: peerId,
        deviceName,
        isHost: isHostAssigned,
        role: 'stereo',
        volume: 1.0,
        latencyOffset: 0,
        lastSeen: now
      };
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
    let room = rooms.get(roomId);
    if (!room) {
      room = {
        roomId,
        hostId: peerId,
        state: body.state || 'IDLE',
        track: body.track || null,
        targetServerTime: body.targetServerTime || 0,
        startOffsetSec: body.startOffsetSec || 0,
        updatedAt: now,
        queue: Array.isArray(body.queue) ? body.queue : [],
        peers: {},
        signals: []
      };
      rooms.set(roomId, room);
    }
    if (body.state) room.state = body.state;
    if (body.targetServerTime !== undefined) room.targetServerTime = body.targetServerTime;
    if (body.startOffsetSec !== undefined) room.startOffsetSec = body.startOffsetSec;
    if (body.track) room.track = body.track;
    if (Array.isArray(body.queue)) room.queue = body.queue;
    room.updatedAt = now;
    return res.status(200).json({ success: true, track: room.track, queue: room.queue });
  }

  if (action === 'add_queue') {
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

    if (!room.queue) room.queue = [];

    if (Array.isArray(body.items)) {
      body.items.forEach(it => {
        if (it && it.id && !room.queue.some(q => q.id === it.id)) {
          room.queue.push(it);
        }
      });
    } else {
      const item = {
        id: body.id || ('q_' + Math.random().toString(36).substring(2, 9)),
        name: body.name || 'Untitled',
        artist: body.artist || 'Artist',
        duration: body.duration || 0,
        thumbnail: body.thumbnail || '',
        audioUrl: body.audioUrl || '',
        isSynthetic: !!body.isSynthetic,
        addedBy: deviceName
      };

      const exists = room.queue.some(q => q.id === item.id);
      if (!exists) {
        room.queue.push(item);
      }
    }

    if (!room.track && room.queue.length > 0) {
      room.track = room.queue[0];
      room.state = 'PAUSED';
      room.targetServerTime = 0;
      room.startOffsetSec = 0;
    }

    room.updatedAt = now;
    return res.status(200).json({
      success: true,
      track: room.track,
      queue: room.queue,
      state: room.state,
      targetServerTime: room.targetServerTime
    });
  }

  if (action === 'reorder_queue') {
    const room = rooms.get(roomId);
    if (room && Array.isArray(body.queue)) {
      room.queue = body.queue;
      room.updatedAt = now;
      return res.status(200).json({ success: true, queue: room.queue });
    }
    return res.status(200).json({ success: false });
  }

  if (action === 'play_next') {
    const room = rooms.get(roomId);
    if (room && room.queue) {
      const qId = body.queueId;
      const targetIdx = room.queue.findIndex(q => q.id === qId);
      if (targetIdx !== -1) {
        const [item] = room.queue.splice(targetIdx, 1);
        const currentIdx = room.track ? room.queue.findIndex(q => q.id === room.track.id) : -1;
        const insertIdx = currentIdx >= 0 ? currentIdx + 1 : 0;
        room.queue.splice(insertIdx, 0, item);
        room.updatedAt = now;
        return res.status(200).json({ success: true, queue: room.queue });
      }
    }
    return res.status(404).json({ error: 'Track not found' });
  }

  if (action === 'play_queue_item') {
    const room = rooms.get(roomId);
    if (room && room.queue) {
      const qId = body.queueId;
      const target = room.queue.find(q => q.id === qId);
      if (target) {
        room.track = target;
        room.state = 'PAUSED';
        room.targetServerTime = null;
        room.startOffsetSec = 0;
        room.updatedAt = now;
        return res.status(200).json({
          success: true,
          track: room.track,
          queue: room.queue,
          state: room.state,
          targetServerTime: null,
          startOffsetSec: 0
        });
      }
    }
    return res.status(404).json({ error: 'Track not found' });
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
        const currentIndex = room.track ? room.queue.findIndex(q => q.id === room.track.id) : -1;
        const nextIndex = currentIndex >= 0 && currentIndex + 1 < room.queue.length ? currentIndex + 1 : 0;
        
        room.track = room.queue[nextIndex] || room.queue[0];
        room.state = 'PLAYING';
        room.targetServerTime = now + 800;
        room.startOffsetSec = 0;
      } else {
        room.state = 'PAUSED';
        room.startOffsetSec = 0;
      }
      room.updatedAt = now;
      return res.status(200).json({
        success: true,
        track: room.track,
        queue: room.queue,
        state: room.state,
        targetServerTime: room.targetServerTime,
        startOffsetSec: room.startOffsetSec
      });
    }
    return res.status(404).json({ error: 'Room not found' });
  }

  if (action === 'prev_track') {
    const room = rooms.get(roomId);
    if (room) {
      if (room.queue && room.queue.length > 0) {
        const currentIndex = room.track ? room.queue.findIndex(q => q.id === room.track.id) : 0;
        const prevIndex = (currentIndex > 0) ? currentIndex - 1 : room.queue.length - 1;
        
        room.track = room.queue[prevIndex] || room.queue[0];
        room.state = 'PLAYING';
        room.targetServerTime = now + 800;
        room.startOffsetSec = 0;
      } else {
        room.state = 'PAUSED';
        room.startOffsetSec = 0;
      }
      room.updatedAt = now;
      return res.status(200).json({
        success: true,
        track: room.track,
        queue: room.queue,
        state: room.state,
        targetServerTime: room.targetServerTime,
        startOffsetSec: room.startOffsetSec
      });
    }
    return res.status(404).json({ error: 'Room not found' });
  }

  if (action === 'leave_room') {
    const room = rooms.get(roomId);
    if (room && room.peers[peerId]) {
      delete room.peers[peerId];
      room.updatedAt = now;
      return res.status(200).json({ success: true });
    }
    return res.status(200).json({ success: true });
  }

  if (action === 'remove_peer') {
    const room = rooms.get(roomId);
    const targetPeerId = body.targetPeerId || query.targetPeerId;
    if (room && targetPeerId) {
      if (!room.kickedPeers) room.kickedPeers = [];
      if (!room.kickedPeers.includes(targetPeerId)) {
        room.kickedPeers.push(targetPeerId);
      }
      if (room.peers && room.peers[targetPeerId]) {
        delete room.peers[targetPeerId];
      }
      room.updatedAt = now;
      return res.status(200).json({ success: true, peers: Object.values(room.peers || {}) });
    }
    return res.status(200).json({ success: true });
  }

  if (action === 'update_peer') {
    const room = rooms.get(roomId);
    const targetPeerId = body.targetPeerId || peerId;
    if (room && room.peers[targetPeerId]) {
      if (body.role) room.peers[targetPeerId].role = body.role;
      if (body.volume !== undefined) room.peers[targetPeerId].volume = body.volume;
      if (body.isAudioLoading !== undefined) room.peers[targetPeerId].isAudioLoading = body.isAudioLoading;
      if (body.loadingStatus !== undefined) room.peers[targetPeerId].loadingStatus = body.loadingStatus;
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
