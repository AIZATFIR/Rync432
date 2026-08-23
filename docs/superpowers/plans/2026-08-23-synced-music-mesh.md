# Synced Music Mesh (Web-Native Multi-Device Audio Synchronizer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a high-performance, web-native multi-device synchronized audio playback system ("Music Mesh") capable of sub-millisecond audio alignment, real-time per-device latency tuning, dual-tone keep-alive metronome, and local audio streaming across mobile and desktop devices.

**Architecture:** Node.js WebSocket backend providing NTP-style microsecond clock synchronization and binary audio chunk distribution. Client-side Web Audio API engine decoding audio into `AudioBuffer` for hardware-clock scheduled playback (`AudioContext.currentTime`), bypassing HTML5 `<audio>` latency and jitter.

**Tech Stack:** Node.js, `ws` (WebSockets), Web Audio API (`AudioContext`, `AnalyserNode`, `AudioBufferSourceNode`), Canvas API for 60fps visualizer, Vanilla CSS (OLED Dark Glassmorphism), Vitest / Node Native Test for unit verification.

## Global Constraints

- Must work flawlessly on modern mobile browsers (iOS Safari, Android Chrome) and Desktop browsers (Chrome, Firefox, Safari, Edge).
- Audio playback must use `AudioContext` and `AudioBufferSourceNode` (NOT `<audio>` tags) to achieve sample-accurate sub-millisecond sync.
- Network clock synchronization must filter out network jitter using Cristian's NTP round-trip time (RTT) algorithm.
- Keep-alive idle metronome (dual-tone tick-tock) must prevent mobile OS audio DAC hardware from going to sleep.
- UI must follow OLED Dark / Glassmorphism aesthetic with responsive mobile-first controls and $\ge 44\text{px}$ touch targets.

---

## File Structure

```
Rync432/
├── package.json
├── server/
│   ├── server.js               # Express/HTTP + WebSocket server for room & clock sync
│   └── roomManager.js          # Room lifecycle, host/peer state, binary chunk relay
├── public/
│   ├── index.html              # Modern responsive HTML5 UI
│   ├── css/
│   │   └── style.css           # OLED Dark Glassmorphism, animations, responsive layout
│   └── js/
│       ├── audio/
│       │   ├── AudioEngine.js      # Web Audio API core, buffer decoding, hardware clock scheduler
│       │   ├── ClockSync.js        # NTP Cristian's algorithm for server-client offset
│       │   ├── Metronome.js        # 2-tone keep-alive audio warmer & acoustic alignment beat
│       │   └── LatencyTuner.js     # Per-device offset adjuster & Bluetooth delay profiles
│       ├── network/
│       │   └── SocketClient.js     # WebSocket client handling sync packets & binary audio
│       ├── ui/
│       │   ├── Visualizer.js       # 60fps Canvas audio visualizer & pulse meter
│       │   └── UIManager.js        # DOM bindings, room state UI, device mesh list
│       └── app.js              # Application bootstrapper
├── tests/
│   ├── clockSync.test.js       # NTP offset & jitter filtering unit tests
│   ├── latencyTuner.test.js    # Playback timestamp calculation tests
│   └── roomManager.test.js     # Room peer join/leave & broadcast unit tests
```

---

## Tasks

### Task 1: Project Scaffolding & Core Server Architecture

**Files:**
- Create: `package.json`
- Create: `server/roomManager.js`
- Create: `server/server.js`
- Test: `tests/roomManager.test.js`

**Interfaces:**
- Consumes: Node.js standard modules (`http`, `fs`, `path`), `ws`
- Produces: `RoomManager` class with methods `createRoom(hostId)`, `joinRoom(roomId, peerId, isHost)`, `leaveRoom(peerId)`, `broadcast(roomId, data, excludePeerId)`

- [ ] **Step 1: Write the failing unit test for RoomManager**

