// Serverless In-Memory & Edge Room Mesh Relay for Rync432
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { createRoomPersistence, ROOM_TTL_MS } from './roomPersistence.js';
// Supports Multi-Device Sync, Binary Audio Relay, Democratic Queue, and WebRTC

const roomStorePath = !process.env.VERCEL && process.env.NODE_ENV !== 'test'
  ? (process.env.RYNC_ROOM_STORE_PATH || path.join(process.cwd(), 'data', 'rooms.json'))
  : null;
const roomPersistence = roomStorePath ? createRoomPersistence(roomStorePath) : null;
const rooms = globalThis.__rync_rooms || roomPersistence?.load() || new Map();
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
  const sendJson = typeof res.json === 'function' ? res.json.bind(res) : null;
  if (roomPersistence && sendJson) {
    res.json = payload => {
      try {
        roomPersistence.save(rooms);
      } catch (error) {
        console.error('Room state could not be saved to disk');
        res.status(507);
        return sendJson({ success: false, error: 'ROOM_STORAGE_UNAVAILABLE' });
      }
      return sendJson(payload);
    };
  }

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
  if (['create', 'join'].includes(action) && (!/^[A-Z0-9]{4}$/.test(roomId) || !peerId || peerId.length > 96)) {
    return res.status(400).json({ success: false, error: 'INVALID_ROOM_REQUEST' });
  }

  const now = Date.now();
  const hostTokenMatches = (room, token) => {
    if (typeof token !== 'string' || !room?.hostTokenHash) return false;
    const candidateHash = createHash('sha256').update(token).digest();
    const expectedHash = Buffer.from(room.hostTokenHash, 'hex');
    return expectedHash.length === candidateHash.length && timingSafeEqual(expectedHash, candidateHash);
  };
  const requireHost = (room, token = body.hostToken) => {
    if (room && peerId && room.hostId === peerId && hostTokenMatches(room, token)) return true;
    res.status(403).json({ success: false, error: 'HOST_ONLY' });
    return false;
  };

  // Cleanup old inactive rooms & audio after the documented room TTL.
  for (const [id, room] of rooms.entries()) {
    if (now - (room.updatedAt || 0) > ROOM_TTL_MS) {
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
      const room = rooms.get(roomId);
      if (!requireHost(room, body.hostToken)) return;
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
    if (rooms.has(roomId)) return res.status(409).json({ success: false, error: 'ROOM_EXISTS' });
    const hostToken = randomBytes(32).toString('base64url');
    const newRoom = {
      roomId,
      hostId: peerId,
      hostTokenHash: createHash('sha256').update(hostToken).digest('hex'),
      state: 'IDLE',
      track: null,
      targetServerTime: 0,
      startOffsetSec: 0,
      repeatMode: 'off',
      shuffle: false,
      shufflePlayedIds: [],
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
    const { hostTokenHash, ...publicRoom } = newRoom;
    return res.status(200).json({ success: true, room: publicRoom, hostToken });
  }

  if (action === 'join') {
    const room = rooms.get(roomId);
    if (!room) return res.status(404).json({ success: false, error: 'ROOM_NOT_FOUND' });

    const isReturningHost = hostTokenMatches(room, body.hostToken);
    if (isReturningHost) {
      room.hostId = peerId;
      Object.values(room.peers).forEach(peer => { peer.isHost = false; });
    } else if (room.peers[peerId]) {
      return res.status(409).json({ success: false, error: 'PEER_ID_IN_USE' });
    }
    room.peers[peerId] = {
      id: peerId,
      deviceName,
      isHost: isReturningHost,
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
        isHost: isReturningHost,
        state: room.state,
        track: room.track,
        queue: room.queue || [],
        targetServerTime: room.targetServerTime,
        startOffsetSec: room.startOffsetSec,
        repeatMode: room.repeatMode || 'off',
        shuffle: room.shuffle === true,
        peers: Object.values(room.peers),
        serverTime: now
      }
    });
  }

  if (action === 'poll') {
    const room = rooms.get(roomId);
    if (!room) return res.status(404).json({ exists: false, error: 'ROOM_NOT_FOUND' });
    if (now - (room.updatedAt || 0) > 5 * 60 * 1000) room.updatedAt = now;
    const claimsHost = hostTokenMatches(room, body.hostToken);
    const isThisHost = !!peerId && claimsHost;
    if (!isThisHost && room.peers?.[peerId]?.isHost) {
      return res.status(409).json({ exists: true, error: 'HOST_AUTH_REQUIRED' });
    }
    if (isThisHost) {
      room.hostId = peerId;
      Object.entries(room.peers || {}).forEach(([id, peer]) => { peer.isHost = id === peerId; });
    }

    if (isThisHost) {
      if (body.track) {
        room.track = body.track;
        if (room.shuffle) room.shufflePlayedIds = [body.track.id];
      }
      if (body.state) room.state = body.state;
      if (body.targetServerTime) room.targetServerTime = body.targetServerTime;
      if (['off', 'all', 'one'].includes(body.repeatMode)) room.repeatMode = body.repeatMode;
      if (typeof body.shuffle === 'boolean' && body.shuffle !== room.shuffle) {
        room.shuffle = body.shuffle;
        room.shufflePlayedIds = body.shuffle && room.track?.id ? [room.track.id] : [];
      }
    }

    // Keep host order, while retaining items added by peers since its last snapshot.
    if (isThisHost && Array.isArray(body.queue) && body.queue.length > 0) {
      const deletedIds = new Set(Array.isArray(body.deletedQueueIds) ? body.deletedQueueIds : []);
      const orderedQueue = body.queue.filter(item => item && item.id && !deletedIds.has(item.id));
      const knownIds = new Set(orderedQueue.map(item => item.id));
      (room.queue || []).forEach(item => {
        if (item && item.id && !knownIds.has(item.id) && !deletedIds.has(item.id)) {
          orderedQueue.push(item);
          knownIds.add(item.id);
        }
      });
      room.queue = orderedQueue;
    }

    if (isThisHost && Array.isArray(body.deletedQueueIds) && body.deletedQueueIds.length > 0) {
      const delSet = new Set(body.deletedQueueIds);
      room.queue = (room.queue || []).filter(item => !delSet.has(item.id));
    }

    const isHostAssigned = isThisHost;

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
      repeatMode: room.repeatMode || 'off',
      shuffle: room.shuffle === true,
      peers: Object.values(room.peers),
      signals: incomingSignals,
      serverTime: now
    });
  }

  if (action === 'update_playback') {
    let room = rooms.get(roomId);
    if (!requireHost(room, body.hostToken)) return;
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

  if (action === 'play') {
    const room = rooms.get(roomId);
    if (!requireHost(room, body.hostToken)) return;
    room.state = 'PLAYING';
    room.targetServerTime = body.targetServerTime || now + 800;
    room.startOffsetSec = body.startOffsetSec || 0;
    if (body.track) room.track = body.track;
    room.updatedAt = now;
    return res.status(200).json({ success: true, track: room.track, state: room.state });
  }

  if (action === 'pause') {
    const room = rooms.get(roomId);
    if (!requireHost(room, body.hostToken)) return;
    room.state = 'PAUSED';
    room.targetServerTime = null;
    room.startOffsetSec = body.currentOffsetSec || 0;
    room.updatedAt = now;
    return res.status(200).json({ success: true, track: room.track, state: room.state });
  }

  if (action === 'track') {
    const room = rooms.get(roomId);
    if (!requireHost(room, body.hostToken)) return;
    if (body.track) {
      room.track = body.track;
      if (room.shuffle) room.shufflePlayedIds = [body.track.id];
    }
    room.updatedAt = now;
    return res.status(200).json({ success: true, track: room.track });
  }

  if (action === 'playback_options') {
    const room = rooms.get(roomId);
    if (!requireHost(room, body.hostToken)) return;
    if ((body.repeatMode !== undefined && !['off', 'all', 'one'].includes(body.repeatMode))
      || (body.shuffle !== undefined && typeof body.shuffle !== 'boolean')
      || (body.repeatMode === undefined && body.shuffle === undefined)) {
      return res.status(400).json({ success: false, error: 'INVALID_PLAYBACK_OPTIONS' });
    }
    if (body.repeatMode !== undefined) room.repeatMode = body.repeatMode;
    if (body.shuffle !== undefined && body.shuffle !== room.shuffle) {
      room.shuffle = body.shuffle;
      room.shufflePlayedIds = body.shuffle && room.track?.id ? [room.track.id] : [];
    }
    room.updatedAt = now;
    return res.status(200).json({ success: true, repeatMode: room.repeatMode, shuffle: room.shuffle });
  }

  if (action === 'add_queue') {
    const room = rooms.get(roomId);
    if (!room) return res.status(404).json({ success: false, error: 'ROOM_NOT_FOUND' });
    if (!peerId || !room.peers?.[peerId]) return res.status(403).json({ success: false, error: 'ROOM_MEMBER_REQUIRED' });
    if (!room.queue) room.queue = [];

    if (Array.isArray(body.items)) {
      body.items.forEach(it => {
        if (it && it.id && !room.queue.some(q => q.id === it.id)) {
          room.queue.push(it);
          room.shufflePlayedIds = (room.shufflePlayedIds || []).filter(id => id !== it.id);
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
        room.shufflePlayedIds = (room.shufflePlayedIds || []).filter(id => id !== item.id);
      }
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
    if (!requireHost(room, body.hostToken)) return;
    if (room && Array.isArray(body.queue)) {
      const currentQueue = room.queue || [];
      const currentById = new Map(currentQueue.filter(item => item?.id).map(item => [item.id, item]));
      const reorderedQueue = [];
      const includedIds = new Set();
      body.queue.forEach(item => {
        if (!item?.id || includedIds.has(item.id) || !currentById.has(item.id)) return;
        reorderedQueue.push(currentById.get(item.id));
        includedIds.add(item.id);
      });
      currentQueue.forEach(item => {
        if (item?.id && !includedIds.has(item.id)) {
          reorderedQueue.push(item);
          includedIds.add(item.id);
        }
      });
      room.queue = reorderedQueue;
      room.updatedAt = now;
      return res.status(200).json({ success: true, queue: room.queue });
    }
    return res.status(200).json({ success: false });
  }

  if (action === 'play_next') {
    const room = rooms.get(roomId);
    if (!requireHost(room, body.hostToken)) return;
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
    if (!requireHost(room, body.hostToken)) return;
    if (room && room.queue) {
      const qId = body.queueId;
      const target = room.queue.find(q => q.id === qId);
      if (target) {
        room.track = target;
        if (room.shuffle) room.shufflePlayedIds = [target.id];
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
    if (!requireHost(room, body.hostToken)) return;
    if (room && room.queue) {
      const qId = body.queueId;
      room.queue = room.queue.filter(q => q.id !== qId);
      room.updatedAt = now;
      return res.status(200).json({ success: true, queue: room.queue });
    }
    return res.status(200).json({ success: false });
  }

  if (action === 'clear_queue') {
    const room = rooms.get(roomId);
    if (!requireHost(room, body.hostToken)) return;
    if (!Array.isArray(body.queueIds) || body.queueIds.length > 200
      || body.queueIds.some(id => typeof id !== 'string' || id.length > 160)) {
      return res.status(400).json({ success: false, error: 'INVALID_QUEUE_IDS' });
    }
    const ids = new Set(body.queueIds);
    const currentTrackId = room.track?.id;
    const removed = [];
    room.queue = (room.queue || []).filter((item, index) => {
      if (ids.has(item.id) && item.id !== currentTrackId) {
        removed.push({ item, index });
        return false;
      }
      return true;
    });
    room.updatedAt = now;
    return res.status(200).json({ success: true, queue: room.queue, removed });
  }

  if (action === 'restore_queue') {
    const room = rooms.get(roomId);
    if (!requireHost(room, body.hostToken)) return;
    if (!Array.isArray(body.removed) || body.removed.length > 200
      || body.removed.some(entry => !entry?.item?.id || !Number.isInteger(entry.index) || entry.index < 0)) {
      return res.status(400).json({ success: false, error: 'INVALID_QUEUE_RESTORE' });
    }
    const queue = [...(room.queue || [])];
    const existingIds = new Set(queue.map(item => item.id));
    for (const entry of [...body.removed].sort((a, b) => a.index - b.index)) {
      if (existingIds.has(entry.item.id)) continue;
      queue.splice(Math.min(entry.index, queue.length), 0, entry.item);
      existingIds.add(entry.item.id);
    }
    room.queue = queue;
    room.updatedAt = now;
    return res.status(200).json({ success: true, queue: room.queue });
  }

  if (action === 'next_track') {
    const room = rooms.get(roomId);
    if (!requireHost(room, body.hostToken)) return;
    if (room) {
      const queue = room.queue || [];
      let nextTrack = null;
      if (body.automatic === true && room.repeatMode === 'one' && room.track) {
        nextTrack = room.track;
      } else if (queue.length > 0) {
        const currentIndex = room.track ? queue.findIndex(q => q.id === room.track.id) : -1;
        if (room.shuffle) {
          const playedIds = new Set(room.shufflePlayedIds || (room.track?.id ? [room.track.id] : []));
          if (room.track?.id) playedIds.add(room.track.id);
          let candidates = queue.filter(item => !playedIds.has(item.id));
          if (candidates.length === 0 && room.repeatMode === 'all') {
            if (queue.length === 1) nextTrack = queue[0];
            else {
              playedIds.clear();
              if (room.track?.id) playedIds.add(room.track.id);
              candidates = queue.filter(item => !playedIds.has(item.id));
            }
          }
          if (candidates.length > 0) {
            nextTrack = candidates[Math.floor(Math.random() * candidates.length)];
            playedIds.add(nextTrack.id);
          }
          room.shufflePlayedIds = [...playedIds];
        } else if (currentIndex < 0) {
          nextTrack = queue[0];
        } else if (currentIndex + 1 < queue.length) {
          nextTrack = queue[currentIndex + 1];
        } else if (room.repeatMode === 'all') {
          nextTrack = queue[0];
        }
      }

      if (nextTrack) {
        room.track = nextTrack;
        room.state = 'PLAYING';
        room.targetServerTime = now + 800;
        room.startOffsetSec = 0;
      } else {
        room.state = 'PAUSED';
        room.targetServerTime = null;
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
    if (!requireHost(room, body.hostToken)) return;
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
    if (!requireHost(room, body.hostToken)) return;
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
    if (!room || !room.peers?.[peerId]) {
      return res.status(403).json({ success: false, error: 'ROOM_MEMBER_REQUIRED' });
    }
    if (targetPeerId !== peerId && !requireHost(room, body.hostToken)) return;
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
