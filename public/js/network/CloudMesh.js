// CloudMesh: High-Precision WebRTC Local Mesh + Serverless Edge Relay
// Connects Laptop & Mobile Phones with Sub-Millisecond Clock Alignment

export class CloudMesh {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.roomId = null;
    this.peerId = null;
    this.deviceName = 'Speaker';
    this.isHost = false;
    this.pollInterval = null;
    this.broadcastChannel = null;
    this.localPeersMap = new Map();
    this.lastKnownState = null;
    this.lastKnownTrack = null;
    this.lastKnownQueue = null;
    this.isPaused = false;
    this.lastPauseTime = 0;

    // Real-Time Pub/Sub Cloud Bus (EMQX / MQTT over WebSockets)
    this.mqttClient = null;
    this.isMqttConnected = false;
    this.roomTopic = null;
    this.peerTopic = null;
  }

  async createRoom(roomId, peerId, deviceName) {
    this.roomId = roomId;
    this.peerId = peerId;
    this.deviceName = deviceName;
    this.isHost = true;

    this.initBroadcastChannel(roomId, deviceName);
    this.initMqttBus(roomId, deviceName);

    try {
      fetch('/api/room?action=create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, peerId, deviceName })
      }).catch(() => {});
    } catch (e) {}

    this.startPolling();
  }

  async joinRoom(roomId, peerId, deviceName) {
    this.roomId = roomId;
    this.peerId = peerId;
    this.deviceName = deviceName;
    this.isHost = false;

    this.initBroadcastChannel(roomId, deviceName);
    this.initMqttBus(roomId, deviceName);

    try {
      fetch('/api/room?action=join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, peerId, deviceName })
      }).catch(() => {});
    } catch (e) {}

    this.startPolling();
  }

  initMqttBus(roomId, deviceName) {
    if (typeof mqtt === 'undefined') {
      console.warn('MQTT client script not loaded, running HTTP fallback mesh');
      return;
    }

    try {
      if (this.mqttClient) {
        try { this.mqttClient.end(true); } catch (e) {}
      }

      this.roomTopic = `rync432/v1/room/${roomId}`;
      this.peerTopic = `rync432/v1/peer/${this.peerId}`;

      const brokerUrl = 'wss://broker.emqx.io:8084/mqtt';
      this.mqttClient = mqtt.connect(brokerUrl, {
        clientId: 'rync_' + this.peerId + '_' + Math.random().toString(36).substring(2, 6),
        clean: true,
        connectTimeout: 4000,
        reconnectPeriod: 2000
      });

      this.mqttClient.on('connect', () => {
        this.isMqttConnected = true;

        this.mqttClient.subscribe([this.roomTopic, this.peerTopic], (err) => {
          if (!err) {
            this.publishMqtt(this.roomTopic, {
              type: 'ANNOUNCE_PEER',
              peer: {
                id: this.peerId,
                deviceName: this.deviceName,
                isHost: this.isHost,
                role: 'stereo',
                volume: 1.0,
                latencyOffset: 0,
                isAudioLoading: false,
                lastSeen: Date.now()
              }
            });
          }
        });
      });

      this.mqttClient.on('message', (topic, message) => {
        try {
          const msg = JSON.parse(message.toString());
          if (!msg || !msg.type) return;
          if (msg.fromPeerId === this.peerId) return; // Skip self

          switch (msg.type) {
            case 'ANNOUNCE_PEER':
              if (msg.peer && msg.peer.id !== this.peerId) {
                this.localPeersMap.set(msg.peer.id, msg.peer);
                this.dispatchLocalPeers();

                if (this.isHost) {
                  this.publishMqtt(`rync432/v1/peer/${msg.peer.id}`, {
                    type: 'ROOM_SNAPSHOT',
                    hostId: this.peerId,
                    track: this.lastKnownTrack,
                    queue: this.lastKnownQueue || [],
                    state: this.isPaused ? 'PAUSED' : 'PLAYING',
                    targetServerTime: this.lastKnownState,
                    peers: Array.from(this.localPeersMap.values())
                  });

                  const pc = this.peerConnections.get(msg.peer.id);
                  if (!pc || pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
                    this.initiateWebRTCOffer(msg.peer.id);
                  }
                }
              }
              break;

            case 'ROOM_SNAPSHOT':
              if (!this.isHost) {
                if (Array.isArray(msg.peers)) {
                  msg.peers.forEach(p => {
                    if (p.id !== this.peerId) this.localPeersMap.set(p.id, p);
                  });
                  this.dispatchLocalPeers();
                }
                if (Array.isArray(msg.queue)) {
                  this.lastKnownQueue = msg.queue;
                  this.lastKnownQueueStr = JSON.stringify(msg.queue);
                  this.onEvent('QUEUE_UPDATED', { queue: msg.queue });
                }
                if (msg.track) {
                  this.lastKnownTrack = msg.track;
                  this.onEvent('TRACK_METADATA', msg.track);
                  this.loadTrackBuffer(msg.track);
                }
                if (msg.state === 'PLAYING' && msg.targetServerTime) {
                  this.isPaused = false;
                  this.lastKnownState = msg.targetServerTime;
                  this.onEvent('SCHEDULED_PLAY', {
                    targetServerTime: msg.targetServerTime,
                    startOffsetSec: 0,
                    track: msg.track || this.lastKnownTrack
                  });
                }
              }
              break;

            case 'SCHEDULED_PLAY':
              this.isPaused = false;
              this.lastKnownState = msg.payload?.targetServerTime || msg.targetServerTime;
              if (msg.payload?.track || msg.track) {
                this.lastKnownTrack = msg.payload?.track || msg.track;
              }
              this.onEvent('SCHEDULED_PLAY', msg.payload || msg);
              break;

            case 'PAUSED':
              this.isPaused = true;
              this.lastPauseTime = Date.now();
              this.lastKnownState = 'PAUSED';
              this.onEvent('PAUSED', msg.payload || msg);
              break;

            case 'TRACK_METADATA':
              this.lastKnownTrack = msg.payload || msg.metadata;
              this.onEvent('TRACK_METADATA', this.lastKnownTrack);
              this.loadTrackBuffer(this.lastKnownTrack);
              break;

            case 'QUEUE_UPDATED':
              if (Array.isArray(msg.queue || msg.payload?.queue)) {
                const q = msg.queue || msg.payload?.queue;
                this.lastKnownQueue = q;
                this.lastKnownQueueStr = JSON.stringify(q);
                this.onEvent('QUEUE_UPDATED', { queue: q });
              }
              break;

            case 'SIGNAL':
              if (msg.from && msg.data) {
                this.handleIncomingSignal(msg.from, msg.data);
              }
              break;

            case 'REMOTE_DEVICE_UPDATED':
              if (msg.targetPeerId === this.peerId) {
                this.onEvent('REMOTE_DEVICE_UPDATED', msg.payload);
              }
              break;

            case 'PEER_LEFT':
              if (msg.peerId) {
                this.localPeersMap.delete(msg.peerId);
                this.dispatchLocalPeers();
              }
              break;
          }
        } catch (e) {}
      });

      this.mqttClient.on('error', (err) => {
        console.warn('MQTT bus notice, fallback active:', err.message);
        if (!this.isMqttConnected) this.startPolling();
      });

      this.mqttClient.on('close', () => {
        this.isMqttConnected = false;
        this.startPolling();
      });
    } catch (err) {
      console.warn('MQTT bus initialization notice:', err.message);
      this.startPolling();
    }
  }

  publishMqtt(topic, payload) {
    if (this.mqttClient && this.isMqttConnected) {
      try {
        const fullPayload = { ...payload, fromPeerId: this.peerId };
        this.mqttClient.publish(topic, JSON.stringify(fullPayload));
      } catch (e) {}
    }
  }

  initBroadcastChannel(roomId, deviceName) {
    if (typeof BroadcastChannel === 'undefined') return;
    if (this.broadcastChannel) {
      try { this.broadcastChannel.close(); } catch (e) { }
    }
    this.broadcastChannel = new BroadcastChannel('rync432_' + roomId);
    this.localPeersMap.clear();
    this.localPeersMap.set(this.peerId, {
      id: this.peerId,
      deviceName,
      isHost: this.isHost,
      role: 'stereo',
      volume: 1.0,
      latencyOffset: 0,
      isAudioLoading: false,
      lastSeen: Date.now()
    });

    this.broadcastChannel.onmessage = (event) => {
      const msg = event.data;
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case 'ANNOUNCE_PEER':
          this.localPeersMap.set(msg.peer.id, msg.peer);
          this.dispatchLocalPeers();
          if (this.broadcastChannel) {
            this.broadcastChannel.postMessage({
              type: 'PEER_PONG',
              peer: this.localPeersMap.get(this.peerId)
            });
          }
          break;

        case 'PEER_PONG':
          this.localPeersMap.set(msg.peer.id, msg.peer);
          this.dispatchLocalPeers();
          break;

        case 'PEER_LEFT':
          this.localPeersMap.delete(msg.peerId);
          this.dispatchLocalPeers();
          break;

        case 'SCHEDULED_PLAY':
          this.isPaused = false;
          this.onEvent('SCHEDULED_PLAY', msg.payload);
          break;

        case 'PAUSED':
          this.isPaused = true;
          this.lastPauseTime = Date.now();
          this.onEvent('PAUSED', msg.payload);
          break;

        case 'TRACK_METADATA':
          this.onEvent('TRACK_METADATA', msg.payload);
          break;

        case 'QUEUE_UPDATED':
          this.onEvent('QUEUE_UPDATED', msg.payload);
          break;

        case 'REMOTE_DEVICE_UPDATED':
          if (msg.targetPeerId === this.peerId) {
            this.onEvent('REMOTE_DEVICE_UPDATED', msg.payload);
          }
          break;
      }
    };

    this.broadcastChannel.postMessage({
      type: 'ANNOUNCE_PEER',
      peer: this.localPeersMap.get(this.peerId)
    });
    this.dispatchLocalPeers();
  }

  dispatchLocalPeers() {
    const peers = Array.from(this.localPeersMap.values());
    this.onEvent('PEER_JOINED', { peers, peerCount: peers.length });
  }

  startPolling() {
    this.stopPolling();
    this.isPollingActive = true;
    this.scheduleNextPoll(100);
  }

  stopPolling() {
    this.isPollingActive = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
  }

  getOptimalPollInterval() {
    // 1. If tab is in background / minimized, throttle aggressively to save Vercel quota
    if (typeof document !== 'undefined' && document.hidden) {
      return 6000;
    }

    // 2. If WebRTC mesh is established with peers, communication is 100% P2P (0 server cost)
    const hasOpenDataChannels = Array.from(this.dataChannels.values()).some(ch => ch && ch.readyState === 'open');
    if (hasOpenDataChannels) {
      return 5000;
    }

    // 3. During initial peer discovery / signaling phase
    return 1500;
  }

  broadcastDataChannelMessage(msg) {
    const payload = typeof msg === 'string' ? msg : JSON.stringify(msg);
    this.dataChannels.forEach(channel => {
      if (channel.readyState === 'open') {
        try {
          channel.send(payload);
        } catch (e) {}
      }
    });
  }

  scheduleNextPoll(delayMs) {
    if (!this.isPollingActive) return;
    if (this.pollTimeout) clearTimeout(this.pollTimeout);
    this.pollTimeout = setTimeout(async () => {
      if (!this.isPollingActive) return;
      await this.pollLoop();
      const nextDelay = this.getOptimalPollInterval();
      this.scheduleNextPoll(nextDelay);
    }, delayMs !== undefined ? delayMs : this.getOptimalPollInterval());
  }

  async pollLoop() {
    if (!this.roomId || !this.peerId) return;

    try {
      const res = await fetch('/api/room?action=poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          peerId: this.peerId,
          deviceName: this.deviceName,
          isHost: this.isHost,
          hostId: this.isHost ? this.peerId : undefined,
          queue: this.lastKnownQueue || [],
          deletedQueueIds: Array.from(this.deletedQueueIds),
          track: this.isHost ? this.lastKnownTrack : undefined,
          state: this.isPaused ? 'PAUSED' : 'PLAYING'
        })
      });
      if (!res.ok) return;

      const data = await res.json();

      if (data.kicked && !this.isHost) {
        this.unsubscribe();
        this.onEvent('ROOM_LEFT');
        alert('Device Anda telah dikeluarkan dari room oleh Host.');
        window.location.href = '/';
        return;
      }

      // 1. Peer list & WebRTC Mesh Auto-Connect with strict duplicate pruning
      if (Array.isArray(data.peers)) {
        let peersChanged = false;
        const incomingIds = new Set(data.peers.map(p => p.id));

        data.peers.forEach(p => {
          const existing = this.localPeersMap.get(p.id);
          if (p.id === this.peerId) {
            p.isHost = this.isHost;
            if (existing) {
              p.isAudioLoading = existing.isAudioLoading;
              p.loadingStatus = existing.loadingStatus;
            }
          }
          if (!existing || existing.role !== p.role || existing.isAudioLoading !== p.isAudioLoading || existing.volume !== p.volume || existing.isHost !== p.isHost || existing.deviceName !== p.deviceName) {
            peersChanged = true;
          }
          this.localPeersMap.set(p.id, p);

          if (this.isHost && p.id !== this.peerId) {
            const pc = this.peerConnections.get(p.id);
            if (!pc || pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
              this.initiateWebRTCOffer(p.id);
            }
          }
        });

        // Strictly prune removed or disconnected peers immediately
        for (const pId of Array.from(this.localPeersMap.keys())) {
          if (!incomingIds.has(pId) && pId !== this.peerId) {
            this.localPeersMap.delete(pId);
            const pc = this.peerConnections.get(pId);
            if (pc) {
              try { pc.close(); } catch (e) { }
              this.peerConnections.delete(pId);
            }
            this.dataChannels.delete(pId);
            peersChanged = true;
          }
        }

        if (peersChanged || this.lastDispatchedPeersCount !== this.localPeersMap.size) {
          this.lastDispatchedPeersCount = this.localPeersMap.size;
          this.dispatchLocalPeers();
        }
      }

      // 2. Queue list with resilient merge - never lose songs across serverless lambdas
      if (Array.isArray(data.queue) && (Date.now() - (this.lastQueueReorderTime || 0) > 2000)) {
        const mergedMap = new Map();
        (this.lastKnownQueue || []).forEach(item => {
          if (item && item.id && !this.deletedQueueIds.has(item.id)) mergedMap.set(item.id, item);
        });
        data.queue.forEach(item => {
          if (item && item.id && !this.deletedQueueIds.has(item.id)) mergedMap.set(item.id, item);
        });
        const mergedQueue = Array.from(mergedMap.values());
        const queueStr = JSON.stringify(mergedQueue);
        if (queueStr !== this.lastKnownQueueStr) {
          this.lastKnownQueueStr = queueStr;
          this.lastKnownQueue = mergedQueue;
          this.onEvent('QUEUE_UPDATED', { queue: mergedQueue });
        }
      }

      // 3. Track update & Auto-fetch with buffer synchronization
      let trackChanged = false;
      if (data.track) {
        const isDifferent = !this.lastKnownTrack 
          || (data.track.id && this.lastKnownTrack.id && data.track.id !== this.lastKnownTrack.id)
          || (data.track.name !== this.lastKnownTrack.name);
        
        if (isDifferent) {
          trackChanged = true;
          this.lastKnownTrack = data.track;
          this.onEvent('TRACK_METADATA', data.track);
          this.loadTrackBuffer(data.track);
        }
      }

      // 4. Playback state with clean Pause protection and exact track synchronization
      if (data.state === 'PLAYING') {
        const isFreshPlay = !this.lastPauseTime || (data.targetServerTime && (data.targetServerTime > (this.lastPauseTime + 300)));
        const shouldPlay = isFreshPlay && (
          (data.targetServerTime && data.targetServerTime !== this.lastKnownState) 
          || (this.isPaused && Date.now() - (this.lastPauseTime || 0) > 2000) 
          || trackChanged
        );

        if (shouldPlay) {
          this.isPaused = false;
          if (data.targetServerTime) this.lastKnownState = data.targetServerTime;
          this.onEvent('SCHEDULED_PLAY', {
            targetServerTime: data.targetServerTime || (Date.now() + 600),
            startOffsetSec: data.startOffsetSec || 0,
            track: data.track || this.lastKnownTrack
          });
        }
      } else if (data.state === 'PAUSED') {
        if (this.lastKnownState !== 'PAUSED' || !this.isPaused) {
          this.isPaused = true;
          this.lastKnownState = 'PAUSED';
          this.lastPauseTime = Date.now();
          this.onEvent('PAUSED', {
            currentOffsetSec: data.startOffsetSec || 0
          });
        }
      }

      // 5. WebRTC Signals
      if (Array.isArray(data.signals) && data.signals.length > 0) {
        for (const sig of data.signals) {
          await this.handleIncomingSignal(sig.from, sig.data);
        }
      }
    } catch (err) { }
  }

  async loadTrackBuffer(track) {
    if (!track) return;
    if (track.isSynthetic || track.name === 'Neon Groove Synthwave' || (track.name && track.name.toLowerCase().includes('synth'))) {
      this.currentFetchingTrackKey = null;
      this.updateLoadingState(false, 'Siap');
      this.onEvent('SYNTHETIC_TRACK_REQUESTED', track);
      return;
    }

    const trackKey = track.id || track.audioId || track.name;
    const cached = this.localAudioBufferCache.get(track.id) 
      || (track.audioId && this.localAudioBufferCache.get(track.audioId))
      || (track.audioUrl && this.localAudioBufferCache.get(track.audioUrl))
      || this.localAudioBufferCache.get(track.name)
      || (this.currentAudioArrayBuffer && this.lastKnownTrack?.name === track.name ? this.currentAudioArrayBuffer : null);

    if (cached) {
      this.currentFetchingTrackKey = null;
      this.pendingTrackBufferRequest = null;
      if (track.id) this.localAudioBufferCache.set(track.id, cached);
      if (track.name) this.localAudioBufferCache.set(track.name, cached);
      this.updateLoadingState(false, 'Siap');
      this.onEvent('BINARY_AUDIO_RECEIVED', { arrayBuffer: cached, trackName: track.name, trackId: track.id });
      return;
    }

    // Single-flight guard: prevent blinking loops if fetch is already in flight for this track
    if (this.currentFetchingTrackKey === trackKey && this.pendingTrackBufferRequest) {
      return;
    }
    this.currentFetchingTrackKey = trackKey;
    this.pendingTrackBufferRequest = track;

    let fetchUrl = track.audioUrl;
    if (!fetchUrl || fetchUrl.startsWith('blob:')) {
      fetchUrl = `/api/room?action=get_audio&roomId=${encodeURIComponent(this.roomId)}&audioId=${encodeURIComponent(track.audioId || track.id || '')}&trackName=${encodeURIComponent(track.name || '')}`;
    }

    this.requestTrackBufferFromPeers(track.name, track.id);
    this.fetchRemoteAudioUrl(fetchUrl, track.name, track.id);
  }

  requestTrackBufferFromPeers(trackName, trackId) {
    const now = Date.now();
    if (this.lastRequestPeerTime && (now - this.lastRequestPeerTime < 1000)) return;
    this.lastRequestPeerTime = now;

    let sent = false;
    this.dataChannels.forEach(channel => {
      if (channel.readyState === 'open') {
        try {
          channel.send(JSON.stringify({ type: 'REQUEST_AUDIO_BUFFER', trackName, trackId }));
          sent = true;
        } catch (e) { }
      }
    });
    return sent;
  }

  async updateLoadingState(isLoading, status = '') {
    const me = this.localPeersMap.get(this.peerId);
    if (me) {
      me.isAudioLoading = isLoading;
      me.loadingStatus = status;
      this.dispatchLocalPeers();
    }

    try {
      await fetch('/api/room?action=update_peer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          peerId: this.peerId,
          isAudioLoading: isLoading,
          loadingStatus: status
        })
      });
    } catch (e) { }
  }

  async addToQueue(track) {
    // Optimistic immediate queue update
    const currentQ = this.lastKnownQueue || [];
    const item = {
      id: track.id || ('q_' + Math.random().toString(36).substring(2, 9)),
      name: track.name || 'Untitled',
      artist: track.artist || 'Artist',
      duration: track.duration || 0,
      thumbnail: track.thumbnail || '',
      audioUrl: track.audioUrl || '',
      isSynthetic: !!track.isSynthetic,
      addedBy: track.addedBy || this.deviceName
    };

    if (!currentQ.some(q => q.id === item.id)) {
      this.lastKnownQueue = [...currentQ, item];
      this.lastKnownQueueStr = JSON.stringify(this.lastKnownQueue);
      this.onEvent('QUEUE_UPDATED', { queue: this.lastKnownQueue });
      this.publishMqtt(this.roomTopic, { type: 'QUEUE_UPDATED', queue: this.lastKnownQueue });
      this.broadcastDataChannelMessage({ type: 'QUEUE_UPDATED', queue: this.lastKnownQueue });
    }

    if (!this.lastKnownTrack) {
      this.lastKnownTrack = item;
      this.onEvent('TRACK_METADATA', item);
      this.publishMqtt(this.roomTopic, { type: 'TRACK_METADATA', metadata: item });
      this.broadcastDataChannelMessage({ type: 'TRACK_METADATA', metadata: item });
    }

    try {
      const res = await fetch('/api/room?action=add_queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          peerId: this.peerId,
          deviceName: this.deviceName,
          ...item
        })
      });
      const data = await res.json();
      if (data.queue && data.queue.length > 0) {
        this.lastKnownQueue = data.queue;
        this.lastKnownQueueStr = JSON.stringify(data.queue);
        this.onEvent('QUEUE_UPDATED', { queue: data.queue });
        this.publishMqtt(this.roomTopic, { type: 'QUEUE_UPDATED', queue: data.queue });
        this.broadcastDataChannelMessage({ type: 'QUEUE_UPDATED', queue: data.queue });
        if (this.broadcastChannel) {
          this.broadcastChannel.postMessage({
            type: 'QUEUE_UPDATED',
            payload: { queue: data.queue }
          });
        }
      }
      if (data.track && (!this.lastKnownTrack || data.track.id !== this.lastKnownTrack.id)) {
        this.lastKnownTrack = data.track;
        this.onEvent('TRACK_METADATA', data.track);
        this.publishMqtt(this.roomTopic, { type: 'TRACK_METADATA', metadata: data.track });
      }
    } catch (e) { }
  }

  async playQueueItem(queueId) {
    try {
      const res = await fetch('/api/room?action=play_queue_item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: this.roomId, queueId })
      });
      const data = await res.json();
      if (data.track) {
        this.lastKnownTrack = data.track;
        this.isPaused = false;
        this.lastKnownState = data.targetServerTime;
        this.onEvent('TRACK_METADATA', data.track);
        this.loadTrackBuffer(data.track);
        this.onEvent('SCHEDULED_PLAY', {
          targetServerTime: data.targetServerTime || (Date.now() + 800),
          startOffsetSec: data.startOffsetSec || 0,
          track: data.track
        });
        this.publishMqtt(this.roomTopic, {
          type: 'SCHEDULED_PLAY',
          payload: {
            targetServerTime: data.targetServerTime || (Date.now() + 800),
            startOffsetSec: data.startOffsetSec || 0,
            track: data.track
          }
        });
      }
      if (data.queue) {
        this.lastKnownQueue = data.queue;
        this.lastKnownQueueStr = JSON.stringify(data.queue);
        this.onEvent('QUEUE_UPDATED', { queue: data.queue });
        this.publishMqtt(this.roomTopic, { type: 'QUEUE_UPDATED', queue: data.queue });
        this.broadcastDataChannelMessage({ type: 'QUEUE_UPDATED', queue: data.queue });
      }
    } catch (e) { }
  }

  async reorderQueue(newQueue) {
    this.lastQueueReorderTime = Date.now();
    this.lastKnownQueue = newQueue;
    this.lastKnownQueueStr = JSON.stringify(newQueue);
    this.onEvent('QUEUE_UPDATED', { queue: newQueue });
    this.publishMqtt(this.roomTopic, { type: 'QUEUE_UPDATED', queue: newQueue });
    this.broadcastDataChannelMessage({ type: 'QUEUE_UPDATED', queue: newQueue });
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'QUEUE_UPDATED',
        payload: { queue: newQueue }
      });
    }

    try {
      const res = await fetch('/api/room?action=reorder_queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: this.roomId, queue: newQueue })
      });
      const data = await res.json();
      if (data.queue) {
        this.lastKnownQueue = data.queue;
        this.lastKnownQueueStr = JSON.stringify(data.queue);
      }
    } catch (e) { }
  }

  async removeFromQueue(queueId) {
    if (queueId) {
      this.deletedQueueIds.add(queueId);
      this.lastKnownQueue = (this.lastKnownQueue || []).filter(q => q.id !== queueId);
      this.lastKnownQueueStr = JSON.stringify(this.lastKnownQueue);
      this.onEvent('QUEUE_UPDATED', { queue: this.lastKnownQueue });
      this.publishMqtt(this.roomTopic, { type: 'QUEUE_UPDATED', queue: this.lastKnownQueue });
      this.broadcastDataChannelMessage({ type: 'QUEUE_UPDATED', queue: this.lastKnownQueue });
    }

    try {
      const res = await fetch('/api/room?action=remove_queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          queueId
        })
      });
      const data = await res.json();
      if (data.queue) {
        this.lastKnownQueue = data.queue.filter(q => !this.deletedQueueIds.has(q.id));
        this.lastKnownQueueStr = JSON.stringify(this.lastKnownQueue);
        this.onEvent('QUEUE_UPDATED', { queue: this.lastKnownQueue });
      }
    } catch (e) { }
  }

  async nextTrack() {
    try {
      const res = await fetch('/api/room?action=next_track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: this.roomId })
      });
      const data = await res.json();
      if (data.track) {
        this.lastKnownTrack = data.track;
        this.isPaused = (data.state === 'PAUSED');
        this.lastKnownState = data.targetServerTime;
        this.onEvent('TRACK_METADATA', data.track);
        this.loadTrackBuffer(data.track);
        if (data.state === 'PLAYING') {
          const payload = {
            targetServerTime: data.targetServerTime || (Date.now() + 800),
            startOffsetSec: data.startOffsetSec || 0,
            track: data.track
          };
          this.onEvent('SCHEDULED_PLAY', payload);
          this.publishMqtt(this.roomTopic, { type: 'SCHEDULED_PLAY', payload });
        }
      }
      if (data.queue) {
        this.lastKnownQueue = data.queue;
        this.lastKnownQueueStr = JSON.stringify(data.queue);
        this.onEvent('QUEUE_UPDATED', { queue: data.queue });
        this.publishMqtt(this.roomTopic, { type: 'QUEUE_UPDATED', queue: data.queue });
      }
    } catch (e) { }
  }

  async prevTrack() {
    try {
      const res = await fetch('/api/room?action=prev_track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: this.roomId })
      });
      const data = await res.json();
      if (data.track) {
        this.lastKnownTrack = data.track;
        this.isPaused = (data.state === 'PAUSED');
        this.lastKnownState = data.targetServerTime;
        this.onEvent('TRACK_METADATA', data.track);
        this.loadTrackBuffer(data.track);
        if (data.state === 'PLAYING') {
          const payload = {
            targetServerTime: data.targetServerTime || (Date.now() + 800),
            startOffsetSec: data.startOffsetSec || 0,
            track: data.track
          };
          this.onEvent('SCHEDULED_PLAY', payload);
          this.publishMqtt(this.roomTopic, { type: 'SCHEDULED_PLAY', payload });
        }
      }
      if (data.queue) {
        this.lastKnownQueue = data.queue;
        this.lastKnownQueueStr = JSON.stringify(data.queue);
        this.onEvent('QUEUE_UPDATED', { queue: data.queue });
        this.publishMqtt(this.roomTopic, { type: 'QUEUE_UPDATED', queue: data.queue });
      }
    } catch (e) { }
  }

  async updateRemotePeerSettings(targetPeerId, role, volume) {
    const peer = this.localPeersMap.get(targetPeerId);
    if (peer) {
      peer.role = role;
      peer.volume = volume;
      this.dispatchLocalPeers();
    }

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'REMOTE_DEVICE_UPDATED',
        targetPeerId,
        payload: { role, volume }
      });
    }

    const channel = this.dataChannels.get(targetPeerId);
    if (channel && channel.readyState === 'open') {
      try {
        channel.send(JSON.stringify({ type: 'PEER_SETTINGS', role, volume }));
      } catch (e) { }
    }

    try {
      await fetch('/api/room?action=update_peer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: this.roomId, targetPeerId, role, volume })
      });
    } catch (e) { }
  }

  async fetchRemoteAudioUrl(url, trackName, trackId) {
    if (!this.incomingAudioChunks.size) {
      this.updateLoadingState(true, `Mengunduh ${trackName} (0%)...`);
      this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 0, status: `Mengunduh ${trackName} (0%)...` });
    }
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentLength = response.headers.get('content-length');
      const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;

      let arrayBuffer;
      if (response.body && totalBytes > 0) {
        const reader = response.body.getReader();
        const chunks = [];
        let receivedBytes = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          receivedBytes += value.length;
          const pct = Math.min(99, Math.round((receivedBytes / totalBytes) * 100));
          this.updateLoadingState(true, `Mengunduh ${pct}%`);
          this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct, status: `Mengunduh (${pct}%)...` });
        }

        const complete = new Uint8Array(receivedBytes);
        let offset = 0;
        for (const c of chunks) {
          complete.set(c, offset);
          offset += c.length;
        }
        arrayBuffer = complete.buffer;
      } else {
        arrayBuffer = await response.arrayBuffer();
      }

      this.localAudioBufferCache.set(trackName, arrayBuffer);
      if (trackId) this.localAudioBufferCache.set(trackId, arrayBuffer);
      this.localAudioBufferCache.set(url, arrayBuffer);

      this.currentFetchingTrackKey = null;
      this.pendingTrackBufferRequest = null;
      this.updateLoadingState(false, 'Siap');
      this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 100, status: 'Audio siap!' });
      this.onEvent('BINARY_AUDIO_RECEIVED', { arrayBuffer, trackName, trackId });
    } catch (err) {
      this.currentFetchingTrackKey = null;
      console.warn('Remote fetch notice, awaiting WebRTC stream:', err.message);
      if (!this.incomingAudioChunks.size) {
        this.updateLoadingState(true, 'Menunggu audio...');
        this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 0, status: 'Menunggu audio...' });
      }
      this.requestTrackBufferFromPeers(trackName, trackId);
    }
  }

  async broadcastPlay(targetServerTime, startOffsetSec, track) {
    this.isPaused = false;
    this.lastKnownState = targetServerTime;
    const trackPayload = track || this.lastKnownTrack;

    this.publishMqtt(this.roomTopic, {
      type: 'SCHEDULED_PLAY',
      payload: { targetServerTime, startOffsetSec, track: trackPayload }
    });

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'SCHEDULED_PLAY',
        payload: { targetServerTime, startOffsetSec, track: trackPayload }
      });
    }

    this.dataChannels.forEach(channel => {
      if (channel.readyState === 'open') {
        try {
          channel.send(JSON.stringify({ type: 'SCHEDULED_PLAY', targetServerTime, startOffsetSec, track: trackPayload }));
        } catch (e) { }
      }
    });

    try {
      fetch('/api/room?action=update_playback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          state: 'PLAYING',
          targetServerTime,
          startOffsetSec,
          track: trackPayload
        })
      }).catch(() => {});
    } catch (e) { }
  }

  async broadcastPause(currentOffsetSec) {
    this.isPaused = true;
    this.lastPauseTime = Date.now();
    this.lastKnownState = 'PAUSED';

    this.publishMqtt(this.roomTopic, {
      type: 'PAUSED',
      payload: { currentOffsetSec }
    });

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'PAUSED',
        payload: { currentOffsetSec }
      });
    }

    this.dataChannels.forEach(channel => {
      if (channel.readyState === 'open') {
        try {
          channel.send(JSON.stringify({ type: 'PAUSED', currentOffsetSec }));
        } catch (e) { }
      }
    });

    try {
      fetch('/api/room?action=update_playback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          state: 'PAUSED',
          startOffsetSec: currentOffsetSec
        })
      }).catch(() => {});
    } catch (e) { }
  }

  async broadcastTrack(metadata) {
    this.lastKnownTrack = metadata;

    this.publishMqtt(this.roomTopic, {
      type: 'TRACK_METADATA',
      payload: metadata
    });

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'TRACK_METADATA',
        payload: metadata
      });
    }

    this.dataChannels.forEach(channel => {
      if (channel.readyState === 'open') {
        try {
          channel.send(JSON.stringify({ type: 'TRACK_METADATA', metadata }));
        } catch (e) { }
      }
    });

    try {
      fetch('/api/room?action=update_playback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          track: metadata
        })
      }).catch(() => {});
    } catch (e) { }
  }

  async updateLatencyOffset(offsetMs) { }

  // --- WebRTC P2P DataChannel ---
  createPeerConnection(targetPeerId) {
    const config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    };

    const pc = new RTCPeerConnection(config);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(targetPeerId, {
          type: 'candidate',
          candidate: event.candidate.toJSON()
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        try { pc.close(); } catch (e) { }
        this.peerConnections.delete(targetPeerId);
        this.dataChannels.delete(targetPeerId);
      }
    };

    pc.ondatachannel = (event) => {
      this.setupDataChannel(targetPeerId, event.channel);
    };

    this.peerConnections.set(targetPeerId, pc);
    return pc;
  }

  setupDataChannel(targetPeerId, channel) {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      this.dataChannels.set(targetPeerId, channel);
      if (this.isHost) {
        const targetTrack = this.lastKnownTrack;
        const activeBuffer = (targetTrack && (this.localAudioBufferCache.get(targetTrack.id) || this.localAudioBufferCache.get(targetTrack.name)))
          || this.currentAudioArrayBuffer;
        if (activeBuffer && (activeBuffer instanceof ArrayBuffer || activeBuffer.byteLength)) {
          this.streamAudioToPeer(channel, activeBuffer, targetTrack?.name || 'Uploaded Track', targetTrack?.id || '');
        }
      } else {
        const reqTrack = this.pendingTrackBufferRequest || this.lastKnownTrack;
        if (reqTrack) {
          const cached = this.localAudioBufferCache.get(reqTrack.id) || this.localAudioBufferCache.get(reqTrack.name);
          if (!cached) {
            try {
              channel.send(JSON.stringify({
                type: 'REQUEST_AUDIO_BUFFER',
                trackName: reqTrack.name,
                trackId: reqTrack.id
              }));
            } catch (e) { }
          }
        }
      }
    };

    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'AUDIO_HEADER') {
            this.incomingAudioChunks.set(targetPeerId, {
              name: msg.name,
              id: msg.id,
              totalBytes: msg.totalBytes,
              totalChunks: msg.totalChunks,
              receivedBytes: 0,
              chunks: []
            });
            this.updateLoadingState(true, `Menerima ${msg.name}...`);
            this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 0, status: `Menerima ${msg.name} P2P...` });
          } else if (msg.type === 'SCHEDULED_PLAY') {
            this.isPaused = false;
            this.onEvent('SCHEDULED_PLAY', {
              targetServerTime: msg.targetServerTime,
              startOffsetSec: msg.startOffsetSec || 0,
              track: msg.track || this.lastKnownTrack
            });
          } else if (msg.type === 'PAUSED') {
            this.isPaused = true;
            this.lastPauseTime = Date.now();
            this.onEvent('PAUSED', {
              currentOffsetSec: msg.currentOffsetSec || 0
            });
          } else if (msg.type === 'QUEUE_UPDATED') {
            if (Array.isArray(msg.queue)) {
              this.lastKnownQueue = msg.queue;
              this.lastKnownQueueStr = JSON.stringify(msg.queue);
              this.onEvent('QUEUE_UPDATED', { queue: msg.queue });
            }
          } else if (msg.type === 'TRACK_METADATA') {
            this.onEvent('TRACK_METADATA', msg.metadata);
          } else if (msg.type === 'PEER_SETTINGS') {
            this.onEvent('REMOTE_DEVICE_UPDATED', { role: msg.role, volume: msg.volume });
          } else if (msg.type === 'REQUEST_AUDIO_BUFFER') {
            const now = Date.now();
            if (this.lastSentBufferTime && (now - this.lastSentBufferTime < 1500) && this.lastSentBufferTrack === msg.trackName) {
              return;
            }
            const cached = this.localAudioBufferCache.get(msg.trackId) 
              || this.localAudioBufferCache.get(msg.trackName)
              || this.currentAudioArrayBuffer;
            if (cached && (cached instanceof ArrayBuffer || cached.byteLength)) {
              this.lastSentBufferTime = now;
              this.lastSentBufferTrack = msg.trackName;
              this.streamAudioToPeer(channel, cached, msg.trackName || this.lastKnownTrack?.name || 'Uploaded Track', msg.trackId || this.lastKnownTrack?.id || '');
            }
          }
        } catch (e) { }
        return;
      }

      if (event.data instanceof ArrayBuffer) {
        const stream = this.incomingAudioChunks.get(targetPeerId);
        if (stream) {
          stream.chunks.push(event.data);
          stream.receivedBytes += event.data.byteLength;
          const pct = Math.min(99, Math.round((stream.receivedBytes / stream.totalBytes) * 100));
          this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct, status: `Menerima P2P (${pct}%)...` });

          if (stream.chunks.length >= stream.totalChunks || stream.receivedBytes >= stream.totalBytes) {
            const completeBuffer = new Uint8Array(stream.receivedBytes);
            let offset = 0;
            for (const c of stream.chunks) {
              completeBuffer.set(new Uint8Array(c), offset);
              offset += c.byteLength;
            }
            const trackName = stream.name;
            const trackId = stream.id;
            this.incomingAudioChunks.delete(targetPeerId);
            this.updateLoadingState(false, 'Siap');
            this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 100, status: 'Audio P2P Siap!' });
            this.onEvent('BINARY_AUDIO_RECEIVED', {
              arrayBuffer: completeBuffer.buffer,
              trackName,
              trackId
            });
          }
        }
      }
    };

    channel.onclose = () => {
      this.dataChannels.delete(targetPeerId);
    };
  }

  async initiateWebRTCOffer(targetPeerId) {
    const pc = this.createPeerConnection(targetPeerId);
    const channel = pc.createDataChannel('audioMesh', { ordered: true });
    this.setupDataChannel(targetPeerId, channel);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.sendSignal(targetPeerId, {
        type: 'offer',
        sdp: pc.localDescription.toJSON()
      });
    } catch (e) {
      console.warn('WebRTC offer error:', e.message);
    }
  }

  async sendSignal(targetPeerId, signalData) {
    this.publishMqtt(`rync432/v1/peer/${targetPeerId}`, {
      type: 'SIGNAL',
      from: this.peerId,
      data: signalData
    });

    try {
      fetch('/api/room?action=signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          peerId: this.peerId,
          to: targetPeerId,
          data: signalData
        })
      }).catch(() => {});
    } catch (e) { }
  }

  async handleIncomingSignal(fromPeerId, signalData) {
    let pc = this.peerConnections.get(fromPeerId);
    if (!pc) {
      pc = this.createPeerConnection(fromPeerId);
    }

    try {
      if (signalData.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.sendSignal(fromPeerId, {
          type: 'answer',
          sdp: pc.localDescription.toJSON()
        });
      } else if (signalData.type === 'answer') {
        if (pc.signalingState !== 'stable') {
          await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
        }
      } else if (signalData.type === 'candidate') {
        if (signalData.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
        }
      }
    } catch (e) {
      console.warn('Signal error:', e.message);
    }
  }

  streamAudioToAllPeers(arrayBuffer, trackName = 'Uploaded Track', trackId = '') {
    this.currentAudioArrayBuffer = arrayBuffer;
    this.dataChannels.forEach((channel) => {
      if (channel.readyState === 'open') {
        this.streamAudioToPeer(channel, arrayBuffer, trackName, trackId);
      }
    });
  }

  streamAudioToPeer(channel, arrayBuffer, trackName = 'Uploaded Track', trackId = '') {
    if (!channel || channel.readyState !== 'open' || !arrayBuffer) return;
    const chunkSize = 64 * 1024;
    const totalBytes = arrayBuffer.byteLength;
    const totalChunks = Math.ceil(totalBytes / chunkSize);

    try {
      channel.send(JSON.stringify({
        type: 'AUDIO_HEADER',
        name: trackName,
        id: trackId,
        totalBytes,
        totalChunks
      }));

      for (let offset = 0; offset < totalBytes; offset += chunkSize) {
        const chunk = arrayBuffer.slice(offset, offset + chunkSize);
        channel.send(chunk);
      }
    } catch (e) { }
  }

  async removeRemotePeer(targetPeerId) {
    this.localPeersMap.delete(targetPeerId);
    this.dispatchLocalPeers();

    const pc = this.peerConnections.get(targetPeerId);
    if (pc) {
      try { pc.close(); } catch (e) { }
      this.peerConnections.delete(targetPeerId);
    }
    this.dataChannels.delete(targetPeerId);

    try {
      fetch('/api/room?action=remove_peer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: this.roomId, targetPeerId })
      }).catch(() => {});
    } catch (e) { }
  }

  leaveRoom() {
    this.unsubscribe();
    if (this.roomTopic) {
      this.publishMqtt(this.roomTopic, {
        type: 'PEER_LEFT',
        peerId: this.peerId
      });
    }
    if (this.roomId && this.peerId) {
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(`/api/room?action=leave_room&roomId=${this.roomId}&peerId=${this.peerId}`);
        } else {
          fetch(`/api/room?action=leave_room&roomId=${this.roomId}&peerId=${this.peerId}`, { method: 'POST', keepalive: true }).catch(() => {});
        }
      } catch (e) { }
    }
  }

  unsubscribe() {
    this.stopPolling();
    if (this.mqttClient) {
      try { this.mqttClient.end(true); } catch (e) {}
      this.mqttClient = null;
      this.isMqttConnected = false;
    }
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage({
          type: 'PEER_LEFT',
          peerId: this.peerId
        });
        this.broadcastChannel.close();
      } catch (e) { }
      this.broadcastChannel = null;
    }
  }
}