```javascript
// tests/roomManager.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { RoomManager } from '../server/roomManager.js';

describe('RoomManager', () => {
  let rm;
  beforeEach(() => {
    rm = new RoomManager();
  });

  it('creates a room with a 4-letter code and assigns host', () => {
    const room = rm.createRoom('peer-1');
    expect(room.id).toHaveLength(4);
    expect(room.hostId).toBe('peer-1');
    expect(room.peers.has('peer-1')).toBe(true);
  });

  it('allows peers to join and leave room', () => {
    const room = rm.createRoom('peer-1');
    const joined = rm.joinRoom(room.id, 'peer-2');
    expect(joined).toBe(true);
    expect(room.peers.has('peer-2')).toBe(true);

    rm.leaveRoom('peer-2');
    expect(room.peers.has('peer-2')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/roomManager.test.js`
Expected: FAIL (file or class not found)

- [ ] **Step 3: Implement `package.json`, `server/roomManager.js`, and `server/server.js`**

```javascript
// server/roomManager.js
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
      playbackState: { isPlaying: false, startServerTime: 0, pauseOffset: 0 },
      createdAt: Date.now()
    };
    this.rooms.set(roomId, room);
    this.peerToRoom.set(hostId, roomId);
    return room;
  }

  joinRoom(roomId, peerId, metadata = {}) {
    const room = this.rooms.get(roomId.toUpperCase());
    if (!room) return false;
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
        room.peers.get(room.hostId).isHost = true;
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
```

```javascript
// server/server.js
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
  let filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);
  const extname = path.extname(filePath).toLowerCase();
  
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
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
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
      });
      res.end(content, 'utf-8');
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
      // Binary audio stream forwarding
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
        // Return client origin timestamp + high precision server time
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
        send(ws, 'ROOM_CREATED', { roomId: room.id, peerId, isHost: true });
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
          send(ws, 'ROOM_ERROR', { message: 'Room not found' });
        }
        return;
      }

      // 3. Playback Synchronization Actions
      if (type === 'SCHEDULE_PLAY') {
        const room = roomManager.getRoomByPeer(peerId);
        if (room && room.hostId === peerId) {
          // Schedule playback 500ms in the future on server clock
          const scheduledServerTime = Date.now() + (payload.delayMs || 500);
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
            latencyOffset: payload.offsetMs
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
      broadcastRoom(result.roomId, 'PEER_LEFT', { peerId });
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
```

- [ ] **Step 4: Run unit tests to verify pass**

Run: `npx vitest run tests/roomManager.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json server/roomManager.js server/server.js tests/roomManager.test.js
git commit -m "feat: implement server with room management and websocket sync protocol"
```

---

### Task 2: High-Precision NTP Clock Synchronizer & Tests

**Files:**
- Create: `public/js/audio/ClockSync.js`
- Test: `tests/clockSync.test.js`

**Interfaces:**
- Consumes: WebSocket connection or mock socket, `performance.now()`, `Date.now()`
- Produces: `ClockSync` class with methods `startSync(sampleCount)`, `handlePong(data)`, `getServerTime()`, `toServerTime(clientLocalTime)`

- [ ] **Step 1: Write failing unit test for ClockSync algorithm**

```javascript
// tests/clockSync.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { ClockSync } from '../public/js/audio/ClockSync.js';

describe('ClockSync (NTP Algorithm)', () => {
  let clockSync;
  beforeEach(() => {
    clockSync = new ClockSync();
  });

  it('calculates accurate clock offset and RTT', () => {
    // Scenario: Client sends at T0=1000. Server receives at T1=1020, sends at T2=1022. Client receives at T3=1046.
    // RTT = (T3 - T0) - (T2 - T1) = (1046 - 1000) - (1022 - 1020) = 46 - 2 = 44ms (one-way ~22ms)
    // Offset = ((T1 - T0) + (T2 - T3)) / 2 = ((1020 - 1000) + (1022 - 1046)) / 2 = (20 - 24) / 2 = -2ms
    const sample = clockSync.calculateSample({
      t0: 1000,
      t1: 1020,
      t2: 1022,
      t3: 1046
    });

    expect(sample.rtt).toBe(44);
    expect(sample.offset).toBe(-2);
  });

  it('filters outlier samples and computes median offset', () => {
    clockSync.addSample({ rtt: 10, offset: 50 });
    clockSync.addSample({ rtt: 12, offset: 52 });
    clockSync.addSample({ rtt: 80, offset: 120 }); // Outlier spike
    clockSync.addSample({ rtt: 11, offset: 51 });

    const bestOffset = clockSync.getBestOffset();
    // Best samples with lowest RTT should determine offset (~51)
    expect(Math.round(bestOffset)).toBe(51);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/clockSync.test.js`
