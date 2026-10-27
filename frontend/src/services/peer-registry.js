/**
 * PairPort Multi-Peer Connection Registry & Mesh Manager (Phase 2A)
 *
 * Coordinates a full mesh WebRTC topology for up to 4 devices (up to 3 remote peer connections per device).
 * Manages one independent RTCPeerConnection per remote participant with:
 * - Targeted signaling routing using target_session_id and sender_session_id
 * - Deterministic negotiation initiator selection (polite/impolite role determination)
 * - Independent connection state, ICE recovery, DataChannels, and file streaming per peer
 * - Dynamic roster synchronization, peer arrivals, disconnections, reconnects, and departures
 * - Unified event forwarding for chat messages and file transfers preserving single-peer compatibility
 */

import { signalingClient, SIGNALING_STATES } from './signaling.js';
import {
  PeerConnectionService,
  PEER_CONNECTION_STATES,
  DATA_CHANNEL_STATES,
  DEFAULT_ICE_SERVERS,
} from './peer-connection.js';
import { APP_CONFIG } from '../config/app-config.js';

export const MAX_MESH_REMOTE_PEERS = 3; // 4 devices total (1 local + up to 3 remote)

export class PeerRegistry {
  constructor(options = {}) {
    this.iceServers = options.iceServers || APP_CONFIG.iceServers || DEFAULT_ICE_SERVERS;
    this.signaling = options.signaling || signalingClient;
    this.maxRemotePeers = options.maxRemotePeers || MAX_MESH_REMOTE_PEERS;

    this.peers = new Map(); // remoteSessionId -> PeerConnectionService
    this.mySessionId = null;
    this.myRole = null;
    this.roomCode = null;
    this.latestRoster = [];

    this.listeners = new Map();
    this._signalingUnsubs = [];

    // Aggregated states
    this.connectionState = PEER_CONNECTION_STATES.IDLE;
    this.dataChannelState = DATA_CHANNEL_STATES.IDLE;
    this.fileChannelState = DATA_CHANNEL_STATES.IDLE;

    // Retry tracking for connection controller compatibility
    this.maxIceRestartAttempts = 3;
    this.iceRestartAttempts = 0;

    if (options.autoBindSignaling !== false) {
      this._bindSignaling();
    }
  }

  setMySessionId(sessionId, role = null) {
    this.mySessionId = sessionId;
    if (role) {
      this.myRole = role;
    }
  }

