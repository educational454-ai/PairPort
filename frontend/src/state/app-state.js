/**
 * PairPort Application State Container
 * Simple, centralized mutable state container for PairPort.
 *
 * Avoids complex reactive frameworks while providing consistent
 * initialization, defaults, and session teardown helpers.
 */

import { APP_CONFIG } from '../config/app-config.js';
import { SIGNALING_STATES } from '../services/signaling.js';
import {
  PEER_CONNECTION_STATES,
  DATA_CHANNEL_STATES,
} from '../services/peer-connection.js';

/**
 * Create a fresh default diagnostics object.
 */
export function createDefaultDiagnostics() {
  return {
    connectionState: 'idle',
    iceConnectionState: 'idle',
    iceGatheringState: 'idle',
    signalingState: 'idle',
    selectedCandidateType: 'unknown',
    isRelay: false,
    candidatePairState: null,
    roundTripTimeMs: null,
    bytesSent: 0,
    bytesReceived: 0,
    reconnectAttempts: 0,
    maxReconnectAttempts: 3,
    hasTurnConfigured: Boolean(APP_CONFIG.iceConfig?.isTurnConfigured),
  };
}

/**
 * Create a fresh initial state object.
 */
export function createInitialState() {
  return {
    // Real signaling state (Phase 3 & 9F & 9J)
    signalingState: SIGNALING_STATES.IDLE,
    realRoomCode: null,
    realSessionId: null,
    realRole: null,
    invitationToken: null, // In-memory only; never persisted in localStorage or logs
    invitationRoomCode: null, // Normalized room code bound to invitationToken
    reconnectToken: null, // In-memory only; never persisted in localStorage, cookies, or logs
    peerSessionId: null,
    signalingError: null,
    participants: [], // Authoritative room participant roster (Phase 2B)

    // Real WebRTC state (Phase 4 & 5)
    peerConnectionState: PEER_CONNECTION_STATES.IDLE,
    dataChannelState: DATA_CHANNEL_STATES.IDLE,
    fileChannelState: DATA_CHANNEL_STATES.IDLE,
    realChatMessages: [], // In-memory only; never persisted to localStorage or database
    realFiles: [],        // In-memory real file transfers
    activeTransfer: null, // Currently streaming file transfer
    selectedRecipientIds: [], // Selected remote peer session IDs for file transfers (Phase 3)

    // Network Resilience & Diagnostics (Phase 6 & 9J)
    isReconnecting: false,
    reconnectAttempt: 0,
    isSignalingReconnecting: false,
    signalingReconnectAttempt: 0,
    isPeerDisconnected: false,
    peerDisconnectGracePeriod: null,
    peerDisconnectDeadline: null,
    isDiagnosticsOpen: false,
    connectionDiagnostics: createDefaultDiagnostics(),

    // UI state
    isMobileMenuOpen: false,

    // Demo Mockup Data
    demoMessages: [...(APP_CONFIG.demoData?.sampleMessages || [])],
  };
}

/**
 * Shared singleton application state
 */
export const state = createInitialState();

/**
 * Reset room session state back to idle baseline.
 * Used when voluntarily leaving a room or tearing down a session.
 * Preserves UI preferences like isMobileMenuOpen and demoMessages.
 *
 * @param {object} [target=state] - The state object to reset
 * @returns {object} The mutated target state
 */
export function resetSessionState(target = state) {
  target.signalingState = SIGNALING_STATES.IDLE;
  target.realRoomCode = null;
  target.realSessionId = null;
  target.realRole = null;
  target.invitationToken = null;
  target.invitationRoomCode = null;
  target.reconnectToken = null;
  target.peerSessionId = null;
  target.signalingError = null;
  target.participants = [];

  target.peerConnectionState = PEER_CONNECTION_STATES.IDLE;
  target.dataChannelState = DATA_CHANNEL_STATES.IDLE;
  target.fileChannelState = DATA_CHANNEL_STATES.IDLE;

  target.isReconnecting = false;
  target.reconnectAttempt = 0;
  target.isSignalingReconnecting = false;
  target.signalingReconnectAttempt = 0;
  target.isPeerDisconnected = false;
  target.peerDisconnectGracePeriod = null;
  target.peerDisconnectDeadline = null;
  target.isDiagnosticsOpen = false;
  target.connectionDiagnostics = createDefaultDiagnostics();

  if (Array.isArray(target.realFiles)) {
    target.realFiles.forEach((f) => {
      if (f && f.blobUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        try {
          URL.revokeObjectURL(f.blobUrl);
        } catch {}
      }
    });
  }

  target.realChatMessages = [];
  target.realFiles = [];
  target.activeTransfer = null;
  target.selectedRecipientIds = [];
  return target;
}