Expected: FAIL

- [ ] **Step 3: Implement `public/js/audio/ClockSync.js`**

```javascript
// public/js/audio/ClockSync.js
export class ClockSync {
  constructor(socketSender = null) {
    this.socketSender = socketSender;
    this.samples = [];
    this.maxSamples = 12;
    this.offset = 0;
    this.rtt = 0;
    this.isSynced = false;
    this.syncInterval = null;
  }

  calculateSample({ t0, t1, t2, t3 }) {
    const rtt = (t3 - t0) - (t2 - t1);
    const offset = ((t1 - t0) + (t2 - t3)) / 2;
    return { rtt: Math.max(0, rtt), offset };
  }

  addSample(sample) {
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
    this.updateComputedOffset();
  }

  updateComputedOffset() {
    if (this.samples.length === 0) return;

    // Sort by RTT ascending (lowest jitter is most accurate)
    const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    // Take the best 50% samples
    const bestHalf = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
    
    // Compute average offset of the lowest RTT samples
    const sumOffset = bestHalf.reduce((acc, s) => acc + s.offset, 0);
    this.offset = sumOffset / bestHalf.length;
    this.rtt = bestHalf[0].rtt;
    this.isSynced = this.samples.length >= 3;
  }

  getBestOffset() {
    this.updateComputedOffset();
    return this.offset;
  }

  ping() {
    if (!this.socketSender) return;
    const clientTimestamp = Date.now();
    this.socketSender('SYNC_PING', { clientTimestamp });
  }

  handlePong({ clientTimestamp, serverReceiveTime, serverTransmitTime }) {
    const clientReceiveTime = Date.now();
    const sample = this.calculateSample({
      t0: clientTimestamp,
      t1: serverReceiveTime,
      t2: serverTransmitTime,
      t3: clientReceiveTime
    });
    this.addSample(sample);
  }

  startPeriodicSync(intervalMs = 3000) {
    this.stopPeriodicSync();
    // Burst sync at start: 5 pings every 200ms
    for (let i = 0; i < 5; i++) {
      setTimeout(() => this.ping(), i * 200);
    }
    // Then regular heartbeat ping
    this.syncInterval = setInterval(() => {
      this.ping();
    }, intervalMs);
  }

  stopPeriodicSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  getServerTime() {
    return Date.now() + this.offset;
  }

  toClientLocalTime(serverTime) {
    return serverTime - this.offset;
  }
}
```

- [ ] **Step 4: Run unit tests to verify pass**

Run: `npx vitest run tests/clockSync.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add public/js/audio/ClockSync.js tests/clockSync.test.js
git commit -m "feat: implement NTP clock synchronization engine with jitter rejection"
```

---

### Task 3: Web Audio Engine, Latency Tuner & Keep-Alive Metronome

**Files:**
- Create: `public/js/audio/LatencyTuner.js`
- Create: `public/js/audio/Metronome.js`
- Create: `public/js/audio/AudioEngine.js`
- Test: `tests/latencyTuner.test.js`

**Interfaces:**
- Consumes: Web Audio API (`AudioContext`), `ClockSync`
- Produces:
  - `LatencyTuner`: manages device-specific millisecond offset ($\pm 200\text{ms}$) & device profiles
  - `Metronome`: produces 2-tone synthetic rhythmic keep-alive pulse (880Hz / 440Hz)
  - `AudioEngine`: loads audio files into `AudioBuffer`, schedules sample-accurate playback via `AudioBufferSourceNode.start()`

- [ ] **Step 1: Write failing unit test for LatencyTuner calculations**

```javascript
// tests/latencyTuner.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { LatencyTuner } from '../public/js/audio/LatencyTuner.js';

describe('LatencyTuner', () => {
  let tuner;
  beforeEach(() => {
    tuner = new LatencyTuner();
  });

  it('calculates scheduled local start time with custom offset', () => {
    // If target server time is 5000ms, client time is 4900ms (offset = 100ms server ahead)
    // Custom latency adjustment = +30ms (e.g. bluetooth delay compensation)
    tuner.setManualOffset(30);
    
    // serverTimeToClientTime converts 5000 -> 4900
    // Latency adjustment compensates: 4900 - 30 = 4870ms (fire earlier so sound arrives on time)
    const effectiveTime = tuner.calculateEffectiveStartTime(5000, 100);
    expect(effectiveTime).toBe(4870);
  });

  it('provides standard preset delay offsets', () => {
    tuner.applyPreset('bluetooth');
    expect(tuner.manualOffset).toBe(120);

    tuner.applyPreset('wired');
    expect(tuner.manualOffset).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/latencyTuner.test.js`