  // ----------------------------------------------------
  // Event Emitter Support
  // ----------------------------------------------------

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
          console.error(`PeerRegistry listener error for '${event}':`, err);
        }
      });
    }
  }

  // ----------------------------------------------------
  // Deterministic Role / Initiator Negotiation
  // ----------------------------------------------------

  /**
   * Determine whether local device should initiate the WebRTC offer to remoteSessionId.
   * Host always initiates to guests.
   * Between peers with the same role (e.g. guest vs guest), lexicographical comparison breaks ties.
   * Exactly one device evaluates to true; the other evaluates to false.
   *
   * @param {string} remoteSessionId - Candidate remote session ID
   * @param {string} [remoteRole='guest'] - Remote peer role ('host' | 'guest')
   * @returns {boolean} True if this local peer should create and send the offer
   */
  shouldInitiate(remoteSessionId, remoteRole = 'guest') {
    if (!this.mySessionId || !remoteSessionId) return false;

    // Host always initiates to guests
    if (this.myRole === 'host' && remoteRole !== 'host') {
      return true;
    }
    if (remoteRole === 'host' && this.myRole !== 'host') {
      return false;
    }

    // Symmetric role tie-break: strictly asymmetric string comparison
    return String(this.mySessionId) < String(remoteSessionId);
  }

  // ----------------------------------------------------
  // Peer Collection Queries
  // ----------------------------------------------------

  getPeer(remoteSessionId) {
    return this.peers.get(remoteSessionId);
  }

  hasPeer(remoteSessionId) {
    return this.peers.has(remoteSessionId);
  }

  getPeers() {
    return Array.from(this.peers.values());
  }

  getPeerIds() {
    return Array.from(this.peers.keys());
  }

  getPeerCount() {
    return this.peers.size;
  }

  getActivePeers() {
    return this.getPeers().filter(
      (p) => p.connectionState === PEER_CONNECTION_STATES.CONNECTED || p.isChatReady()
    );
  }

  _getSinglePeerId() {
    const ids = Array.from(this.peers.keys());
    return ids.length === 1 ? ids[0] : null;
  }

  getRoster() {
    if (this.latestRoster && this.latestRoster.length > 0) {
      return [...this.latestRoster];
    }
    const list = [];
    if (this.mySessionId) {
      list.push({ session_id: this.mySessionId, role: this.myRole || 'guest', status: 'connected' });
    }
    this.peers.forEach((peer, id) => {
      list.push({
        session_id: id,
        role: peer.role || 'guest',
        status: peer.connectionState === 'closed' ? 'disconnected' : 'connected',
      });
    });
    return list;
  }

  _findParticipantRole(participants, sessionId) {
    if (!Array.isArray(participants)) return 'guest';
    const found = participants.find((p) => p.session_id === sessionId);
    return found?.role || 'guest';
  }

  // ----------------------------------------------------
  // Peer Lifecycle Management
  // ----------------------------------------------------

  /**
   * Create or return an existing PeerConnectionService instance for a remote session ID.
   * Enforces the 3-remote-peer mesh capacity limit.
   */
  createPeer(remoteSessionId, remoteRole = 'guest') {
    if (!remoteSessionId || typeof remoteSessionId !== 'string') {
      throw new Error('A valid remoteSessionId is required to create a peer connection.');
    }

    if (this.peers.has(remoteSessionId)) {
      return this.peers.get(remoteSessionId);
    }

    if (this.peers.size >= this.maxRemotePeers) {
      console.warn(
        `[PeerRegistry] Maximum remote peers (${this.maxRemotePeers}) reached. Rejecting connection to ${remoteSessionId}`
      );
      throw new Error(`Maximum peer capacity (${this.maxRemotePeers}) reached in room.`);
    }

    const peerService = new PeerConnectionService(this.iceServers, {
      remoteSessionId,
      signaling: this.signaling,
      autoBindSignaling: false, // Registry controls signal dispatching
    });

    // Wire per-peer event forwards
    peerService.on('connectionStateChange', (state) => {
      this._handlePeerStateChange(remoteSessionId, 'connectionState', state);
      this.emit('peerConnectionStateChange', { peerSessionId: remoteSessionId, state });
    });

    peerService.on('dataChannelStateChange', (state) => {
      this._handlePeerStateChange(remoteSessionId, 'dataChannelState', state);
      this.emit('peerDataChannelStateChange', { peerSessionId: remoteSessionId, state });
    });

    peerService.on('fileChannelStateChange', (state) => {
      this._handlePeerStateChange(remoteSessionId, 'fileChannelState', state);
    });

    peerService.on('fileChannelOpen', () => {
      this.emit('fileChannelOpen');
    });

    peerService.on('fileChannelClose', () => {
      this.emit('fileChannelClose');
    });

    peerService.on('dataChannelOpen', () => {
      this.emit('dataChannelOpen');
    });

    peerService.on('dataChannelClose', () => {
      this.emit('dataChannelClose');
    });

    peerService.on('iceStateChange', (state) => {
      this.emit('peerIceStateChange', { peerSessionId: remoteSessionId, state });
      this.emit('iceStateChange', state);
    });

    peerService.on('iceConnectionStateChange', (state) => {
      this.emit('iceConnectionStateChange', state);
    });

    peerService.on('iceGatheringStateChange', (state) => {
      this.emit('iceGatheringStateChange', state);
    });

    peerService.on('reconnecting', (info) => {
      this.emit('reconnecting', info);
    });

    peerService.on('terminalFailure', (info) => {
      this.emit('terminalFailure', info);
    });

    peerService.on('chatMessage', (msg) => {
      this.emit('peerActivity', { peerSessionId: remoteSessionId, type: 'chat', direction: 'in' });
      this.emit('chatMessage', {
        ...msg,
        senderSessionId: remoteSessionId,
      });
    });

    peerService.on('fileTransferStart', (transfer) => {
      this.emit('peerActivity', {
        peerSessionId: remoteSessionId,
        type: 'file',
        direction: transfer.direction || 'in',
      });
      this.emit('fileTransferStart', { ...transfer, peerSessionId: remoteSessionId });
    });

    peerService.on('fileTransferProgress', (transfer) => {
      this.emit('fileTransferProgress', { ...transfer, peerSessionId: remoteSessionId });
    });

    peerService.on('fileTransferComplete', (transfer) => {
      this.emit('fileTransferComplete', { ...transfer, peerSessionId: remoteSessionId });
    });

    peerService.on('fileTransferFailed', (err) => {
      this.emit('fileTransferFailed', { ...err, peerSessionId: remoteSessionId });
      this.emit('fileTransferError', { ...err, peerSessionId: remoteSessionId });
    });

    peerService.on('fileTransferError', (err) => {
      this.emit('fileTransferFailed', { ...err, peerSessionId: remoteSessionId });
      this.emit('fileTransferError', { ...err, peerSessionId: remoteSessionId });
    });

    peerService.on('fileTransferCancelled', (c) => {
      this.emit('fileTransferCancelled', { ...c, peerSessionId: remoteSessionId });
    });

    peerService.on('diagnosticsUpdate', (d) => {
      this.emit('diagnosticsUpdate', d);
    });

    peerService.on('error', (err) => {
      this.emit('peerError', { peerSessionId: remoteSessionId, error: err });
    });

    this.peers.set(remoteSessionId, peerService);
    this.emit('peerAdded', { peerSessionId: remoteSessionId, peer: peerService });
    this._updateAggregatedStates();

    return peerService;
  }

  /**
   * Close and remove a remote peer from the registry.
   */
  removePeer(remoteSessionId, reason = 'left') {
    const peer = this.peers.get(remoteSessionId);
    if (!peer) return false;

    try {
      peer.close();
    } catch (err) {
      console.warn(`[PeerRegistry] Error closing peer ${remoteSessionId}:`, err);
    }

    this.peers.delete(remoteSessionId);
    this.emit('peerRemoved', { peerSessionId: remoteSessionId, reason });
    this._updateAggregatedStates();
    return true;
  }

  /**
   * Close all active peer connections cleanly and reset registry session context.
   */
  closeAll() {
    this.peers.forEach((peer, id) => {
      try {
        peer.close();
      } catch (err) {
        console.warn(`[PeerRegistry] Error closing peer ${id}:`, err);
      }
    });
    this.peers.clear();
    this.mySessionId = null;
    this.myRole = null;
    this.roomCode = null;
    this.latestRoster = [];
    this._updateAggregatedStates();
  }

  /** Alias for closeAll() to match PeerConnectionService interface */
  close() {
    this.closeAll();
  }

  // ----------------------------------------------------
  // Signaling Bindings and Targeted Signal Routing
  // ----------------------------------------------------

  unbindSignaling() {
    if (this._signalingUnsubs && this._signalingUnsubs.length > 0) {
      this._signalingUnsubs.forEach((unsub) => {
        try { unsub(); } catch {}
      });
      this._signalingUnsubs = [];
    }
  }

  _bindSignaling() {
    this.unbindSignaling();

    const unsubOffer = this.signaling.on('signalOffer', async (payload) => {
      try {
        await this.handleSignalOffer(payload);
      } catch (err) {
        console.error('[PeerRegistry] Error handling offer:', err);
      }
    });
    this._signalingUnsubs.push(unsubOffer);

    const unsubAnswer = this.signaling.on('signalAnswer', async (payload) => {
      try {
        await this.handleSignalAnswer(payload);
      } catch (err) {
        console.error('[PeerRegistry] Error handling answer:', err);
      }
    });
    this._signalingUnsubs.push(unsubAnswer);

    const unsubCandidate = this.signaling.on('signalCandidate', async (payload) => {
      try {
        await this.handleSignalCandidate(payload);
      } catch (err) {
        console.warn('[PeerRegistry] Error handling candidate:', err);
      }
    });
    this._signalingUnsubs.push(unsubCandidate);
  }

  async handleSignalOffer(payload) {
    const senderId = payload?.sender_session_id;
    const targetId = payload?.target_session_id;

    // Discard signals explicitly intended for a different peer
    if (targetId && this.mySessionId && targetId !== this.mySessionId) {
      return;
    }

    const effectiveId = senderId || this._getSinglePeerId() || 'legacy-peer';
    let peer = this.peers.get(effectiveId);
    if (!peer) {
      peer = this.createPeer(effectiveId, 'guest');
    }

    await peer.handleRemoteOffer(payload);
  }

  async handleSignalAnswer(payload) {
    const senderId = payload?.sender_session_id;
    const targetId = payload?.target_session_id;

    if (targetId && this.mySessionId && targetId !== this.mySessionId) {
      return;
    }

    const effectiveId = senderId || this._getSinglePeerId();
    if (!effectiveId) return;

    const peer = this.peers.get(effectiveId);
    if (peer) {
      await peer.handleRemoteAnswer(payload);
    }
  }

  async handleSignalCandidate(payload) {
    const senderId = payload?.sender_session_id;
    const targetId = payload?.target_session_id;

    if (targetId && this.mySessionId && targetId !== this.mySessionId) {
      return;
    }

    const effectiveId = senderId || this._getSinglePeerId();
    if (!effectiveId) return;

    const peer = this.peers.get(effectiveId);
    if (peer) {
      await peer.handleRemoteCandidate(payload);
    }
  }

  async handlePeerJoined(payload) {
    const peerId = payload?.peer_session_id;
    const myId = payload?.session_id || this.mySessionId;
    if (myId) this.mySessionId = myId;
    if (payload?.role) this.myRole = payload.role;
    if (payload?.room_code) this.roomCode = payload.room_code;

    // 1. If a specific peer_session_id joined and it is not me:
    if (peerId && peerId !== this.mySessionId) {
      const remoteRole = this._findParticipantRole(payload.participants, peerId) || 'guest';
      const isExisting = this.peers.has(peerId);
      const peer = this.createPeer(peerId, remoteRole);
      if (!isExisting || !peer.pc || peer.pc.connectionState === 'closed') {
        const isInit = this.shouldInitiate(peerId, remoteRole);
        await peer.startPeerConnection(isInit ? 'host' : 'guest');
      }
    }

    // 2. Synchronize with participant roster if present (e.g. on self join)
    if (Array.isArray(payload?.participants)) {
      await this.handleRoster(payload.participants);
    }
  }

  handlePeerLeft(payload) {
    const peerId = payload?.peer_session_id;
    if (peerId) {
      this.removePeer(peerId, payload?.reason || 'Peer left');
    } else {
      // 2-person room legacy fallback or all peers left
      this.closeAll();
    }
  }

  handlePeerDisconnected(payload) {
    const peerId = payload?.peer_session_id;
    if (peerId && this.peers.has(peerId)) {
      this.emit('peerDisconnected', { peerSessionId: peerId, ...payload });
    }
  }

  async handlePeerReconnected(payload) {
    const peerId = payload?.peer_session_id;
    if (peerId) {
      const peer = this.peers.get(peerId);
      if (peer && (!peer.isChatReady() || !peer.isFileChannelReady())) {
        const remoteRole = this._findParticipantRole(payload?.participants, peerId) || 'guest';
        if (this.shouldInitiate(peerId, remoteRole)) {
          await peer.attemptIceRestart('Peer reconnected');
        }
      }
      this.emit('peerReconnected', { peerSessionId: peerId, ...payload });
    }
  }

  async handleRoster(participants) {
    if (!Array.isArray(participants)) return;
    this.latestRoster = [...participants];

    // 1. Identify present remote participants and active remote participants
    const presentRemoteIds = new Set();
    const activeRemoteMap = new Map();

    for (const p of participants) {
      if (!p || !p.session_id || p.session_id === this.mySessionId) {
        continue;
      }
      if (p.status === 'removed') {
        continue;
      }

      presentRemoteIds.add(p.session_id);

      // Inactive participants (e.g. status === 'disconnected' in grace period) are ignored for new discovery
      const isActive = !p.status || p.status === 'connected';
      if (isActive) {
        activeRemoteMap.set(p.session_id, p.role || 'guest');
      }
    }

    // 2. Prune peers no longer present in authoritative roster
    for (const peerId of Array.from(this.peers.keys())) {
      if (!presentRemoteIds.has(peerId)) {
        this.removePeer(peerId, 'Departed from roster');
      }
    }

    // 3. Discover and initiate connections for active remote participants not yet connected
    for (const [peerId, remoteRole] of activeRemoteMap.entries()) {
      if (this.peers.size >= this.maxRemotePeers && !this.peers.has(peerId)) {
        console.warn(
          `[PeerRegistry] Maximum peer capacity (${this.maxRemotePeers}) reached during roster synchronization. Skipping ${peerId}`
        );
        continue;
      }

      const isExisting = this.peers.has(peerId);
      const peer = this.createPeer(peerId, remoteRole);

      // Only initiate if connection not yet created or was closed (idempotent)
      if (!isExisting || !peer.pc || peer.pc.connectionState === 'closed') {
        const isInit = this.shouldInitiate(peerId, remoteRole);
        await peer.startPeerConnection(isInit ? 'host' : 'guest');
      }
    }
  }

  // ----------------------------------------------------
  // Aggregated State Computation
  // ----------------------------------------------------

  _handlePeerStateChange(peerSessionId, category, state) {
    this._updateAggregatedStates();
  }

  _updateAggregatedStates() {
    const peers = this.getPeers();
    if (peers.length === 0) {
      this.connectionState = PEER_CONNECTION_STATES.IDLE;
      this.dataChannelState = DATA_CHANNEL_STATES.IDLE;
      this.fileChannelState = DATA_CHANNEL_STATES.IDLE;
      this.emit('connectionStateChange', this.connectionState);
      this.emit('dataChannelStateChange', this.dataChannelState);
      this.emit('fileChannelStateChange', this.fileChannelState);
      return;
    }

    // 1. ConnectionState aggregation:
    // If any is connected -> connected. If any is connecting -> connecting. If all failed -> failed.
    const anyConnected = peers.some((p) => p.connectionState === PEER_CONNECTION_STATES.CONNECTED);
    const anyConnecting = peers.some((p) => p.connectionState === PEER_CONNECTION_STATES.CONNECTING);
    const allFailed = peers.every((p) => p.connectionState === PEER_CONNECTION_STATES.FAILED);

    const prevConn = this.connectionState;
    if (anyConnected) {
      this.connectionState = PEER_CONNECTION_STATES.CONNECTED;
    } else if (anyConnecting) {
      this.connectionState = PEER_CONNECTION_STATES.CONNECTING;
    } else if (allFailed) {
      this.connectionState = PEER_CONNECTION_STATES.FAILED;
    } else {
      this.connectionState = peers[0].connectionState;
    }
    if (this.connectionState !== prevConn) {
      this.emit('connectionStateChange', this.connectionState);
    }

    // 2. DataChannelState aggregation:
    const anyChatOpen = peers.some((p) => p.dataChannelState === DATA_CHANNEL_STATES.OPEN);
    const anyChatConnecting = peers.some((p) => p.dataChannelState === DATA_CHANNEL_STATES.CONNECTING);
    const prevData = this.dataChannelState;
    if (anyChatOpen) {
      this.dataChannelState = DATA_CHANNEL_STATES.OPEN;
    } else if (anyChatConnecting) {
      this.dataChannelState = DATA_CHANNEL_STATES.CONNECTING;
    } else {
      this.dataChannelState = peers[0].dataChannelState;
    }
    if (this.dataChannelState !== prevData) {
      this.emit('dataChannelStateChange', this.dataChannelState);
    }

    // 3. FileChannelState aggregation:
    const anyFileOpen = peers.some((p) => p.fileChannelState === DATA_CHANNEL_STATES.OPEN);
    const anyFileConnecting = peers.some((p) => p.fileChannelState === DATA_CHANNEL_STATES.CONNECTING);
    const prevFile = this.fileChannelState;
    if (anyFileOpen) {
      this.fileChannelState = DATA_CHANNEL_STATES.OPEN;
    } else if (anyFileConnecting) {
      this.fileChannelState = DATA_CHANNEL_STATES.CONNECTING;
    } else {
      this.fileChannelState = peers[0].fileChannelState;
    }
    if (this.fileChannelState !== prevFile) {
      this.emit('fileChannelStateChange', this.fileChannelState);
    }
  }

  // ----------------------------------------------------
  // Transport Facade (Chat, Files & Diagnostics)
  // ----------------------------------------------------

  isChatReady(targetSessionId = null) {
    if (targetSessionId) {
      const peer = this.peers.get(targetSessionId);
      return peer ? peer.isChatReady() : false;
    }
    return this.getPeers().some((p) => p.isChatReady());
  }

  isFileChannelReady(targetSessionId = null) {
    if (targetSessionId) {
      const peer = this.peers.get(targetSessionId);
      return peer ? peer.isFileChannelReady() : false;
    }
    return this.getPeers().some((p) => p.isFileChannelReady());
  }

  /**
   * Send a chat message. In Phase 2A mesh without recipient selection UI,
   * broadcasts to all connected peers and returns the local message object.
   */
  sendChatMessage(text, targetSessionId = null) {
    if (targetSessionId) {
      const peer = this.peers.get(targetSessionId);
      if (!peer || !peer.isChatReady()) {
        throw new Error(`Target peer ${targetSessionId} is not connected or ready for chat.`);
      }
      this.emit('peerActivity', { peerSessionId: targetSessionId, type: 'chat', direction: 'out' });
      return peer.sendChatMessage(text);
    }

    const readyPeers = this.getPeers().filter((p) => p.isChatReady());
    if (readyPeers.length === 0) {
      throw new Error('WebRTC DataChannel is not open with any peer.');
    }

    let localMessage = null;
    for (const peer of readyPeers) {
      localMessage = peer.sendChatMessage(text);
      this.emit('peerActivity', { peerSessionId: peer.remoteSessionId, type: 'chat', direction: 'out' });
    }
    return localMessage;
  }

  /**
   * Stream a file to target peer or single available peer.
   */
  async sendFile(file, onProgress, targetSessionId = null) {
    if (targetSessionId) {
      const peer = this.peers.get(targetSessionId);
      if (!peer || !peer.isFileChannelReady()) {
        throw new Error(`Target peer ${targetSessionId} is not ready for file transfer.`);
      }
      this.emit('peerActivity', { peerSessionId: targetSessionId, type: 'file', direction: 'out' });
      return peer.sendFile(file, onProgress);
    }

    const readyPeer = this.getPeers().find((p) => p.isFileChannelReady());
    if (!readyPeer) {
      throw new Error('WebRTC File DataChannel is not open with any peer.');
    }
    this.emit('peerActivity', { peerSessionId: readyPeer.remoteSessionId, type: 'file', direction: 'out' });
    return readyPeer.sendFile(file, onProgress);
  }

  /**
   * Stream a file to multiple selected recipients independently.
   * Creates an isolated transfer operation per recipient with unique transfer IDs.
   * A slow or failing recipient does not block or fail others.
   *
   * @param {File|Blob} file - File to transmit
   * @param {string[]} recipientSessionIds - Array of target peer session IDs
   * @param {Function} [onProgress] - Optional progress callback
   * @returns {Promise<Array<{ peerSessionId: string, transferId: string }>>}
   */
  async sendFilesToRecipients(file, recipientSessionIds, onProgress = null) {
    if (!Array.isArray(recipientSessionIds) || recipientSessionIds.length === 0) {
      throw new Error('At least one recipient must be specified.');
    }

    const results = [];
    const errors = [];

    for (const sid of recipientSessionIds) {
      const peer = this.peers.get(sid);
      if (!peer || !peer.isFileChannelReady()) {
        errors.push({ peerSessionId: sid, error: `Recipient ${sid} is not ready for file transfer.` });
        continue;
      }

      try {
        this.emit('peerActivity', { peerSessionId: sid, type: 'file', direction: 'out' });
        const transferId = await peer.sendFile(file, (p) => {
          if (typeof onProgress === 'function') {
            onProgress({ ...p, peerSessionId: sid });
          }
        });
        results.push({ peerSessionId: sid, transferId });
      } catch (err) {
        errors.push({ peerSessionId: sid, error: err.message });
      }
    }

    if (results.length === 0 && errors.length > 0) {
      throw new Error(errors.map((e) => e.error).join('; '));
    }

    return results;
  }

  /**
   * Cancel an active file transfer on a specific peer or across all peers.
   */
  cancelTransfer(transferId, reason = 'Cancelled by user', targetSessionId = null) {
    if (targetSessionId) {
      const peer = this.peers.get(targetSessionId);
      if (peer) {
        if (typeof peer.cancelTransfer === 'function') {
          peer.cancelTransfer(transferId, reason);
        } else if (typeof peer.cancelFileTransfer === 'function') {
          peer.cancelFileTransfer(transferId, reason);
        }
      }
      return;
    }

    this.peers.forEach((peer) => {
      if (peer.activeTransfers && peer.activeTransfers.has(transferId)) {
        if (typeof peer.cancelTransfer === 'function') {
          peer.cancelTransfer(transferId, reason);
        } else if (typeof peer.cancelFileTransfer === 'function') {
          peer.cancelFileTransfer(transferId, reason);
        }
      }
    });
  }

  cancelFileTransfer(transferId, targetSessionId = null) {
    return this.cancelTransfer(transferId, 'Cancelled by user', targetSessionId);
  }

  canAttemptIceRestart() {
    return this.getPeers().some((p) => p.canAttemptIceRestart());
  }

  async attemptIceRestart(reason = 'network disruption') {
    let anyRestarted = false;
    for (const peer of this.peers.values()) {
      if (peer.canAttemptIceRestart()) {
        const ok = await peer.attemptIceRestart(reason);
        if (ok) anyRestarted = true;
      }
    }
    return anyRestarted;
  }

  async startPeerConnection(role, isRecovery = false) {
    this.myRole = role;
    for (const [peerId, peer] of this.peers.entries()) {
      const peerRole = this.shouldInitiate(peerId, 'guest') ? 'host' : 'guest';
      await peer.startPeerConnection(peerRole, isRecovery);
    }
  }

  /**
   * Aggregate connection diagnostics across all managed peer connections.
   */
  async getConnectionDiagnostics() {
    const peers = this.getPeers();
    if (peers.length === 0) {
      return {
        connectionState: this.connectionState,
        iceConnectionState: 'idle',
        iceGatheringState: 'idle',
        signalingState: 'idle',
        selectedCandidateType: 'unknown',
        isRelay: false,
        hasRelayCandidate: false,
        hasLocalRelay: false,
        hasRemoteRelay: false,
        candidatePairState: null,
        roundTripTimeMs: null,
        bytesSent: 0,
        bytesReceived: 0,
        reconnectAttempts: this.iceRestartAttempts,
        maxReconnectAttempts: this.maxIceRestartAttempts,
        hasTurnConfigured: Boolean(APP_CONFIG.iceConfig?.isTurnConfigured),
        activePeerCount: 0,
        totalPeerCount: 0,
        peers: {},
      };
    }

    const peerDiagnostics = {};
    let totalBytesSent = 0;
    let totalBytesReceived = 0;
    let isAnyRelay = false;
    let hasAnyRelayCand = false;

    for (const [id, peer] of this.peers.entries()) {
      try {
        const diag = await peer.getConnectionDiagnostics();
        peerDiagnostics[id] = diag;
        totalBytesSent += diag.bytesSent || 0;
        totalBytesReceived += diag.bytesReceived || 0;
        if (diag.isRelay) isAnyRelay = true;
        if (diag.hasRelayCandidate) hasAnyRelayCand = true;
      } catch (err) {
        console.warn(`[PeerRegistry] Failed to get diagnostics for peer ${id}:`, err);
      }
    }

    const firstPeerDiag = Object.values(peerDiagnostics)[0] || {};

    return {
      connectionState: this.connectionState,
      iceConnectionState: firstPeerDiag.iceConnectionState || 'idle',
      iceGatheringState: firstPeerDiag.iceGatheringState || 'idle',
      signalingState: firstPeerDiag.signalingState || 'idle',
      selectedCandidateType: isAnyRelay ? 'relay' : firstPeerDiag.selectedCandidateType || 'unknown',
      isRelay: isAnyRelay,
      hasRelayCandidate: hasAnyRelayCand,
      hasLocalRelay: Boolean(firstPeerDiag.hasLocalRelay),
      hasRemoteRelay: Boolean(firstPeerDiag.hasRemoteRelay),
      candidatePairState: firstPeerDiag.candidatePairState || null,
      roundTripTimeMs: firstPeerDiag.roundTripTimeMs || null,
      bytesSent: totalBytesSent,
      bytesReceived: totalBytesReceived,
      reconnectAttempts: this.iceRestartAttempts,
      maxReconnectAttempts: this.maxIceRestartAttempts,
      hasTurnConfigured: Boolean(APP_CONFIG.iceConfig?.isTurnConfigured),
      activePeerCount: this.getActivePeers().length,
      totalPeerCount: this.peers.size,
      peers: peerDiagnostics,
    };
  }

  emitDiagnosticsUpdate() {
    this.getConnectionDiagnostics().then((d) => this.emit('diagnosticsUpdate', d)).catch(() => {});
  }
}

export const peerRegistry = new PeerRegistry();
