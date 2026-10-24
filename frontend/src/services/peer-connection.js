/**
 * PairPort WebRTC Peer Connection & DataChannel Service
 * Phase 5: Peer-to-Peer Direct Connection, Real-Time Ephemeral Chat & Chunked File Transfer
 *
 * Establishes an RTCPeerConnection between two browsers using WebSocket signaling.
 * Opens dedicated bidirectional RTCDataChannels for:
 *   - 'pairport-chat': Real-time ephemeral text chat
 *   - 'pairport-files': Chunked binary file transfers with backpressure flow control
 *
 * Zero file bytes or chat messages ever travel through the central FastAPI server.
 */

import { signalingClient } from './signaling.js';
import { APP_CONFIG } from '../config/app-config.js';

export const PEER_CONNECTION_STATES = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  FAILED: 'failed',
  CLOSED: 'closed',
});

export const DATA_CHANNEL_STATES = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  OPEN: 'open',
  CLOSING: 'closing',
  CLOSED: 'closed',
});

export const TRANSFER_STATES = Object.freeze({
  WAITING: 'waiting',
  SENDING: 'sending',
  RECEIVING: 'receiving',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

/** Default STUN configuration for NAT traversal and candidate discovery */
export const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

/**
 * Binary chunk header size: 36 bytes
 * - Bytes 0..31: transferId (UTF-8, zero-padded to 32 bytes)
 * - Bytes 32..35: chunkIndex (UInt32, Big-Endian)
 */
export const CHUNK_HEADER_SIZE = 36;

/**
 * Pack a binary chunk with a fixed 36-byte header containing the transfer ID and chunk index.
 * Eliminates base64 overhead and guarantees self-describing packets.
 */
export function packChunk(transferId, chunkIndex, chunkPayload) {
  const payloadBytes = new Uint8Array(chunkPayload);
  const packet = new Uint8Array(CHUNK_HEADER_SIZE + payloadBytes.byteLength);

  // Transfer ID (first 32 bytes, null-padded)
  const encoder = new TextEncoder();
  const idBytes = encoder.encode(String(transferId).slice(0, 32));
  packet.set(idBytes, 0);

  // Chunk Index (bytes 32..35 as Uint32 Big-Endian)
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  view.setUint32(32, chunkIndex, false);

  // Payload (bytes 36+)
  packet.set(payloadBytes, CHUNK_HEADER_SIZE);
  return packet.buffer;
}

/**
 * Unpack a received binary chunk, extracting the transfer ID, chunk index, and payload slice.
 */
export function unpackChunk(buffer) {
  if (!buffer || buffer.byteLength < CHUNK_HEADER_SIZE) {
    throw new Error(
      `Malformed chunk: buffer size (${buffer ? buffer.byteLength : 0}) < header size (${CHUNK_HEADER_SIZE})`
    );
  }

  const idBytes = new Uint8Array(buffer, 0, 32);
  let idEnd = 32;
  for (let i = 0; i < 32; i++) {
    if (idBytes[i] === 0) {
      idEnd = i;
      break;
    }
  }

  const decoder = new TextDecoder();
  const transferId = decoder.decode(idBytes.subarray(0, idEnd));

  const view = new DataView(buffer);
  const chunkIndex = view.getUint32(32, false);
  const payload = buffer.slice(CHUNK_HEADER_SIZE);

  return { transferId, chunkIndex, payload };
}

/**
 * Sanitize filename to prevent directory traversal and injection attacks.
 */
export function sanitizeFilename(rawName) {
  if (!rawName || typeof rawName !== 'string') return 'unnamed_file';
  // Strip paths (both Unix and Windows slashes), null bytes, and control characters
  let cleaned = rawName
    .replace(/^.*[\\\/]/, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();

  // Strip illegal filesystem characters across Windows/Unix: < > : " / \ | ? *
  cleaned = cleaned.replace(/[<>:"|?*]/g, '');

  // Neutralize relative path attempts and repeated dots
  cleaned = cleaned.replace(/\.\.+/g, '.');

  // Neutralize leading dots
  if (cleaned.startsWith('.') && cleaned.length > 1) {
    cleaned = cleaned.replace(/^\.+/, '');
  }

  // Neutralize Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
  const baseName = cleaned.split('.')[0].toUpperCase();
  const reservedRegex = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  if (reservedRegex.test(baseName)) {
    cleaned = `file_${cleaned}`;
  }

  cleaned = cleaned.trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'unnamed_file';
  return cleaned.slice(0, 255);
}

/**
 * Extract origin session ID from SDP string (RFC 4566/8866 'o=' line).
 * Format: o=<username> <sess-id> <sess-version> <nettype> <addrtype> <unicast-address>
 */
export function extractSdpSessionId(sdpStr) {
  if (!sdpStr || typeof sdpStr !== 'string') return null;
  const match = sdpStr.match(/^o=\S+\s+(\d+)/m);
  return match ? match[1] : null;
}

/**
 * Extract origin session version from SDP string.
 */
export function extractSdpSessionVersion(sdpStr) {
  if (!sdpStr || typeof sdpStr !== 'string') return null;
  const match = sdpStr.match(/^o=\S+\s+\d+\s+(\d+)/m);
  return match ? parseInt(match[1], 10) : null;
}

export class PeerConnectionService {
  constructor(iceServers = APP_CONFIG.iceServers || DEFAULT_ICE_SERVERS) {
    this.iceServers = iceServers;
    this.pc = null;

    // Data channels
    this.chatChannel = null;
    this.fileChannel = null;
    // Alias for backwards compatibility with Phase 4 tests and code
    this.dataChannel = null;

    // States
    this.connectionState = PEER_CONNECTION_STATES.IDLE;
    this.dataChannelState = DATA_CHANNEL_STATES.IDLE;
    this.fileChannelState = DATA_CHANNEL_STATES.IDLE;
    this.role = null;
    this.pendingCandidates = [];
    this.listeners = new Map();
    this.isTearingDown = false;

    // Network resilience, generational guards, and bounded ICE recovery (Phase 6 & 9J-3)
    this.iceRestartAttempts = 0;
    this.maxIceRestartAttempts = 3;
    this.isRestartingIce = false;
    this.iceDisconnectTimer = null;
    this.isProcessingDescription = false;
    this._connectionGeneration = 0;
    this.lastRemoteSdpSessionId = null;
    this.lastRemoteSdpSessionVersion = null;
    this.maxPendingCandidates = 64;

    // File transfer configurations from APP_CONFIG
    this.maxFileSizeBytes = APP_CONFIG.fileTransfer?.maxFileSizeBytes || 100 * 1024 * 1024;
    this.chunkSizeBytes = APP_CONFIG.fileTransfer?.chunkSizeBytes || 16 * 1024;
    this.bufferedAmountLowThreshold = APP_CONFIG.fileTransfer?.bufferedAmountLowThreshold || 64 * 1024;
    this.bufferedAmountHighWatermark = APP_CONFIG.fileTransfer?.bufferedAmountHighWatermark || 512 * 1024;

    // Map of active file transfers: transferId -> transfer object
    this.activeTransfers = new Map();

    this._bindSignalingRelays();
  }

  /** Subscribe to events ('connectionStateChange', 'dataChannelStateChange', 'chatMessage', 'fileTransferProgress', etc.) */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.delete(callback);
    }
  }

  emit(event, ...args) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.forEach((callback) => {
        try {
          callback(...args);
        } catch (err) {
          console.error(`PeerConnectionService listener error for '${event}':`, err);
        }
      });
    }
  }

  /** Check if the current browser environment supports WebRTC */
  static isSupported() {
    return (
      typeof window !== 'undefined' &&
      typeof window.RTCPeerConnection === 'function'
    );
  }

  /** Listen for WebRTC offers, answers, and candidates from the signaling server */
  _bindSignalingRelays() {
    signalingClient.on('signalOffer', async (payload) => {
      try {
        await this.handleRemoteOffer(payload);
      } catch (err) {
        console.error('Error handling remote WebRTC offer:', err);
        this.emit('error', { code: 'OFFER_HANDLING_FAILED', message: 'Failed to process WebRTC offer.' });
      }
    });

    signalingClient.on('signalAnswer', async (payload) => {
      try {
        await this.handleRemoteAnswer(payload);
      } catch (err) {
        console.error('Error handling remote WebRTC answer:', err);
        this.emit('error', { code: 'ANSWER_HANDLING_FAILED', message: 'Failed to process WebRTC answer.' });
      }
    });

    signalingClient.on('signalCandidate', async (payload) => {
      try {
        await this.handleRemoteCandidate(payload);
      } catch (err) {
        console.warn('Error handling remote ICE candidate:', err);
      }
    });

    signalingClient.on('peerLeft', () => {
      this.close();
    });
  }

  /** Initiate WebRTC PeerConnection when both peers are present in the signaling room */
  async startPeerConnection(role) {
    if (!PeerConnectionService.isSupported()) {
      const errorMsg = 'WebRTC RTCPeerConnection is not supported in this browser.';
      this.emit('error', { code: 'WEBRTC_UNSUPPORTED', message: errorMsg });
      throw new Error(errorMsg);
    }

    // Clean up existing connection if any
    this.close();
    this.isTearingDown = false;
    this.role = role;
    this.pendingCandidates = [];
    this.iceRestartAttempts = 0;
    this.isRestartingIce = false;
    this._connectionGeneration = (this._connectionGeneration || 0) + 1;
    const currentGeneration = this._connectionGeneration;

    this._setConnectionState(PEER_CONNECTION_STATES.CONNECTING);

    try {
      this.pc = new RTCPeerConnection({
        iceServers: this.iceServers,
        iceCandidatePoolSize: 2,
      });

      // 1. ICE Candidate generation handler
      this.pc.onicecandidate = (event) => {
        if (this._connectionGeneration !== currentGeneration || !this.pc) return;
        if (event.candidate) {
          signalingClient.sendCandidate(event.candidate.toJSON());
        } else {
          // Null candidate signals end of candidates
          signalingClient.sendCandidate(null);
        }
      };

      // 2. Peer Connection state monitoring
      this.pc.onconnectionstatechange = () => {
        if (this._connectionGeneration !== currentGeneration || !this.pc || this.isTearingDown) return;
        const state = this.pc.connectionState;
        this._setConnectionState(state);

        if (state === 'connected') {
          if (this.iceDisconnectTimer) {
            clearTimeout(this.iceDisconnectTimer);
            this.iceDisconnectTimer = null;
          }
          this.iceRestartAttempts = 0;
          this.isRestartingIce = false;
          this.emitDiagnosticsUpdate();
        } else if (state === 'disconnected') {
          this._handleTransientDisconnection('Peer connection disconnected');
        } else if (state === 'failed') {
          if (this.iceDisconnectTimer) {
            clearTimeout(this.iceDisconnectTimer);
            this.iceDisconnectTimer = null;
          }
          this.attemptIceRestart('Peer connection failed');
        } else if (state === 'closed') {
          if (this.iceDisconnectTimer) {
            clearTimeout(this.iceDisconnectTimer);
            this.iceDisconnectTimer = null;
          }
        }
      };

      // 3. ICE Connection State monitoring
      this.pc.oniceconnectionstatechange = () => {
        if (this._connectionGeneration !== currentGeneration || !this.pc || this.isTearingDown) return;
        const iceState = this.pc.iceConnectionState;
        this.emit('iceStateChange', iceState);
        this.emit('iceConnectionStateChange', iceState);

        if (iceState === 'connected' || iceState === 'completed') {
          if (this.iceDisconnectTimer) {
            clearTimeout(this.iceDisconnectTimer);
            this.iceDisconnectTimer = null;
          }
          this.iceRestartAttempts = 0;
          this.isRestartingIce = false;
          this.emitDiagnosticsUpdate();
        } else if (iceState === 'disconnected') {
          this._handleTransientDisconnection('ICE connection disconnected');
        } else if (iceState === 'failed') {
          if (this.iceDisconnectTimer) {
            clearTimeout(this.iceDisconnectTimer);
            this.iceDisconnectTimer = null;
          }
          this.attemptIceRestart('ICE connection failed');
        }
      };

      // 4. ICE Gathering State monitoring
      this.pc.onicegatheringstatechange = () => {
        if (this._connectionGeneration !== currentGeneration || !this.pc || this.isTearingDown) return;
        const gatheringState = this.pc.iceGatheringState;
        this.emit('iceGatheringStateChange', gatheringState);
      };

      // 5. Designate channel initiator: Host creates both data channels; Guest listens
      if (this.role === 'host') {
        // Chat Channel
        this.chatChannel = this.pc.createDataChannel('pairport-chat', {
          ordered: true,
        });
        this.dataChannel = this.chatChannel; // backwards-compatible alias
        this._bindChatChannelEvents(this.chatChannel, currentGeneration);

        // File Channel
        this.fileChannel = this.pc.createDataChannel('pairport-files', {
          ordered: true,
        });
        this._bindFileChannelEvents(this.fileChannel, currentGeneration);

        // Host creates and sends offer
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        signalingClient.sendOffer(this.pc.localDescription);
      } else {
        // Guest handles incoming data channels
        this.pc.ondatachannel = (event) => {
          if (this._connectionGeneration !== currentGeneration || !this.pc || this.isTearingDown) return;
          const channel = event.channel;
          if (channel.label === 'pairport-files') {
            this.fileChannel = channel;
            this._bindFileChannelEvents(this.fileChannel, currentGeneration);
          } else {
            // Default to chat channel ('pairport-chat')
            this.chatChannel = channel;
            this.dataChannel = this.chatChannel;
            this._bindChatChannelEvents(this.chatChannel, currentGeneration);
          }
        };
      }
    } catch (err) {
      if (this._connectionGeneration !== currentGeneration) return;
      this._setConnectionState(PEER_CONNECTION_STATES.FAILED);
      this.emit('error', { code: 'PEER_INIT_FAILED', message: String(err) });
      throw err;
    }
  }

  /**
   * Handle transient network disconnection with a grace period timer.
   * Allows temporary Wi-Fi/cellular network handoffs to recover before triggering restart.
   */
  _handleTransientDisconnection(reason) {
    if (this.iceDisconnectTimer || this.isRestartingIce || this.isTearingDown) return;

    this.emit('transientDisconnect', { reason, gracePeriodMs: 4000 });

    this.iceDisconnectTimer = setTimeout(() => {
      this.iceDisconnectTimer = null;
      if (!this.pc || this.isTearingDown) return;

      const currentIce = this.pc.iceConnectionState;
      const currentConn = this.pc.connectionState;
      if (
        currentIce === 'disconnected' ||
        currentConn === 'disconnected' ||
        currentIce === 'failed' ||
        currentConn === 'failed'
      ) {
        this.attemptIceRestart(reason);
      }
    }, 4000);
  }

  /**
   * Check whether an ICE restart is viable.
   * Under RFC 8831 / WebRTC 1.0, an ICE restart cannot reopen closed RTCDataChannels.
   */
  canAttemptIceRestart() {
    if (this.isTearingDown || !this.pc) return false;
    if (
      this.pc.signalingState === 'closed' ||
      this.pc.connectionState === 'closed' ||
      this.pc.connectionState === 'failed'
    ) {
      return false;
    }
    if (this.chatChannel && this.chatChannel.readyState === 'closed') {
      return false;
    }
    if (this.fileChannel && this.fileChannel.readyState === 'closed') {
      return false;
    }
    return true;
  }

  /**
   * Attempt bounded ICE restart with idempotent protection and retry limits.
   * If retry limit is reached, transitions to terminal failure and cancels in-flight transfers.
   *
   * @param {string} [reason='network disruption'] - Disruption trigger reason
   * @returns {Promise<boolean>} True if ICE restart was initiated, false if ineligible or failed
   */
  async attemptIceRestart(reason = 'network disruption') {
    if (this.isTearingDown || !this.pc) return false;

    // Idempotent guard: do not start concurrent competing restarts
    if (this.isRestartingIce) return false;

    // WebRTC RFC 8831 invariant: Closed DataChannels cannot be reopened by ICE restart
    if (!this.canAttemptIceRestart()) {
      console.warn(`[PairPort] Cannot perform ICE restart (${reason}): connection or channels closed.`);
      return false;
    }

    // Terminal failure check: abort when retries are exhausted
    if (this.iceRestartAttempts >= this.maxIceRestartAttempts) {
      console.warn(`[PairPort] Maximum ICE restart attempts (${this.maxIceRestartAttempts}) exhausted.`);
      this._setConnectionState(PEER_CONNECTION_STATES.FAILED);
      this._failInFlightTransfers('Connection failed: WebRTC reconnection attempts exhausted.');

      this.emit('terminalFailure', {
        reason: 'EXHAUSTED_RETRIES',
        attempts: this.iceRestartAttempts,
        maxAttempts: this.maxIceRestartAttempts,
        message: 'WebRTC connection could not be restored after 3 reconnection attempts.',
      });

      this.emit('error', {
        code: 'ICE_RESTART_EXHAUSTED',
        message: 'WebRTC connection failed. A TURN relay server may be required on restricted networks.',
      });
      return false;
    }

    this.iceRestartAttempts++;
    this.isRestartingIce = true;

    this.emit('reconnecting', {
      attempt: this.iceRestartAttempts,
      maxAttempts: this.maxIceRestartAttempts,
      reason,
    });

    if (this.role === 'host') {
      try {
        if (typeof this.pc.restartIce === 'function') {
          this.pc.restartIce();
        }
        const offer = await this.pc.createOffer({ iceRestart: true });
        await this.pc.setLocalDescription(offer);
        signalingClient.sendOffer(this.pc.localDescription);
        return true;
      } catch (err) {
        console.error('[PairPort] Error generating ICE restart offer:', err);
        this.isRestartingIce = false;
        return false;
      }
    } else {
      // Guest peer emits reconnecting status and awaits host restart offer
      console.log(`[PairPort Guest] ICE restart triggered (attempt ${this.iceRestartAttempts}/${this.maxIceRestartAttempts}). Waiting for host offer.`);
      return true;
    }
  }

  /** Guest receives and handles remote offer */
  async handleRemoteOffer(payload) {
    if (this.isTearingDown) return;

    const { sdp } = payload;
    if (!sdp || sdp.type !== 'offer') return;

    const offerSdpStr = sdp.sdp || '';
    const incomingSessId = extractSdpSessionId(offerSdpStr);
    const incomingSessVersion = extractSdpSessionVersion(offerSdpStr);

    // Guard against duplicate or delayed offers for an already processed version of the same session
    if (
      incomingSessId &&
      this.lastRemoteSdpSessionId === incomingSessId &&
      incomingSessVersion !== null &&
      this.lastRemoteSdpSessionVersion !== null &&
      incomingSessVersion <= this.lastRemoteSdpSessionVersion
    ) {
      console.warn(`[PairPort] Ignoring duplicate or delayed offer (sess-id: ${incomingSessId}, v: ${incomingSessVersion} <= ${this.lastRemoteSdpSessionVersion})`);
      return;
    }

    // Determine whether guest must re-initialize a fresh RTCPeerConnection:
    // 1. If PC does not exist
    // 2. If existing PC is closed or failed
    // 3. If existing DataChannels have closed (cannot be reopened via renegotiation)
    // 4. If offer has a new SDP session ID (host started a fresh peer connection instance)
    const isNewSession = Boolean(incomingSessId && this.lastRemoteSdpSessionId && incomingSessId !== this.lastRemoteSdpSessionId);
    const isPcDead = !this.pc || this.pc.signalingState === 'closed' || this.pc.connectionState === 'closed' || this.pc.connectionState === 'failed';
    const areChannelsDead = Boolean(this.chatChannel && this.chatChannel.readyState === 'closed');

    if (!this.pc || isPcDead || areChannelsDead || isNewSession) {
      console.log(`[PairPort Guest] Re-initializing fresh peer connection for incoming offer (newSession: ${isNewSession}, deadPC: ${isPcDead}, deadChannels: ${areChannelsDead})`);
      await this.startPeerConnection('guest');
    }

    // Guard against duplicate offers in invalid states (unless it is an ICE restart offer)
    if (this.pc.signalingState !== 'stable' && this.pc.signalingState !== 'have-remote-offer') {
      if (this.role === 'host') {
        console.warn(`[PairPort Host] Offer collision: ignoring remote offer while in state ${this.pc.signalingState}`);
        return;
      }
    }

    this.isProcessingDescription = true;
    try {
      const desc = typeof RTCSessionDescription === 'function' ? new RTCSessionDescription(sdp) : sdp;
      await this.pc.setRemoteDescription(desc);
      if (incomingSessId) {
        this.lastRemoteSdpSessionId = incomingSessId;
      }
      if (incomingSessVersion !== null) {
        this.lastRemoteSdpSessionVersion = incomingSessVersion;
      }
      await this._drainPendingCandidates();

      // Generate and send answer
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      signalingClient.sendAnswer(this.pc.localDescription);
      this.isRestartingIce = false;
    } catch (err) {
      console.error('[PairPort] Failed to apply remote offer or create answer:', err);
      this.emit('error', { code: 'OFFER_APPLICATION_FAILED', message: String(err) });
    } finally {
      this.isProcessingDescription = false;
    }
  }

  /** Host receives and handles remote answer */
  async handleRemoteAnswer(payload) {
    if (!this.pc || this.isTearingDown) return;
    if (this.pc.signalingState !== 'have-local-offer') {
      console.warn(`[PairPort] Received answer in unexpected signaling state: ${this.pc.signalingState}`);
      return;
    }

    const { sdp } = payload;
    if (!sdp || sdp.type !== 'answer') return;

    this.isProcessingDescription = true;
    try {
      const desc = typeof RTCSessionDescription === 'function' ? new RTCSessionDescription(sdp) : sdp;
      await this.pc.setRemoteDescription(desc);
      await this._drainPendingCandidates();
      this.isRestartingIce = false;
    } catch (err) {
      console.error('[PairPort] Failed to apply remote answer:', err);
      this.emit('error', { code: 'ANSWER_APPLICATION_FAILED', message: String(err) });
    } finally {
      this.isProcessingDescription = false;
    }
  }

  /** Handle remote ICE candidate trickling with queueing until remote description is ready */
  async handleRemoteCandidate(payload) {
    const candidateData = payload?.candidate;

    // If PC does not exist, remote description is not set, or actively processing description: queue candidate
    if (
      !this.pc ||
      !this.pc.remoteDescription ||
      !this.pc.remoteDescription.type ||
      this.isProcessingDescription ||
      this.pc.signalingState === 'closed'
    ) {
      if (candidateData) {
        if (this.pendingCandidates.length >= this.maxPendingCandidates) {
          console.warn('[PairPort] Pending candidate queue full (max 64), discarding candidate.');
          return;
        }
        this.pendingCandidates.push(candidateData);
      }
      return;
    }

    if (candidateData === null) {
      // End of candidates
      try {
        await this.pc.addIceCandidate(null);
      } catch {
        // Ignore end-of-candidate errors
      }
      return;
    }

    try {
      const cand = typeof RTCIceCandidate === 'function' ? new RTCIceCandidate(candidateData) : candidateData;
      await this.pc.addIceCandidate(cand);
    } catch (err) {
      console.warn('[PairPort] Failed to apply ICE candidate:', err);
    }
  }

  /** Drain all queued ICE candidates safely once remote description is applied */
  async _drainPendingCandidates() {
    if (!this.pc || !this.pc.remoteDescription) return;

    const candidatesToProcess = [...this.pendingCandidates];
    this.pendingCandidates = [];

    for (const cand of candidatesToProcess) {
      if (cand) {
        try {
          const candidateObj = typeof RTCIceCandidate === 'function' ? new RTCIceCandidate(cand) : cand;
          await this.pc.addIceCandidate(candidateObj);
        } catch (err) {
          console.warn('[PairPort] Failed to add queued ICE candidate:', err);
        }
      }
    }
  }

  /**
   * Inspect RTCPeerConnection statistics to detect selected candidate pair and relay status.
   * Strips private IP addresses, candidate IPs, and credentials for user privacy.
   */
  async getConnectionDiagnostics() {
    const diagnostics = {
      connectionState: this.pc ? this.pc.connectionState : this.connectionState,
      iceConnectionState: this.pc ? this.pc.iceConnectionState : 'idle',
      iceGatheringState: this.pc ? this.pc.iceGatheringState : 'idle',
      signalingState: this.pc ? this.pc.signalingState : 'idle',
      selectedCandidateType: 'unknown', // 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown'
      isRelay: false,
      candidatePairState: null,
      roundTripTimeMs: null,
      bytesSent: 0,
      bytesReceived: 0,
      reconnectAttempts: this.iceRestartAttempts,
      maxReconnectAttempts: this.maxIceRestartAttempts,
      hasTurnConfigured: Boolean(APP_CONFIG.iceConfig?.isTurnConfigured),
      chatReady: this.isChatReady(),
      fileReady: this.isFileChannelReady(),
    };

    if (!this.pc || typeof this.pc.getStats !== 'function') {
      return diagnostics;
    }

    try {
      const stats = await this.pc.getStats();
      let selectedPair = null;
      const candidates = new Map();

      stats.forEach((report) => {
        if (report.type === 'candidate-pair') {
          if (report.selected || report.nominated || report.state === 'succeeded') {
            selectedPair = report;
          }
        } else if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
          candidates.set(report.id, report);
        }
      });

      // Fallback: check transport report for selectedCandidatePairId
      if (!selectedPair) {
        stats.forEach((report) => {
          if (report.type === 'transport' && report.selectedCandidatePairId) {
            selectedPair = stats.get(report.selectedCandidatePairId);
          }
        });
      }

      if (selectedPair) {
        diagnostics.candidatePairState = selectedPair.state || 'succeeded';
        if (typeof selectedPair.currentRoundTripTime === 'number') {
          diagnostics.roundTripTimeMs = Math.round(selectedPair.currentRoundTripTime * 1000);
        }
        diagnostics.bytesSent = selectedPair.bytesSent || 0;
        diagnostics.bytesReceived = selectedPair.bytesReceived || 0;

        const localCand = candidates.get(selectedPair.localCandidateId);
        const remoteCand = candidates.get(selectedPair.remoteCandidateId);

        const localType = localCand?.candidateType;
        const remoteType = remoteCand?.candidateType;

        if (localType === 'relay' || remoteType === 'relay') {
          diagnostics.isRelay = true;
          diagnostics.selectedCandidateType = 'relay';
        } else if (localType === 'srflx' || remoteType === 'srflx') {
          diagnostics.selectedCandidateType = 'srflx';
        } else if (localType === 'host' && remoteType === 'host') {
          diagnostics.selectedCandidateType = 'host';
        } else if (localType) {
          diagnostics.selectedCandidateType = localType;
        }
      }
    } catch (err) {
      console.warn('[PairPort] Error querying peer connection stats:', err);
    }

    return diagnostics;
  }

  /** Emit connection diagnostics update to active listeners */
  async emitDiagnosticsUpdate() {
    try {
      const diag = await this.getConnectionDiagnostics();
      this.emit('diagnosticsUpdate', diag);
    } catch {}
  }

  // ==========================================
  // CHAT DATACHANNEL METHODS
  // ==========================================

  _bindChatChannelEvents(channel, generation = this._connectionGeneration) {
    this._setDataChannelState(DATA_CHANNEL_STATES.CONNECTING);

    channel.onopen = () => {
      if (this._connectionGeneration !== generation) return;
      this._setDataChannelState(DATA_CHANNEL_STATES.OPEN);
      this.emit('dataChannelOpen');
    };

    channel.onclose = () => {
      if (this._connectionGeneration !== generation) return;
      this._setDataChannelState(DATA_CHANNEL_STATES.CLOSED);
      this.emit('dataChannelClose');
    };

    channel.onerror = (err) => {
      if (this._connectionGeneration !== generation) return;
      console.warn('WebRTC Chat DataChannel error:', err);
      this.emit('error', { code: 'DATA_CHANNEL_ERROR', message: 'Chat DataChannel error occurred.' });
    };

    channel.onmessage = (event) => {
      if (this._connectionGeneration !== generation) return;
      this._handleChatChannelMessage(event.data);
    };
  }

  /**
   * Send a chat message over the direct WebRTC DataChannel.
   * NEVER routes through FastAPI or any server.
   */
  sendChatMessage(text) {
    const channel = this.chatChannel || this.dataChannel;
    if (!channel || channel.readyState !== 'open') {
      throw new Error('WebRTC DataChannel is not open. Direct connection must be established to send chat.');
    }

    if (!text || typeof text !== 'string' || !text.trim()) {
      throw new Error('Message text cannot be empty.');
    }

    const trimmedText = text.trim().slice(0, 1000);
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const messagePayload = {
      type: 'chat',
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text: trimmedText,
      timestamp: timeStr,
    };

    channel.send(JSON.stringify(messagePayload));

    return {
      id: messagePayload.id,
      sender: 'user',
      senderName: 'You',
      text: trimmedText,
      timestamp: timeStr,
      isReal: true,
    };
  }

  _handleChatChannelMessage(rawData) {
    try {
      const data = JSON.parse(rawData);
      if (data && data.type === 'chat') {
        const text = String(data.text || '').slice(0, 1000);
        const timestamp = String(data.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })).slice(0, 30);
        const senderName = String(data.senderName || 'Peer').slice(0, 50);
        const id = String(data.id || `msg-${Date.now()}`).slice(0, 64);

        this.emit('chatMessage', {
          id,
          sender: 'peer',
          senderName,
          text,
          timestamp,
          isReal: true,
        });
      } else if (data && typeof data.type === 'string' && data.type.startsWith('file-')) {
        // Fallback: file control message sent over chat channel
        this._handleFileControlMessage(data);
      }
    } catch (err) {
      console.warn('Failed to parse WebRTC DataChannel message:', err);
    }
  }

  // ==========================================
  // FILE DATACHANNEL METHODS (PHASE 5)
  // ==========================================

  _bindFileChannelEvents(channel, generation = this._connectionGeneration) {
    channel.binaryType = 'arraybuffer';
    // Backpressure threshold configuration
    channel.bufferedAmountLowThreshold = this.bufferedAmountLowThreshold;
    this._setFileChannelState(DATA_CHANNEL_STATES.CONNECTING);

    channel.onopen = () => {
      if (this._connectionGeneration !== generation) return;
      this._setFileChannelState(DATA_CHANNEL_STATES.OPEN);
      this.emit('fileChannelOpen');
    };

    channel.onclose = () => {
      if (this._connectionGeneration !== generation) return;
      this._setFileChannelState(DATA_CHANNEL_STATES.CLOSED);
      this.emit('fileChannelClose');
      this._failInFlightTransfers('Connection closed while file transfer was in progress.');
    };

    channel.onerror = (err) => {
      if (this._connectionGeneration !== generation) return;
      console.warn('WebRTC File DataChannel error:', err);
      this.emit('error', { code: 'FILE_CHANNEL_ERROR', message: 'File DataChannel error occurred.' });
    };

    channel.onmessage = (event) => {
      if (this._connectionGeneration !== generation) return;
      this._handleFileChannelMessage(event.data);
    };
  }

  _handleFileChannelMessage(data) {
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        this._handleFileControlMessage(msg);
      } catch (err) {
        console.warn('Failed to parse file control message:', err);
      }
    } else if (data instanceof ArrayBuffer) {
      this._handleFileChunk(data);
    }
  }

  _handleFileControlMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'file-start') {
      this._handleFileStart(msg);
    } else if (msg.type === 'file-complete') {
      this._handleFileComplete(msg);
    } else if (msg.type === 'file-cancel') {
      this._handleFileCancel(msg);
    }
  }

  /**
   * Initiate sending a file directly to the peer over the WebRTC file channel.
   * Validates size, prepares chunks, applies backpressure, and sends completion message.
   */
  async sendFile(file) {
    const channel = this.fileChannel || this.chatChannel;
    if (!channel || channel.readyState !== 'open') {
      throw new Error('WebRTC file channel is not open. Direct connection must be established first.');
    }

    if (!file || typeof file.size !== 'number') {
      throw new Error('Invalid file provided.');
    }

    if (file.size > this.maxFileSizeBytes) {
      const maxMb = (this.maxFileSizeBytes / (1024 * 1024)).toFixed(0);
      const fileMb = (file.size / (1024 * 1024)).toFixed(1);
      throw new Error(`File "${file.name}" (${fileMb} MB) exceeds maximum allowed limit of ${maxMb} MB.`);
    }

    const transferId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sanitizedName = sanitizeFilename(file.name);
    const chunkSize = this.chunkSizeBytes;
    const totalChunks = Math.ceil(file.size / chunkSize) || 1;

    const transfer = {
      id: transferId,
      name: sanitizedName,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      direction: 'outgoing',
      status: TRANSFER_STATES.WAITING,
      progress: 0,
      transferredBytes: 0,
      totalBytes: file.size,
      totalChunks,
      chunkSize,
      file,
      isCancelled: false,
      startTime: Date.now(),
      blobUrl: null,
    };

    this.activeTransfers.set(transferId, transfer);
    this.emit('fileTransferStart', { ...transfer });

    // Begin asynchronous streaming loop
    this._streamFile(transferId);
    return transferId;
  }

  async _streamFile(transferId) {
    const transfer = this.activeTransfers.get(transferId);
    const channel = this.fileChannel || this.chatChannel;
    if (!transfer || !channel || channel.readyState !== 'open') return;

    transfer.status = TRANSFER_STATES.SENDING;
    this.emit('fileTransferProgress', { ...transfer });

    // 1. Send file-start metadata message
    const metaMessage = {
      type: 'file-start',
      transferId: transfer.id,
      name: transfer.name,
      size: transfer.size,
      mimeType: transfer.mimeType,
      totalChunks: transfer.totalChunks,
      chunkSize: transfer.chunkSize,
    };

    try {
      channel.send(JSON.stringify(metaMessage));
    } catch (err) {
      transfer.status = TRANSFER_STATES.FAILED;
      transfer.error = `Failed to send metadata: ${err.message}`;
      this.emit('fileTransferFailed', { ...transfer, error: transfer.error });
      return;
    }

    // 2. Stream chunks sequentially with backpressure
    const file = transfer.file;
    const chunkSize = transfer.chunkSize;
    let offset = 0;
    let chunkIndex = 0;

    while (offset < file.size || (file.size === 0 && chunkIndex === 0)) {
      if (transfer.isCancelled || channel.readyState !== 'open') {
        if (!transfer.isCancelled) {
          transfer.status = TRANSFER_STATES.FAILED;
          transfer.error = 'Channel closed during transfer.';
          this.emit('fileTransferFailed', { ...transfer, error: transfer.error });
        }
        return;
      }

      // Read slice
      const slice = file.slice(offset, offset + chunkSize);
      let chunkBuffer;
      try {
        chunkBuffer = await slice.arrayBuffer();
      } catch (readErr) {
        transfer.status = TRANSFER_STATES.FAILED;
        transfer.error = 'Failed to read file chunk from disk.';
        this.emit('fileTransferFailed', { ...transfer, error: transfer.error });
        return;
      }

      // Pack binary packet (36-byte header + payload)
      const packet = packChunk(transfer.id, chunkIndex, chunkBuffer);

      // Backpressure: check bufferedAmount
      if (channel.bufferedAmount > this.bufferedAmountHighWatermark) {
        await new Promise((resolve) => {
          const onLow = () => {
            channel.removeEventListener('bufferedamountlow', onLow);
            resolve();
          };
          channel.addEventListener('bufferedamountlow', onLow);
        });
      }

      if (transfer.isCancelled || channel.readyState !== 'open') return;

      try {
        channel.send(packet);
      } catch (sendErr) {
        transfer.status = TRANSFER_STATES.FAILED;
        transfer.error = `Send failed: ${sendErr.message}`;
        this.emit('fileTransferFailed', { ...transfer, error: transfer.error });
        return;
      }

      offset += chunkBuffer.byteLength;
      chunkIndex += 1;
      transfer.transferredBytes = offset;
      transfer.progress = transfer.size === 0 ? 100 : Math.min(100, Math.round((offset / transfer.size) * 100));

      this.emit('fileTransferProgress', { ...transfer });

      if (file.size === 0) break;
    }

    // 3. Send file-complete message
    const completeMessage = {
      type: 'file-complete',
      transferId: transfer.id,
      totalBytes: transfer.transferredBytes,
      totalChunks: chunkIndex,
    };

    try {
      channel.send(JSON.stringify(completeMessage));
      transfer.status = TRANSFER_STATES.COMPLETED;
      transfer.progress = 100;
      this.emit('fileTransferComplete', { ...transfer });
    } catch (err) {
      transfer.status = TRANSFER_STATES.FAILED;
      transfer.error = err.message;
      this.emit('fileTransferFailed', { ...transfer, error: err.message });
    }
  }

  _handleFileStart(msg) {
    if (!msg || typeof msg !== 'object') return;
    const { transferId, name, size, mimeType, totalChunks, chunkSize } = msg;

    // Validate transferId format
    if (!transferId || typeof transferId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(transferId)) {
      console.warn('Rejected invalid file-start transferId:', transferId);
      return;
    }

    // Validate file size bounds
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
      console.warn('Rejected invalid file-start message with bad size:', msg);
      return;
    }

    if (size > this.maxFileSizeBytes) {
      console.warn(`Incoming file exceeds maximum allowed size: ${size} > ${this.maxFileSizeBytes}`);
      this.cancelTransfer(transferId, 'Incoming file exceeds maximum size limit.');
      return;
    }

    // Enforce concurrent incoming transfer limit (max 3 concurrent)
    const activeIncomingCount = Array.from(this.activeTransfers.values()).filter(
      (t) => t.direction === 'incoming' && t.status === TRANSFER_STATES.RECEIVING
    ).length;
    if (activeIncomingCount >= 3) {
      console.warn('Rejected incoming transfer: maximum concurrent incoming transfers (3) reached.');
      this.cancelTransfer(transferId, 'Maximum concurrent incoming transfers reached.');
      return;
    }

    // Validate chunk size bounds (16 bytes to 64 KB)
    const validChunkSize = (typeof chunkSize === 'number' && Number.isInteger(chunkSize) && chunkSize >= 16 && chunkSize <= 65536)
      ? chunkSize
      : this.chunkSizeBytes;

    // Validate totalChunks consistency
    const expectedChunks = size === 0 ? 1 : Math.ceil(size / validChunkSize);
    const maxAllowedChunks = Math.ceil(this.maxFileSizeBytes / 1024);
    if (typeof totalChunks === 'number' && (totalChunks !== expectedChunks || totalChunks > maxAllowedChunks || totalChunks < 1)) {
      console.warn(`Rejected file transfer: invalid totalChunks ${totalChunks} (expected ${expectedChunks}).`);
      this.cancelTransfer(transferId, 'Invalid chunk count declared.');
      return;
    }

    const sanitizedName = sanitizeFilename(name);
    const transfer = {
      id: transferId,
      name: sanitizedName,
      size,
      mimeType: mimeType || 'application/octet-stream',
      direction: 'incoming',
      status: TRANSFER_STATES.RECEIVING,
      progress: 0,
      transferredBytes: 0,
      totalBytes: size,
      totalChunks: typeof totalChunks === 'number' ? totalChunks : expectedChunks,
      chunkSize: validChunkSize,
      receivedChunks: [],
      receivedIndices: new Set(),
      blobUrl: null,
      startTime: Date.now(),
    };

    this.activeTransfers.set(transferId, transfer);
    this.emit('fileTransferStart', { ...transfer });
  }

  _handleFileChunk(buffer) {
    let unpacked;
    try {
      unpacked = unpackChunk(buffer);
    } catch (err) {
      console.warn('Failed to unpack chunk frame:', err);
      return;
    }

    const { transferId, chunkIndex, payload } = unpacked;
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer || transfer.status !== TRANSFER_STATES.RECEIVING) {
      return;
    }

    // Guard against oversized payload frame
    if (payload.byteLength > transfer.chunkSize * 2) {
      console.warn('Received chunk payload exceeds allowed size limit. Failing transfer.');
      transfer.status = TRANSFER_STATES.FAILED;
      transfer.error = 'Received chunk payload exceeds allowed size limit.';
      this.emit('fileTransferFailed', { ...transfer, error: transfer.error });
      return;
    }

    // Guard against duplicate chunks
    if (transfer.receivedIndices.has(chunkIndex)) {
      return;
    }

    // Guard against chunk index out of bounds
    if (chunkIndex >= transfer.totalChunks) {
      console.warn(`Chunk index out of bounds: ${chunkIndex} >= ${transfer.totalChunks}`);
      return;
    }

    // Guard against bytes exceeding expected size
    if (transfer.transferredBytes + payload.byteLength > transfer.size) {
      console.warn('Received chunk exceeds total expected file size. Failing transfer.');
      transfer.status = TRANSFER_STATES.FAILED;
      transfer.error = 'Received bytes exceed declared file size.';
      this.emit('fileTransferFailed', { ...transfer, error: transfer.error });
      return;
    }

    transfer.receivedChunks[chunkIndex] = payload;
    transfer.receivedIndices.add(chunkIndex);
    transfer.transferredBytes += payload.byteLength;
    // Cap progress at 99% until file-complete verification passes
    transfer.progress = transfer.size === 0 ? 100 : Math.min(99, Math.round((transfer.transferredBytes / transfer.size) * 100));

    this.emit('fileTransferProgress', { ...transfer });
  }

  _handleFileComplete(msg) {
    const transfer = this.activeTransfers.get(msg.transferId);
    if (!transfer || transfer.status !== TRANSFER_STATES.RECEIVING) return;

    // Strict integrity verification
    const isChunksComplete = transfer.receivedIndices.size === transfer.totalChunks;
    const isBytesComplete = transfer.transferredBytes === transfer.size;

    if (!isChunksComplete || !isBytesComplete) {
      transfer.status = TRANSFER_STATES.FAILED;
      transfer.error = `Integrity verification failed: expected ${transfer.size} bytes across ${transfer.totalChunks} chunks, received ${transfer.transferredBytes} bytes across ${transfer.receivedIndices.size} chunks.`;
      this.emit('fileTransferFailed', { ...transfer, error: transfer.error });
      return;
    }

    // Assemble file Blob and generate local download URL
    try {
      const blob = new Blob(transfer.receivedChunks, { type: transfer.mimeType || 'application/octet-stream' });
      transfer.blobUrl = URL.createObjectURL(blob);
      transfer.status = TRANSFER_STATES.COMPLETED;
      transfer.progress = 100;
      // Free individual chunk byte arrays from memory
      transfer.receivedChunks = null;
      this.emit('fileTransferComplete', { ...transfer });
    } catch (err) {
      transfer.status = TRANSFER_STATES.FAILED;
      transfer.error = `Failed to create Blob: ${err.message}`;
      this.emit('fileTransferFailed', { ...transfer, error: transfer.error });
    }
  }

  _handleFileCancel(msg) {
    const transfer = this.activeTransfers.get(msg.transferId);
    if (!transfer) return;

    transfer.status = TRANSFER_STATES.CANCELLED;
    transfer.isCancelled = true;
    transfer.receivedChunks = null;
    this.emit('fileTransferCancelled', { ...transfer, reason: msg.reason || 'Cancelled by peer' });
  }

  /**
   * Cancel an active file transfer. Dispatches a file-cancel control message to peer.
   */
  cancelTransfer(transferId, reason = 'Cancelled by user') {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) return;

    transfer.isCancelled = true;
    transfer.status = TRANSFER_STATES.CANCELLED;
    transfer.receivedChunks = null;

    if (transfer.blobUrl) {
      try {
        URL.revokeObjectURL(transfer.blobUrl);
      } catch {}
      transfer.blobUrl = null;
    }

    const channel = this.fileChannel || this.chatChannel;
    if (channel && channel.readyState === 'open') {
      try {
        channel.send(
          JSON.stringify({
            type: 'file-cancel',
            transferId,
            reason,
          })
        );
      } catch {}
    }

    this.emit('fileTransferCancelled', { ...transfer, reason });
  }

  _failInFlightTransfers(errorMessage) {
    this.activeTransfers.forEach((transfer) => {
      if (transfer.status === TRANSFER_STATES.SENDING || transfer.status === TRANSFER_STATES.RECEIVING || transfer.status === TRANSFER_STATES.WAITING) {
        transfer.status = TRANSFER_STATES.FAILED;
        transfer.error = errorMessage;
        this.emit('fileTransferFailed', { ...transfer, error: errorMessage });
      }
    });
  }

  getActiveTransfers() {
    return Array.from(this.activeTransfers.values());
  }

  getTransfer(transferId) {
    return this.activeTransfers.get(transferId) || null;
  }

  revokeBlobUrl(transferId) {
    const transfer = this.activeTransfers.get(transferId);
    if (transfer && transfer.blobUrl) {
      try {
        URL.revokeObjectURL(transfer.blobUrl);
      } catch {}
      transfer.blobUrl = null;
    }
  }

  // ==========================================
  // STATE MANAGEMENT & TEARDOWN
  // ==========================================

  _setConnectionState(newState) {
    this.connectionState = newState;
    this.emit('connectionStateChange', newState);
  }

  _setDataChannelState(newState) {
    this.dataChannelState = newState;
    this.emit('dataChannelStateChange', newState);
  }

  _setFileChannelState(newState) {
    this.fileChannelState = newState;
    this.emit('fileChannelStateChange', newState);
  }

  isChatReady() {
    const channel = this.chatChannel || this.dataChannel;
    if (!channel || channel.readyState !== 'open') return false;
    if (
      this.connectionState === PEER_CONNECTION_STATES.FAILED ||
      this.connectionState === PEER_CONNECTION_STATES.CLOSED
    ) {
      return false;
    }
    return true;
  }

  isFileChannelReady() {
    const channel = this.fileChannel || this.chatChannel;
    if (!channel || channel.readyState !== 'open') return false;
    if (
      this.connectionState === PEER_CONNECTION_STATES.FAILED ||
      this.connectionState === PEER_CONNECTION_STATES.CLOSED
    ) {
      return false;
    }
    return true;
  }

  /** Close the WebRTC PeerConnection and DataChannels cleanly */
  close() {
    this.isTearingDown = true;
    this._connectionGeneration = (this._connectionGeneration || 0) + 1;
    this.lastRemoteSdpSessionId = null;
    this.lastRemoteSdpSessionVersion = null;

    // Clear any pending ICE disconnection timers
    if (this.iceDisconnectTimer) {
      clearTimeout(this.iceDisconnectTimer);
      this.iceDisconnectTimer = null;
    }
    this.iceRestartAttempts = 0;
    this.isRestartingIce = false;
    this.isProcessingDescription = false;

    // Clean up active transfers and revoke all temporary Blob URLs to prevent memory leaks
    if (this.activeTransfers) {
      this.activeTransfers.forEach((transfer) => {
        if (transfer.blobUrl) {
          try {
            URL.revokeObjectURL(transfer.blobUrl);
          } catch {}
          transfer.blobUrl = null;
        }
        if (
          transfer.status === TRANSFER_STATES.SENDING ||
          transfer.status === TRANSFER_STATES.RECEIVING ||
          transfer.status === TRANSFER_STATES.WAITING
        ) {
          transfer.status = TRANSFER_STATES.FAILED;
          transfer.error = 'Peer connection closed.';
        }
      });
      this.activeTransfers.clear();
    }

    if (this.fileChannel) {
      try {
        this.fileChannel.close();
      } catch {}
      this.fileChannel = null;
    }

    if (this.chatChannel) {
      try {
        this.chatChannel.close();
      } catch {}
      this.chatChannel = null;
    }
    this.dataChannel = null;

    if (this.pc) {
      try {
        this.pc.close();
      } catch {}
      this.pc = null;
    }

    this.pendingCandidates = [];
    this.role = null;

    if (this.connectionState !== PEER_CONNECTION_STATES.IDLE) {
      this._setConnectionState(PEER_CONNECTION_STATES.IDLE);
    }
    if (this.dataChannelState !== DATA_CHANNEL_STATES.IDLE) {
      this._setDataChannelState(DATA_CHANNEL_STATES.IDLE);
    }
    if (this.fileChannelState !== DATA_CHANNEL_STATES.IDLE) {
      this._setFileChannelState(DATA_CHANNEL_STATES.IDLE);
    }
  }

  /** Alias for close() for connection cleanup */
  closeConnection() {
    this.close();
  }
}

export const peerConnectionService = new PeerConnectionService();