Expected: FAIL

- [ ] **Step 3: Implement `public/js/audio/LatencyTuner.js` and `public/js/audio/Metronome.js`**

```javascript
// public/js/audio/LatencyTuner.js
export class LatencyTuner {
  constructor(onOffsetChange = null) {
    this.manualOffset = 0; // in milliseconds (-200 to +300)
    this.onOffsetChange = onOffsetChange;
    this.presets = {
      wired: 0,
      internal: 15,
      bluetooth: 120,
      airplay: 250
    };
  }

  setManualOffset(ms) {
    this.manualOffset = Math.max(-300, Math.min(500, Math.round(ms)));
    if (this.onOffsetChange) {
      this.onOffsetChange(this.manualOffset);
    }
  }

  nudge(deltaMs) {
    this.setManualOffset(this.manualOffset + deltaMs);
  }

  applyPreset(presetName) {
    if (presetName in this.presets) {
      this.setManualOffset(this.presets[presetName]);
    }
  }

  calculateEffectiveStartTime(serverTargetTime, clockOffset) {
    // clientTime = serverTargetTime - clockOffset
    // We subtract manualOffset (if positive/lagging speaker, start earlier)
    const clientLocalTargetTime = serverTargetTime - clockOffset;
    return clientLocalTargetTime - this.manualOffset;
  }
}
```

```javascript
// public/js/audio/Metronome.js
export class Metronome {
  constructor(audioContext) {
    this.ctx = audioContext;
    this.isRunning = false;
    this.timerId = null;
    this.bpm = 120;
    this.beatCount = 0;
    this.gainNode = null;
  }

  init() {
    if (!this.gainNode && this.ctx) {
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = 0.15; // Pleasant subtle volume
      this.gainNode.connect(this.ctx.destination);
    }
  }

  start() {
    if (this.isRunning || !this.ctx) return;
    this.init();
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    this.isRunning = true;
    this.beatCount = 0;
    this.scheduleNextBeat();
  }

  stop() {
    this.isRunning = false;
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  toggle() {
    if (this.isRunning) this.stop();
    else this.start();
    return this.isRunning;
  }

  playTone(freq, time, duration = 0.05) {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, time);

    // Smooth envelope click
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.exponentialRampToValueAtTime(0.3, time + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc.connect(gain);
    gain.connect(this.gainNode);

    osc.start(time);
    osc.stop(time + duration);
  }

  scheduleNextBeat() {
    if (!this.isRunning) return;

    const interval = 60 / this.bpm;
    const now = this.ctx.currentTime;
    const isHigh = this.beatCount % 2 === 0;
    const freq = isHigh ? 880 : 440; // High A5 (880Hz) and Low A4 (440Hz) 2-tone ketukan

    this.playTone(freq, now + 0.05, 0.06);
    this.beatCount++;

    this.timerId = setTimeout(() => {
      this.scheduleNextBeat();
    }, interval * 1000);
  }
}
```

- [ ] **Step 4: Implement `public/js/audio/AudioEngine.js`**

