import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { RoomManager } from './roomManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

const roomManager = new RoomManager();
const peerSockets = new Map();

const server = http.createServer((req, res) => {
  let reqUrl = req.url.split('?')[0];
  let filePath = path.join(PUBLIC_DIR, reqUrl === '/' ? 'index.html' : reqUrl);
  const extname = path.extname(filePath).toLowerCase();
  
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg'
  };

  const contentType = mimeTypes[extname] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(content);
    }
  });
});

const wss = new WebSocketServer({ server });

function send(ws, type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function broadcastRoom(roomId, type, payload, excludePeerId = null) {
  const room = roomManager.getRoom(roomId);
  if (!room) return;
  for (const [peerId] of room.peers) {
    if (peerId !== excludePeerId) {
      const ws = peerSockets.get(peerId);
      send(ws, type, payload);
    }
  }
}

wss.on('connection', (ws) => {
  const peerId = 'peer_' + Math.random().toString(36).substring(2, 9);
  peerSockets.set(peerId, ws);

  ws.on('message', (message, isBinary) => {
    if (isBinary) {
      // Binary audio stream forwarding to peers in room
      const room = roomManager.getRoomByPeer(peerId);
      if (room) {
        for (const [pId] of room.peers) {
          if (pId !== peerId) {
            const clientWs = peerSockets.get(pId);
            if (clientWs && clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(message, { binary: true });
            }
          }
        }
      }
      return;
    }

    try {
      const { type, payload } = JSON.parse(message.toString());

      // 1. High-precision Time Sync Ping (NTP Algorithm)
      if (type === 'SYNC_PING') {
        const serverReceiveTime = Date.now();
        send(ws, 'SYNC_PONG', {
          clientTimestamp: payload.clientTimestamp,
          serverReceiveTime,
          serverTransmitTime: Date.now()
        });
        return;
      }

      // 2. Room Management
      if (type === 'CREATE_ROOM') {
        const room = roomManager.createRoom(peerId, payload);
        send(ws, 'ROOM_CREATED', {
          roomId: room.id,
          peerId,
          isHost: true,
          peers: Array.from(room.peers.values())
        });
        return;
      }

      if (type === 'JOIN_ROOM') {
        const room = roomManager.joinRoom(payload.roomId, peerId, payload);
        if (room) {
          send(ws, 'ROOM_JOINED', {
            roomId: room.id,
            peerId,
            isHost: room.hostId === peerId,
            peers: Array.from(room.peers.values()),
            currentTrack: room.currentTrack,
            playbackState: room.playbackState
          });
          broadcastRoom(room.id, 'PEER_JOINED', {
            peer: room.peers.get(peerId),
            peers: Array.from(room.peers.values())
          }, peerId);
        } else {
          send(ws, 'ROOM_ERROR', { message: 'Room not found. Please check room code.' });
        }
        return;
      }

      // 3. Playback Synchronization Actions
      if (type === 'SCHEDULE_PLAY') {
        const room = roomManager.getRoomByPeer(peerId);
        if (room && room.hostId === peerId) {
          // Schedule playback 500ms in the future on server clock
          const delay = payload.delayMs || 500;
          const scheduledServerTime = Date.now() + delay;
          room.playbackState = {
            isPlaying: true,
            startServerTime: scheduledServerTime,
            startOffsetSec: payload.startOffsetSec || 0
          };
          broadcastRoom(room.id, 'PLAYBACK_SCHEDULED', {
            scheduledServerTime,
            startOffsetSec: payload.startOffsetSec || 0
          });
        }
        return;
      }

      if (type === 'PAUSE_PLAYBACK') {
        const room = roomManager.getRoomByPeer(peerId);
        if (room && room.hostId === peerId) {
          room.playbackState = {
            isPlaying: false,
            startServerTime: 0,
            startOffsetSec: 0,
            pauseOffset: payload.currentOffsetSec || 0
          };
          broadcastRoom(room.id, 'PLAYBACK_PAUSED', {
            currentOffsetSec: payload.currentOffsetSec || 0
          });
        }
        return;
      }

      if (type === 'TRACK_METADATA') {
        const room = roomManager.getRoomByPeer(peerId);
        if (room && room.hostId === peerId) {
          room.currentTrack = payload;
          broadcastRoom(room.id, 'TRACK_LOADED', payload, peerId);
        }
        return;
      }

      if (type === 'UPDATE_LATENCY_OFFSET') {
        const room = roomManager.getRoomByPeer(peerId);
        if (room) {
          const peer = room.peers.get(peerId);
          if (peer) peer.latencyOffset = payload.offsetMs;
          broadcastRoom(room.id, 'PEER_UPDATED', {
            peerId,
            latencyOffset: payload.offsetMs,
            peers: Array.from(room.peers.values())
          });
        }
        return;
      }

      if (type === 'PING_STATUS') {
        const room = roomManager.getRoomByPeer(peerId);
        if (room) {
          const peer = room.peers.get(peerId);
          if (peer) {
            peer.rtt = payload.rtt;
            peer.clockOffset = payload.offset;
          }
          broadcastRoom(room.id, 'PEER_STATUS_SYNC', {
            peers: Array.from(room.peers.values())
          });
        }
        return;
      }

    } catch (e) {
      console.error('Socket message parse error:', e);
    }
  });

  ws.on('close', () => {
    const result = roomManager.leaveRoom(peerId);
    if (result) {
      const room = roomManager.getRoom(result.roomId);
      broadcastRoom(result.roomId, 'PEER_LEFT', {
        peerId,
        newHostId: room ? room.hostId : null,
        peers: room ? Array.from(room.peers.values()) : []
      });
    }
    peerSockets.delete(peerId);
  });
});

export { server, roomManager };

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.log(`Synced Music Mesh Server running on http://localhost:${PORT}`);
  });
}
