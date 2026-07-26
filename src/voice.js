// Optional voice chat (default OFF, explicit microphone opt-in).
// Contract: https://wiki.starhermit.com/docs/api/voice.html
//
// Flow: GET /api/v1/voice/rooms?conversationId= (create if none) ->
// POST /rooms/{id}/join (required before the WS) -> ws/v1/voice?roomId=.
// Audio runs over WebRTC P2P with perfect negotiation; signaling rides the
// socket's rtc control frames. The server-relayed Opus binary fallback is NOT
// implemented (see README limitations) — WebRTC covers modern browsers.
// Voice setup never blocks gameplay; any failure just disables voice.

import { wsUrl } from './net.js';

// ---------------------------------------------------------------------------
// Pure signaling helpers (unit-tested)

// Perfect negotiation: the peer with the lexicographically larger user id is
// "polite" (rolls back on offer collision).
export function isPolite(myUserId, peerUserId) {
  return String(myUserId) > String(peerUserId);
}

// Roster diff: which peers to connect and which to drop.
export function rosterDiff(peers, participants, myUserId) {
  const ids = new Set(
    (participants || []).map((p) => p.userId).filter((id) => id && id !== myUserId));
  const connect = [...ids].filter((id) => !peers.has(id));
  const drop = [...peers.keys()].filter((id) => !ids.has(id));
  return { connect, drop };
}

// ---------------------------------------------------------------------------

export class VoiceController {
  // net: net context; conversationId: the session's chat conversation.
  // Handlers: onParticipants([{userId, muted, speaking}]), onState(enabled), onError(msg)
  constructor(net, conversationId, handlers = {}) {
    this.net = net;
    this.conversationId = conversationId;
    this.handlers = handlers;
    this.enabled = false;
    this.roomId = null;
    this.ws = null;
    this.stream = null;
    this.peers = new Map(); // userId -> { pc, audioEl, makingOffer, ignoreOffer }
    this.participants = new Map(); // userId -> { muted, speaking }
    this.audioCtx = null;
    this.speakingTimer = null;
    this.destroyed = false;
  }