```javascript
// public/js/audio/AudioEngine.js
import { LatencyTuner } from './LatencyTuner.js';
import { Metronome } from './Metronome.js';

export class AudioEngine {
  constructor(clockSync) {
    this.clockSync = clockSync;
    this.ctx = null;
    this.audioBuffer = null;
    this.currentSource = null;
    this.gainNode = null;
    this.analyserNode = null;
    this.isPlaying = false;
    this.currentTrackName = '';
    this.currentTrackDuration = 0;
    this.startAudioContextTime = 0;
    this.startOffsetSec = 0;

    this.latencyTuner = new LatencyTuner((newOffset) => {
      // If playing, we can smoothly nudge or inform user
    });
    this.metronome = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContextClass({ latencyHint: 'interactive' });
      
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = 1.0;

      this.analyserNode = this.ctx.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.8;

      this.gainNode.connect(this.analyserNode);
      this.analyserNode.connect(this.ctx.destination);

      this.metronome = new Metronome(this.ctx);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  async loadAudioFromArrayBuffer(arrayBuffer, trackName = 'Track') {
    this.ensureContext();
    this.audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.currentTrackName = trackName;
    this.currentTrackDuration = this.audioBuffer.duration;
    return this.audioBuffer;
  }

  async loadAudioFromUrl(url, trackName = 'Track') {
    this.ensureContext();
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    return this.loadAudioFromArrayBuffer(arrayBuffer, trackName);
  }

  schedulePlayAtServerTime(serverTargetTime, startOffsetSec = 0) {
    this.ensureContext();
    if (!this.audioBuffer) {
      console.warn('Cannot play: no audioBuffer loaded');
      return;
    }

    this.stopLocalPlayback();

    // 1. Convert server target time to client local time
    const clientEffectiveTimestamp = this.latencyTuner.calculateEffectiveStartTime(
      serverTargetTime,
      this.clockSync.getBestOffset()
    );

    // 2. Convert to AudioContext hardware clock timeline
    const nowLocalMs = Date.now();
    const deltaMs = clientEffectiveTimestamp - nowLocalMs;
    const scheduledContextTime = this.ctx.currentTime + (deltaMs / 1000);

    // Create and configure AudioBufferSourceNode
    this.currentSource = this.ctx.createBufferSource();
    this.currentSource.buffer = this.audioBuffer;
    this.currentSource.connect(this.gainNode);

    if (scheduledContextTime >= this.ctx.currentTime) {
      this.currentSource.start(scheduledContextTime, startOffsetSec);
    } else {
      // If we joined slightly late, start immediately with corrected offset
      const catchupOffset = Math.abs(deltaMs) / 1000 + startOffsetSec;
      if (catchupOffset < this.audioBuffer.duration) {
        this.currentSource.start(0, catchupOffset);
      }
    }

    this.isPlaying = true;
    this.startAudioContextTime = scheduledContextTime;
    this.startOffsetSec = startOffsetSec;

    this.currentSource.onended = () => {
      this.isPlaying = false;
    };
  }

  stopLocalPlayback() {
    if (this.currentSource) {
      try {
        this.currentSource.stop();
        this.currentSource.disconnect();
      } catch (e) {}
      this.currentSource = null;
    }
    this.isPlaying = false;
  }

  getCurrentPlaybackPosition() {
    if (!this.isPlaying || !this.ctx) return 0;
    const elapsed = this.ctx.currentTime - this.startAudioContextTime;
    return Math.min(this.currentTrackDuration, Math.max(0, elapsed + this.startOffsetSec));
  }

  setVolume(vol) {
    if (this.gainNode) {
      this.gainNode.gain.setValueAtTime(Math.max(0, Math.min(1, vol)), this.ctx.currentTime);
    }
  }

  getFrequencyData(array) {
    if (this.analyserNode) {
      this.analyserNode.getByteFrequencyData(array);
    }
  }
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run tests/latencyTuner.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add public/js/audio/LatencyTuner.js public/js/audio/Metronome.js public/js/audio/AudioEngine.js tests/latencyTuner.test.js
git commit -m "feat: implement Web Audio engine with sample-accurate scheduling and idle metronome"
```

---

### Task 4: Client Socket Networking & Audio Distribution

**Files:**
- Create: `public/js/network/SocketClient.js`

**Interfaces:**
- Consumes: WebSocket API, `ClockSync`, `AudioEngine`
- Produces: `SocketClient` class connecting client events to server and orchestrating room state

- [ ] **Step 1: Implement `public/js/network/SocketClient.js`**

