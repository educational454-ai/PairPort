/**
 * PairPort WebSocket Signaling Client
 * Handles real-time room creation, peer joining, WebRTC offer/answer/candidate relays,
 * and session lifecycle.
 */

import { APP_CONFIG } from '../config/app-config.js';

export const SIGNALING_STATES = Object.freeze({
  IDLE: 'idle',
  CREATING: 'creating',
  JOINING: 'joining',
  WAITING: 'waiting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
});

export class SignalingClient {
  constructor(endpoint = APP_CONFIG.wsEndpoint) {
    this.endpoint = endpoint;
    this.ws = null;
    this.state = SIGNALING_STATES.IDLE;
    this.roomCode = null;
    this.sessionId = null;
    this.role = null;
    this.invitationToken = null;
    this.peerSessionId = null;
    this.listeners = new Map();
    this.isExplicitLeave = false;

    // Clean up socket on window beforeunload
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this.leaveRoom();
      });
    }
  }

  /** Subscribe to events ('stateChange', 'roomCreated', 'waiting', 'peerJoined', 'peerLeft', 'signalOffer', 'signalAnswer', 'signalCandidate', 'error') */
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
          console.error(`Signaling listener error for '${event}':`, err);
        }
      });
    }
  }

  setState(newState, detail = {}) {
    this.state = newState;
    this.emit('stateChange', newState, {
      state: newState,
      roomCode: this.roomCode,
      sessionId: this.sessionId,
      role: this.role,
      peerSessionId: this.peerSessionId,
      ...detail,
    });
  }

  /** Normalize room code for consistent protocol exchange */
  normalizeCode(rawCode) {
    if (!rawCode || typeof rawCode !== 'string') return '';
    let cleaned = rawCode.trim().toUpperCase().replace(/\s+/g, '');
    if (!cleaned.startsWith('PORT-') && !cleaned.startsWith('PORT')) {
      cleaned = `PORT-${cleaned}`;
    } else if (cleaned.startsWith('PORT') && !cleaned.startsWith('PORT-')) {
      cleaned = `PORT-${cleaned.slice(4)}`;
    }
    return cleaned;
  }

  /** Connect to WebSocket and create a new room as host */
  createRoom() {
    if (this.state === SIGNALING_STATES.CREATING || this.state === SIGNALING_STATES.JOINING) {
      return;
    }

    this.leaveRoom();
    this.isExplicitLeave = false;
    this.setState(SIGNALING_STATES.CREATING);

    this._connect((ws) => {
      this._send(ws, 'create');
    });
  }

  /** Connect to WebSocket and join an existing room as guest with invitation token */
  joinRoom(rawCode, invitationToken) {
    if (this.state === SIGNALING_STATES.CREATING || this.state === SIGNALING_STATES.JOINING) {
      return;
    }

    const code = this.normalizeCode(rawCode);
    if (!code) {
      this.setState(SIGNALING_STATES.ERROR, { message: 'Invalid room code.' });
      return;
    }

    if (!invitationToken || typeof invitationToken !== 'string' || !invitationToken.trim()) {
      this.setState(SIGNALING_STATES.ERROR, {
        code: 'INVITATION_REQUIRED',
        message: 'An invitation token or valid invite link is required to join this room.',
      });
      this.emit('error', {
        code: 'INVITATION_REQUIRED',
        message: 'An invitation token or valid invite link is required to join this room.',
      });
      return;
    }

    const token = invitationToken.trim();
    this.leaveRoom();
    this.isExplicitLeave = false;
    this.invitationToken = token;
    this.setState(SIGNALING_STATES.JOINING);

    this._connect((ws) => {
      this._send(ws, 'join', { room_code: code, invitation_token: token });
    });
  }

  /** Send WebRTC SDP Offer to peer via signaling server */
  sendOffer(sdp) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const sdpPayload = {
        type: sdp.type,
        sdp: sdp.sdp,
      };
      this._send(this.ws, 'signal-offer', { sdp: sdpPayload });
    }
  }

  /** Send WebRTC SDP Answer to peer via signaling server */
  sendAnswer(sdp) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const sdpPayload = {
        type: sdp.type,
        sdp: sdp.sdp,
      };
      this._send(this.ws, 'signal-answer', { sdp: sdpPayload });
    }
  }

  /** Send ICE Candidate to peer via signaling server */
  sendCandidate(candidate) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._send(this.ws, 'signal-candidate', { candidate });
    }
  }

  /** Voluntarily leave the room and reset state */
  leaveRoom() {
    this.isExplicitLeave = true;

    if (this.ws) {
      const closingWs = this.ws;
      this.ws = null;
      try {
        if (closingWs.readyState === WebSocket.OPEN) {
          this._send(closingWs, 'leave');
        }
        closingWs.onopen = null;
        closingWs.onmessage = null;
        closingWs.onerror = null;
        closingWs.onclose = null;
        closingWs.close(1000, 'User left session');
      } catch {
        // Ignore close errors
      }
    }

    this.roomCode = null;
    this.sessionId = null;
    this.role = null;
    this.invitationToken = null;
    this.peerSessionId = null;

    if (this.state !== SIGNALING_STATES.IDLE) {
      this.setState(SIGNALING_STATES.IDLE);
    }
  }

  _connect(onOpenCallback) {
    try {
      const socket = new WebSocket(this.endpoint);
      this.ws = socket;

      socket.onopen = () => {
        if (this.ws !== socket) return;
        if (typeof onOpenCallback === 'function') {
          onOpenCallback(socket);
        }
      };

      socket.onmessage = (event) => {
        if (this.ws !== socket) return;
        this._handleMessage(event.data);
      };

      socket.onerror = (err) => {
        if (this.ws !== socket) return;
        if (!this.isExplicitLeave) {
          this.setState(SIGNALING_STATES.ERROR, {
            message: 'Unable to connect to the PairPort signaling server. Verify backend is running on 127.0.0.1:8000.',
            rawError: err,
          });
          this.emit('error', {
            code: 'CONNECTION_FAILED',
            message: 'Unable to connect to the signaling server.',
          });
        }
      };

      socket.onclose = (event) => {
        if (this.ws !== socket) return;
        if (this.isExplicitLeave) return;

        if (this.state === SIGNALING_STATES.WAITING || this.state === SIGNALING_STATES.CONNECTED) {
          this.setState(SIGNALING_STATES.DISCONNECTED, {
            reason: event.reason || 'WebSocket disconnected',
          });
        } else if (this.state !== SIGNALING_STATES.ERROR && this.state !== SIGNALING_STATES.IDLE) {
          this.setState(SIGNALING_STATES.DISCONNECTED);
        }
        this.ws = null;
      };
    } catch (err) {
      this.setState(SIGNALING_STATES.ERROR, {
        message: 'Failed to initiate WebSocket connection.',
      });
      this.emit('error', {
        code: 'INIT_ERROR',
        message: String(err),
      });
    }
  }

  _send(ws, type, payload = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload }));
    }
  }

  _handleMessage(rawData) {
    let data;
    try {
      data = JSON.parse(rawData);
    } catch {
      return;
    }

    const { type, payload = {} } = data;

    switch (type) {
      case 'room-created': {
        this.roomCode = payload.room_code;
        this.sessionId = payload.session_id;
        this.role = payload.role;
        this.invitationToken = payload.invitation_token || null;
        this.emit('roomCreated', payload);
        break;
      }

      case 'waiting': {
        this.roomCode = payload.room_code || this.roomCode;
        if (payload.session_id) this.sessionId = payload.session_id;
        if (payload.role) this.role = payload.role;
        this.peerSessionId = null;
        this.setState(SIGNALING_STATES.WAITING, payload);
        this.emit('waiting', payload);
        break;
      }

      case 'peer-joined': {
        this.roomCode = payload.room_code || this.roomCode;
        if (payload.session_id) this.sessionId = payload.session_id;
        if (payload.role) this.role = payload.role;
        this.peerSessionId = payload.peer_session_id;
        this.setState(SIGNALING_STATES.CONNECTED, payload);
        this.emit('peerJoined', payload);
        break;
      }

      case 'signal-offer':
      case 'offer': {
        this.emit('signalOffer', payload);
        break;
      }

      case 'signal-answer':
      case 'answer': {
        this.emit('signalAnswer', payload);
        break;
      }

      case 'signal-candidate':
      case 'candidate': {
        this.emit('signalCandidate', payload);
        break;
      }

      case 'peer-left': {
        this.peerSessionId = null;
        this.setState(SIGNALING_STATES.WAITING, {
          reason: payload.reason || 'Peer left the session.',
        });
        this.emit('peerLeft', payload);
        break;
      }

      case 'error': {
        this.setState(SIGNALING_STATES.ERROR, payload);
        this.emit('error', payload);
        break;
      }

      case 'left': {
        this.setState(SIGNALING_STATES.IDLE);
        break;
      }

      case 'pong': {
        // Keepalive acknowledged
        break;
      }

      default:
        break;
    }
  }
}

export const signalingClient = new SignalingClient();