  async enable() {
    if (this.enabled) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      this.handlers.onError && this.handlers.onError('Microphone access denied');
      return;
    }
    try {
      // Find or create the voice room for this session's conversation.
      const rooms = await this.net.client.get(
        `/api/v1/voice/rooms?conversationId=${this.conversationId}`);
      let room = Array.isArray(rooms) && rooms[0];
      if (!room) {
        room = await this.net.client.post('/api/v1/voice/rooms',
          { conversationId: this.conversationId, maxParticipants: 10 });
      }
      this.roomId = room.id;
      await this.net.client.post(`/api/v1/voice/rooms/${this.roomId}/join`);
      this.connectSocket();
      this.enabled = true;
      this.handlers.onState && this.handlers.onState(true);
      this.startSpeakingDetection();
    } catch (e) {
      this.handlers.onError && this.handlers.onError(`Voice unavailable: ${e.message || e}`);
      this.disable();
    }
  }

  connectSocket() {
    const url = wsUrl('/ws/v1/voice', {
      roomId: this.roomId,
      access_token: this.net.tokenManager.token,
    });
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return; // binary = relayed audio fallback (unused)
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.onServerEvent(msg);
    };
    this.ws.onclose = () => {
      // No auto-reconnect: voice re-joins on the next explicit enable().
      if (this.enabled && !this.destroyed) this.disable();
    };
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  onServerEvent(msg) {
    switch (msg.event) {
      case 'voice.roster':
        for (const p of msg.data.participants || []) this.addParticipant(p.userId, p.muted);
        this.syncPeers();
        break;
      case 'voice.participant_joined':
        this.addParticipant(msg.data.userId, msg.data.muted);
        this.syncPeers();
        break;
      case 'voice.participant_left':
        this.removePeer(msg.data.userId);
        this.participants.delete(msg.data.userId);
        this.emitParticipants();
        break;
      case 'voice.mute_changed': {
        const p = this.participants.get(msg.data.userId);
        if (p) p.muted = !!msg.data.muted;
        this.emitParticipants();
        break;
      }
      case 'voice.speaking': {
        const p = this.participants.get(msg.data.userId);
        if (p) p.speaking = !!msg.data.speaking;
        this.emitParticipants();
        break;
      }
      case 'voice.rtc':
        this.onRtc(msg.data.from, msg.data.payload);
        break;
      default:
        break;
    }
  }

  addParticipant(userId, muted) {
    if (userId && userId !== this.net.userId) {
      this.participants.set(userId, { muted: !!muted, speaking: false });
      this.emitParticipants();
    }
  }

  emitParticipants() {
    if (!this.handlers.onParticipants) return;
    this.handlers.onParticipants(
      [...this.participants.entries()].map(([userId, p]) => ({ userId, ...p })));
  }

  syncPeers() {
    const { connect, drop } = rosterDiff(
      this.peers, [...this.participants.keys()].map((userId) => ({ userId })), this.net.userId);
    for (const id of drop) this.removePeer(id);
    for (const id of connect) this.createPeer(id);
  }

  createPeer(userId) {
    const pc = new RTCPeerConnection();
    const peer = { pc, makingOffer: false, ignoreOffer: false, audioEl: null };
    this.peers.set(userId, peer);

    for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.send({ type: 'rtc', to: userId, payload: { sdp: pc.localDescription } });
      } catch { /* negotiation failure is non-fatal */ } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send({ type: 'rtc', to: userId, payload: { ice: candidate } });
    };
    pc.ontrack = (ev) => {
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.srcObject = ev.streams[0];
      peer.audioEl = audio;
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.removePeer(userId);
    };
    return peer;
  }

  async onRtc(from, payload) {
    if (!payload || this.destroyed) return;
    let peer = this.peers.get(from);
    if (!peer) peer = this.createPeer(from);
    const pc = peer.pc;
    const polite = isPolite(this.net.userId, from);
    try {
      if (payload.sdp) {
        const collision = payload.sdp.type === 'offer' &&
          (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(payload.sdp);
        if (payload.sdp.type === 'offer') {
          await pc.setLocalDescription();
          this.send({ type: 'rtc', to: from, payload: { sdp: pc.localDescription } });
        }
      } else if (payload.ice) {
        try {
          await pc.addIceCandidate(payload.ice);
        } catch (e) {
          if (!peer.ignoreOffer) throw e;
        }
      }
    } catch { /* signaling errors disable this peer, not voice */ }
  }

  removePeer(userId) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    try { peer.pc.close(); } catch { /* already closed */ }
    if (peer.audioEl) peer.audioEl.srcObject = null;
    this.peers.delete(userId);
  }

  startSpeakingDetection() {
    try {
      this.audioCtx = new AudioContext();
      const source = this.audioCtx.createMediaStreamSource(this.stream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let speaking = false;
      this.speakingTimer = setInterval(() => {
        analyser.getByteFrequencyData(data);
        const level = data.reduce((t, v) => t + v, 0) / data.length;
        const now = level > 12;
        if (now !== speaking) {
          speaking = now;
          this.send({ type: 'speaking', speaking });
        }
      }, 400);
    } catch { /* no speaking indicator — voice still works */ }
  }

  async setMuted(muted) {
    if (this.stream) {
      for (const track of this.stream.getAudioTracks()) track.enabled = !muted;
    }
    this.send({ type: 'mute', muted });
    if (this.roomId) {
      try {
        await this.net.client.post(`/api/v1/voice/rooms/${this.roomId}/mute`, { muted });
      } catch { /* local mute still applies */ }
    }
  }

  disable() {
    this.enabled = false;
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.participants.clear();
    if (this.speakingTimer) clearInterval(this.speakingTimer);
    this.speakingTimer = null;
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      try { this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
    if (this.roomId) {
      this.net.client.post(`/api/v1/voice/rooms/${this.roomId}/leave`).catch(() => {});
      this.roomId = null;
    }
    this.handlers.onState && this.handlers.onState(false);
    this.emitParticipants();
  }

  destroy() {
    this.destroyed = true;
    this.disable();
  }
}