```javascript
// public/js/network/SocketClient.js
import { ClockSync } from '../audio/ClockSync.js';

export class SocketClient {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.ws = null;
    this.clockSync = new ClockSync((type, payload) => this.send(type, payload));
    this.roomId = null;
    this.peerId = null;
    this.isHost = false;
  }

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    this.ws = new WebSocket(`${protocol}//${host}`);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.clockSync.startPeriodicSync(2500);
      this.onEvent('CONNECTED', {});
    };

    this.ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.onEvent('BINARY_AUDIO_RECEIVED', event.data);
        return;
      }

      try {
        const { type, payload } = JSON.parse(event.data);
        if (type === 'SYNC_PONG') {
          this.clockSync.handlePong(payload);
          return;
        }

        if (type === 'ROOM_CREATED' || type === 'ROOM_JOINED') {
          this.roomId = payload.roomId;
          this.peerId = payload.peerId;
          this.isHost = payload.isHost;
        }

        this.onEvent(type, payload);
      } catch (e) {
        console.error('WebSocket parse error:', e);
      }
    };

    this.ws.onclose = () => {
      this.clockSync.stopPeriodicSync();
      this.onEvent('DISCONNECTED', {});
      setTimeout(() => this.connect(), 2000);
    };
  }

  send(type, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    }
  }

  sendBinary(arrayBuffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(arrayBuffer);
    }
  }

  createRoom(deviceName = 'Master Speaker') {
    this.send('CREATE_ROOM', { deviceName });
  }

  joinRoom(roomId, deviceName = 'Satellite Speaker') {
    this.send('JOIN_ROOM', { roomId, deviceName });
  }

  schedulePlay(delayMs = 600, startOffsetSec = 0) {
    this.send('SCHEDULE_PLAY', { delayMs, startOffsetSec });
  }

  pausePlayback(currentOffsetSec = 0) {
    this.send('PAUSE_PLAYBACK', { currentOffsetSec });
  }

  sendTrackMetadata(metadata) {
    this.send('TRACK_METADATA', metadata);
  }

  updateLatencyOffset(offsetMs) {
    this.send('UPDATE_LATENCY_OFFSET', { offsetMs });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add public/js/network/SocketClient.js
git commit -m "feat: implement client websocket communication layer"
```

---

### Task 5: Stunning OLED Dark UI & Real-Time Canvas Audio Visualizer

**Files:**
- Create: `public/css/style.css`
- Create: `public/js/ui/Visualizer.js`
- Create: `public/js/ui/UIManager.js`
- Create: `public/index.html`
- Create: `public/js/app.js`

**Interfaces:**
- Consumes: `AudioEngine`, `SocketClient`, `Visualizer`
- Produces: Complete, interactive, responsive web application with Room management, Drag & Drop audio upload, Latency Tuner ($\pm 200\text{ms}$), 2-tone Metronome switch, 60fps Spectrum Visualizer, and Multi-Device Mesh status.

- [ ] **Step 1: Implement `public/css/style.css` with OLED Dark theme, glassmorphism, glowing meters, and responsive grid**
- [ ] **Step 2: Implement `public/js/ui/Visualizer.js` for 60fps canvas wave + harmonic circular pulse**
- [ ] **Step 3: Implement `public/js/ui/UIManager.js` and `public/index.html`**
- [ ] **Step 4: Implement `public/js/app.js` tying AudioEngine, LatencyTuner, Metronome, and SocketClient together**
- [ ] **Step 5: Verify in browser with browser agent / manual preview**
- [ ] **Step 6: Commit UI & Frontend integration**

```bash
git add public/
git commit -m "feat: complete UI with OLED dark glassmorphism, visualizer, and latency tuner"
```

---

## Verification Plan

### Automated Tests
1. Run all unit tests:
   ```bash
   npx vitest run
   ```
2. Verify:
   - Clock sync math & NTP offset accuracy
   - Room manager peer joins/leaves and broadcast logic
   - Latency tuner offset adjustments and preset loading

### Manual Multi-Device Verification
1. Start server locally:
   ```bash
   npm start
   ```
2. Open Host tab in Chrome (`http://localhost:3000`), click "Create Room".
3. Open Client tab in Chrome / Firefox or mobile device via local Wi-Fi IP (`http://<LAN-IP>:3000`), enter 4-letter Room Code.
4. Test Idle Metronome: Enable "2-Tone Metronome Keep-Alive" -> verify both tabs click synchronously in high-low rhythm.
5. Upload an MP3/WAV file on Host -> verify track is pre-buffered on Client.
6. Hit "Play" on Host -> verify simultaneous zero-echo playback on both devices!
7. Adjust Latency Tuner slider on Client ($\pm 50\text{ms}$) -> verify instant fine-tuning response.
