import { ICE_SERVERS } from './config.js';

/**
 * VoiceChat — peer-to-peer audio using a WebRTC full mesh.
 * The WebSocket is only used for SIGNALLING (offer/answer/ICE); audio flows directly between browsers.
 *
 * Who calls whom? To avoid "glare" (both sides offering at once) the peer with the
 * lexicographically SMALLER id always initiates. Both join orders are covered:
 *   • I join, peer already in voice  → my join() loop offers if my id < theirs, otherwise
 *                                      the peer offers when it receives my `voice:state`.
 *   • Peer joins after me            → I get `voice:state on`, and offer if my id < theirs.
 */
export class VoiceChat {
  constructor({ socket, getSelfId, sink, onState, onSpeaking }) {
    this.socket = socket;
    this.getSelfId = getSelfId;
    this.sink = sink;               // hidden container for <audio> elements
    this.onState = onState;
    this.onSpeaking = onSpeaking;

    this.stream = null;
    this.muted = false;
    this.peers = new Map();         // peerId → { pc, audio }
    this.pending = new Map();       // peerId → ICE candidates that arrived before the remote description
    this._watchers = new Map();     // peerId → stop()
    this._audioCtx = null;
  }

  get active() { return Boolean(this.stream); }

  /* ------------------------------ Join / leave --------------------------- */
  async join(users) {
    if (this.active) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access needs HTTPS or localhost.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    this.muted = false;
    this._audioCtx = new (window.AudioContext || window.webkitAudioContext)(); // created inside a click → allowed
    this._watch(this.getSelfId(), this.stream);

    this.socket.send({ type: 'voice:state', on: true });
    this.onState?.();
    for (const u of users) if (u.voice && u.id !== this.getSelfId()) this.peerVoiceOn(u.id);
  }

  leave() {
    if (!this.active) return;
    for (const id of [...this.peers.keys()]) this._teardown(id);
    this.pending.clear();
    for (const stop of this._watchers.values()) stop();
    this._watchers.clear();
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this._audioCtx?.close().catch(() => {});
    this._audioCtx = null;
    this.socket.send({ type: 'voice:state', on: false });
    this.onState?.();
  }

  setMuted(muted) {
    this.muted = muted;
    this.stream?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    this.onState?.();
  }

  /** After a WebSocket reconnect: re-announce and re-offer to any peer we aren't connected to. */
  resync(users) {
    if (!this.active) return;
    this.socket.send({ type: 'voice:state', on: true });
    for (const u of users) if (u.voice && u.id !== this.getSelfId()) this.peerVoiceOn(u.id);
  }

  /* ----------------------------- Peer lifecycle -------------------------- */
  peerVoiceOn(id) {
    if (!this.active) return;
    if (this.getSelfId() >= id) return;                    // the other side initiates
    const existing = this.peers.get(id);
    if (existing && existing.pc.connectionState === 'connected') return;
    this._teardown(id);
    this._connectTo(id);
  }

  peerVoiceOff(id) { this._teardown(id); this.pending.delete(id); }

  async _connectTo(id) {                                   // we are the INITIATOR
    try {
      const pc = this._createPeer(id);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this._signal(id, { sdp: pc.localDescription });
    } catch (err) { console.warn('[voice] offer failed', err); }
  }

  _createPeer(id) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.stream.getTracks().forEach((t) => pc.addTrack(t, this.stream));

    const audio = new Audio();
    audio.autoplay = true;
    audio.playsInline = true;
    this.sink.appendChild(audio);

    pc.onicecandidate = (e) => { if (e.candidate) this._signal(id, { candidate: e.candidate }); };
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0];
      audio.play().catch(() => {});
      if (!this._watchers.has(id)) this._watch(id, e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      this.onState?.();
      if (pc.connectionState === 'failed') {               // initiator retries once after a second
        setTimeout(() => {
          if (this.active && this.peers.get(id)?.pc === pc) {
            this._teardown(id);
            if (this.getSelfId() < id) this._connectTo(id);
          }
        }, 1000);
      }
    };
    this.peers.set(id, { pc, audio });
    return pc;
  }

  _teardown(id) {
    const p = this.peers.get(id);
    if (!p) return;
    p.pc.onconnectionstatechange = null;
    p.pc.close();
    p.audio.srcObject = null;
    p.audio.remove();
    this.peers.delete(id);
    this._watchers.get(id)?.();
    this._watchers.delete(id);
  }

  /* ------------------------------- Signalling ---------------------------- */
  _signal(to, data) { this.socket.send({ type: 'rtc:signal', to, data }); }

  async handleSignal(from, data) {
    if (!this.active || !data) return;
    try {
      if (data.sdp?.type === 'offer') {                    // we are the ANSWERER
        this._teardown(from);
        const pc = this._createPeer(from);
        await pc.setRemoteDescription(data.sdp);
        await this._drain(from, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._signal(from, { sdp: pc.localDescription });
      } else if (data.sdp?.type === 'answer') {
        const pc = this.peers.get(from)?.pc;
        if (!pc) return;
        await pc.setRemoteDescription(data.sdp);
        await this._drain(from, pc);
      } else if (data.candidate) {
        const pc = this.peers.get(from)?.pc;
        if (pc && pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else (this.pending.get(from) || this.pending.set(from, []).get(from)).push(data.candidate);
      }
    } catch (err) { console.warn('[voice] signalling error', err); }
  }

  async _drain(id, pc) {
    const queued = this.pending.get(id) || [];
    this.pending.delete(id);
    for (const c of queued) { try { await pc.addIceCandidate(c); } catch { /* stale candidate */ } }
  }

  /* ---------------------------- Speaking indicator ----------------------- */
  _watch(id, stream) {
    if (!this._audioCtx) return;
    const src = this._audioCtx.createMediaStreamSource(stream);
    const analyser = this._audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    let speaking = false;
    const timer = setInterval(() => {
      analyser.getByteFrequencyData(buf);
      let sum = 0;
      for (const v of buf) sum += v;
      const now = sum / buf.length > 12;
      if (now !== speaking) { speaking = now; this.onSpeaking?.(id, now); }
    }, 150);
    this._watchers.set(id, () => {
      clearInterval(timer);
      try { src.disconnect(); } catch { /* noop */ }
      if (speaking) this.onSpeaking?.(id, false);
    });
  }
}