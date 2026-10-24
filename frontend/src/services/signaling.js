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
  RECONNECTING: 'reconnecting',
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
    this.invitationRoomCode = null;
    this.reconnectToken = null; // In-memory only; never persisted in localStorage or logs
    this.peerSessionId = null;
    this.listeners = new Map();
    this.isExplicitLeave = false;
    this._joinAttemptGeneration = 0;
    this._pendingJoin = null;

    // Bounded reconnect properties (Step 9J)
    this.reconnectAttempt = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectGracePeriod = 30.0;
    this.reconnectDeadline = null;
    this.reconnectTimer = null;
    this._reconnectAttemptGeneration = 0;
    this._socketGeneration = 0;

    // Clean up socket on window beforeunload
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this.leaveRoom();
      });
    }
  }

  /** Subscribe to events ('stateChange', 'roomCreated', 'waiting', 'peerJoined', 'peerLeft', 'reconnected', 'peerDisconnected', 'peerReconnected', 'reconnectFailed', 'reconnecting', 'signalOffer', 'signalAnswer', 'signalCandidate', 'error') */
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
    this._cancelReconnect();
    this.reconnectToken = null;
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
    this._cancelReconnect();
    this.reconnectToken = null;
    this.invitationToken = token;
    this.invitationRoomCode = code;

    this._joinAttemptGeneration = (this._joinAttemptGeneration || 0) + 1;
    this._pendingJoin = {
      code,
      roomCode: code,
      token,
      generation: this._joinAttemptGeneration,
    };

    this.setState(SIGNALING_STATES.JOINING);

    this._connect((ws) => {
      this._send(ws, 'join', { room_code: code, invitation_token: token });
    });
  }

  /**
   * Reconnect to existing room session using in-memory credentials.
   *
   * @param {string} [rawCode=this.roomCode]
   * @param {string} [sessionId=this.sessionId]
   * @param {string} [reconnectToken=this.reconnectToken]
   */
  reconnect(rawCode = this.roomCode, sessionId = this.sessionId, reconnectToken = this.reconnectToken) {
    if (this.isExplicitLeave) return;

    const code = this.normalizeCode(rawCode);
    if (!code || !sessionId || !reconnectToken) {
      this._cancelReconnect();
      this.setState(SIGNALING_STATES.DISCONNECTED, {
        message: 'Missing credentials to reconnect.',
      });
      this.emit('reconnectFailed', {
        code: 'MISSING_RECONNECT_CREDENTIALS',
        message: 'Cannot reconnect without room code, session ID, and reconnect token.',
      });
      return;
    }

    // Check if grace period deadline has passed
    if ((this.reconnectDeadline && Date.now() > this.reconnectDeadline) || (this.reconnectAttempt >= this.maxReconnectAttempts)) {
      this._cancelReconnect();
      this.reconnectToken = null;
      this.setState(SIGNALING_STATES.DISCONNECTED, {
        message: 'Reconnect window expired.',
      });
      this.emit('reconnectFailed', {
        code: 'RECONNECT_EXPIRED',
        message: 'Reconnect window expired.',
      });
      return;
    }

    this.roomCode = code;
    this.sessionId = sessionId;
    this.reconnectToken = reconnectToken;
    this.reconnectAttempt++;
    this._reconnectAttemptGeneration = (this._reconnectAttemptGeneration || 0) + 1;
    const currentGen = this._reconnectAttemptGeneration;

    this.setState(SIGNALING_STATES.RECONNECTING, {
      attempt: this.reconnectAttempt,
      maxAttempts: this.maxReconnectAttempts,
      roomCode: code,
    });
    this.emit('reconnecting', {
      attempt: this.reconnectAttempt,
      maxAttempts: this.maxReconnectAttempts,
      roomCode: code,
    });

    // Safely close previous socket without triggering leaveRoom
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      try {
        oldWs.onopen = null;
        oldWs.onmessage = null;
        oldWs.onerror = null;
        oldWs.onclose = null;
        oldWs.close();
      } catch {}
    }

    this._connect((ws) => {
      if (this._reconnectAttemptGeneration !== currentGen) return;
      this._send(ws, 'reconnect', {
        room_code: code,
        session_id: sessionId,
        reconnect_token: reconnectToken,
      });
    });
  }

  /** Schedule next reconnect attempt with exponential backoff bounded by grace period */
  _scheduleReconnect() {
    if (this.isExplicitLeave) return;
    if (!this.roomCode || !this.sessionId || !this.reconnectToken) return;

    // Avoid duplicate or overlapping timers
    if (this.reconnectTimer) return;

    if (!this.reconnectDeadline) {
      this.reconnectDeadline = Date.now() + (this.reconnectGracePeriod * 1000);
    }

    if (Date.now() >= this.reconnectDeadline || this.reconnectAttempt >= this.maxReconnectAttempts) {
      this._cancelReconnect();
      this.reconnectToken = null;
      this.setState(SIGNALING_STATES.DISCONNECTED, {
        reason: 'Reconnect attempts exhausted or deadline passed',
      });
      this.emit('reconnectFailed', {
        code: 'RECONNECT_EXHAUSTED',
        message: 'Reconnection attempts exhausted.',
      });
      return;
    }

    // Exponential backoff: 500ms, 1000ms, 2000ms, 4000ms, max 5000ms
    let delay = Math.min(500 * Math.pow(2, this.reconnectAttempt), 5000);
    if (Date.now() + delay > this.reconnectDeadline) {
      delay = Math.max(0, this.reconnectDeadline - Date.now());
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnect();
    }, delay);
  }

  /** Cancel active reconnect timer and reset retry counters */
  _cancelReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.reconnectDeadline = null;
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
    this._cancelReconnect();

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
    this.invitationRoomCode = null;
    this.reconnectToken = null;
    this.peerSessionId = null;
    this._pendingJoin = null;

    if (this.state !== SIGNALING_STATES.IDLE) {
      this.setState(SIGNALING_STATES.IDLE);
    }
  }

  _connect(onOpenCallback) {
    try {
      const socket = new WebSocket(this.endpoint);
      this.ws = socket;
      const socketGen = ++this._socketGeneration;

      socket.onopen = () => {
        if (this.ws !== socket || this._socketGeneration !== socketGen) return;
        if (typeof onOpenCallback === 'function') {
          onOpenCallback(socket);
        }
      };

      socket.onmessage = (event) => {
        if (this.ws !== socket || this._socketGeneration !== socketGen) return;
        this._handleMessage(event.data);
      };

      socket.onerror = (err) => {
        if (this.ws !== socket || this._socketGeneration !== socketGen) return;
        if (!this.isExplicitLeave) {
          if (this.state !== SIGNALING_STATES.RECONNECTING) {
            this.setState(SIGNALING_STATES.ERROR, {
              message: 'Unable to connect to the PairPort signaling server. Verify backend is running on 127.0.0.1:8000.',
              rawError: err,
            });
            this.emit('error', {
              code: 'CONNECTION_FAILED',
              message: 'Unable to connect to the signaling server.',
            });
          }
        }
      };

      socket.onclose = (event) => {
        if (this.ws !== socket || this._socketGeneration !== socketGen) return;
        this.ws = null;

        if (this.isExplicitLeave) return;

        // Bounded automatic reconnection if credentials exist
        const canReconnect = Boolean(this.roomCode && this.sessionId && this.reconnectToken);
        if (canReconnect && this.state !== SIGNALING_STATES.ERROR) {
          this._scheduleReconnect();
        } else if (this.state === SIGNALING_STATES.WAITING || this.state === SIGNALING_STATES.CONNECTED) {
          this.setState(SIGNALING_STATES.DISCONNECTED, {
            reason: event.reason || 'WebSocket disconnected',
          });
        } else if (this.state !== SIGNALING_STATES.ERROR && this.state !== SIGNALING_STATES.IDLE) {
          this.setState(SIGNALING_STATES.DISCONNECTED);
        }
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
        this.invitationRoomCode = payload.room_code || null;
        this.reconnectToken = payload.reconnect_token || null;
        this._cancelReconnect();
        this.emit('roomCreated', payload);
        break;
      }

      case 'waiting': {
        this.roomCode = payload.room_code || this.roomCode;
        if (payload.session_id) this.sessionId = payload.session_id;
        if (payload.role) this.role = payload.role;
        if (payload.reconnect_token) this.reconnectToken = payload.reconnect_token;
        this.peerSessionId = null;
        this._cancelReconnect();
        this.setState(SIGNALING_STATES.WAITING, payload);
        this.emit('waiting', payload);
        break;
      }

      case 'peer-joined': {
        this.roomCode = payload.room_code || this.roomCode;
        if (payload.session_id) this.sessionId = payload.session_id;
        if (payload.role) this.role = payload.role;
        if (payload.reconnect_token) this.reconnectToken = payload.reconnect_token;
        this.peerSessionId = payload.peer_session_id;
        this._cancelReconnect();
        this.setState(SIGNALING_STATES.CONNECTED, payload);
        this.emit('peerJoined', payload);
        break;
      }

      case 'reconnected': {
        this.roomCode = payload.room_code || this.roomCode;
        this.sessionId = payload.session_id || this.sessionId;
        this.role = payload.role || this.role;
        this.reconnectToken = payload.reconnect_token; // Credential rotation!
        this.peerSessionId = payload.peer_session_id || null;
        this._cancelReconnect();
        this.setState(this.peerSessionId ? SIGNALING_STATES.CONNECTED : SIGNALING_STATES.WAITING, payload);
        this.emit('reconnected', payload);
        break;
      }

      case 'peer-disconnected': {
        if (payload.grace_period) {
          this.reconnectGracePeriod = Number(payload.grace_period);
        }
        this.emit('peerDisconnected', payload);
        break;
      }

      case 'peer-reconnected': {
        this.peerSessionId = payload.peer_session_id;
        this.setState(SIGNALING_STATES.CONNECTED, payload);
        this.emit('peerReconnected', payload);
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
        const terminalReconnectErrors = [
          'RECONNECT_EXPIRED',
          'INVALID_RECONNECT_TOKEN',
          'PARTICIPANT_NOT_FOUND',
          'ROOM_NOT_FOUND',
          'ROOM_EXPIRED',
        ];
        if (terminalReconnectErrors.includes(payload.code)) {
          this._cancelReconnect();
          this.reconnectToken = null;
          this.emit('reconnectFailed', payload);
        }
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
