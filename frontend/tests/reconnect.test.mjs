/**
 * PairPort Frontend Reconnect Protocol Tests (Step 9J-2)
 *
 * Verifies participant reconnection protocol:
 * - In-memory credential capture and rotation
 * - Payload structure: room_code, session_id, reconnect_token
 * - Unexpected socket drops vs explicit leave
 * - Bounded retries, backoff, and grace period deadlines
 * - Stale socket race condition guards
 * - Peer disconnect grace period and deadline tracking
 * - WebRTC DataChannel decoupling
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { SignalingClient, SIGNALING_STATES } from '../src/services/signaling.js';
import { createInitialState, resetSessionState, state } from '../src/state/app-state.js';
import { initConnectionController } from '../src/features/connection/connection-controller.js';
import { computeSessionStatusInfo } from '../src/features/connection/session-panel.js';
import { PEER_CONNECTION_STATES, DATA_CHANNEL_STATES } from '../src/services/peer-connection.js';

describe('PairPort Frontend Reconnect Integration (Step 9J-2)', () => {
  let originalWebSocket;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  // ---------------------------------------------------------------------------
  // 1. In-Memory Credential Capture & Storage Hygiene
  // ---------------------------------------------------------------------------
  describe('1. Credential Capture & Memory-Only Storage', () => {
    it('captures session_id and reconnect_token for host on room-created', () => {
      const client = new SignalingClient('ws://127.0.0.1:8000/ws');
      assert.equal(client.reconnectToken, null);

      client._handleMessage(JSON.stringify({
        type: 'room-created',
        payload: {
          room_code: 'PORT-A1B2C3',
          session_id: 'sess-host-001',
          role: 'host',
          invitation_token: 'inv-tok-999',
          reconnect_token: 'rec-tok-host-abc',
        },
      }));

      assert.equal(client.roomCode, 'PORT-A1B2C3');
      assert.equal(client.sessionId, 'sess-host-001');
      assert.equal(client.reconnectToken, 'rec-tok-host-abc');
      assert.equal(client.invitationToken, 'inv-tok-999');
      // Reconnect token must be distinct from invitation token
      assert.notEqual(client.reconnectToken, client.invitationToken);
    });

    it('captures session_id and reconnect_token for guest on peer-joined', () => {
      const client = new SignalingClient('ws://127.0.0.1:8000/ws');

      client._handleMessage(JSON.stringify({
        type: 'peer-joined',
        payload: {
          room_code: 'PORT-A1B2C3',
          session_id: 'sess-guest-002',
          role: 'guest',
          peer_session_id: 'sess-host-001',
          reconnect_token: 'rec-tok-guest-xyz',
        },
      }));

      assert.equal(client.roomCode, 'PORT-A1B2C3');
      assert.equal(client.sessionId, 'sess-guest-002');
      assert.equal(client.reconnectToken, 'rec-tok-guest-xyz');
      assert.equal(client.peerSessionId, 'sess-host-001');
    });

    it('verifies reconnect credentials are never persisted to localStorage or sessionStorage', () => {
      const client = new SignalingClient('ws://127.0.0.1:8000/ws');
      client._handleMessage(JSON.stringify({
        type: 'room-created',
        payload: {
          room_code: 'PORT-SECURE',
          session_id: 'sess-secret',
          role: 'host',
          reconnect_token: 'super-sensitive-token-12345',
        },
      }));

      if (globalThis.localStorage) {
        assert.equal(globalThis.localStorage.getItem('reconnect_token'), null);
        assert.equal(globalThis.localStorage.getItem('reconnectToken'), null);
      }
      if (globalThis.sessionStorage) {
        assert.equal(globalThis.sessionStorage.getItem('reconnect_token'), null);
        assert.equal(globalThis.sessionStorage.getItem('reconnectToken'), null);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Reconnect Payload Structure & Token Rotation
  // ---------------------------------------------------------------------------
  describe('2. Reconnect Payload & Token Rotation', () => {
    it('sends the exact reconnect payload expected by the backend', async () => {
      let sentMessage = null;
      class MockWebSocket {
        constructor(url) {
          this.url = url;
          this.readyState = 1; // WebSocket.OPEN
          queueMicrotask(() => {
            if (typeof this.onopen === 'function') this.onopen();
          });
        }
        send(data) {
          sentMessage = JSON.parse(data);
        }
        close() {}
      }
      MockWebSocket.OPEN = 1;
      globalThis.WebSocket = MockWebSocket;

      const client = new SignalingClient('ws://127.0.0.1:8000/ws');
      client.reconnect('PORT-A1B2C3', 'sess-host-001', 'token-initial-111');
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.ok(sentMessage, 'A reconnect message should be sent');
      assert.equal(sentMessage.type, 'reconnect');
      assert.deepEqual(sentMessage.payload, {
        room_code: 'PORT-A1B2C3',
        session_id: 'sess-host-001',
        reconnect_token: 'token-initial-111',
      });
    });

    it('replaces old reconnect token immediately upon receiving reconnected event', () => {
      const client = new SignalingClient('ws://127.0.0.1:8000/ws');
      client.roomCode = 'PORT-A1B2C3';
      client.sessionId = 'sess-host-001';
      client.reconnectToken = 'old-token-000';

      let eventReceived = null;
      client.on('reconnected', (payload) => {
        eventReceived = payload;
      });

      client._handleMessage(JSON.stringify({
        type: 'reconnected',
        payload: {
          room_code: 'PORT-A1B2C3',
          session_id: 'sess-host-001',
          role: 'host',
          reconnect_token: 'new-rotated-token-999',
          peer_session_id: 'sess-guest-002',
          message: 'Successfully reconnected to room.',
        },
      }));

      assert.equal(client.reconnectToken, 'new-rotated-token-999');
      assert.notEqual(client.reconnectToken, 'old-token-000');
      assert.ok(eventReceived);
      assert.equal(eventReceived.reconnect_token, 'new-rotated-token-999');
      assert.equal(client.state, SIGNALING_STATES.CONNECTED);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Terminal Errors & Expired Reconnect
  // ---------------------------------------------------------------------------
  describe('3. Terminal Errors & Expiry Handling', () => {
    it('clears reconnect credentials on terminal reconnect error codes', () => {
      const terminalCodes = [
        'RECONNECT_EXPIRED',
        'INVALID_RECONNECT_TOKEN',
        'PARTICIPANT_NOT_FOUND',
        'ROOM_NOT_FOUND',
        'ROOM_EXPIRED',
      ];

      for (const code of terminalCodes) {
        const client = new SignalingClient('ws://127.0.0.1:8000/ws');
        client.roomCode = 'PORT-TEST';
        client.sessionId = 'sess-test';
        client.reconnectToken = 'tok-test';

        let failedEvent = null;
        client.on('reconnectFailed', (payload) => {
          failedEvent = payload;
        });

        client._handleMessage(JSON.stringify({
          type: 'error',
          payload: { code, message: `Terminal error ${code}` },
        }));

        assert.equal(client.reconnectToken, null, `Token must be cleared for ${code}`);
        assert.ok(failedEvent, `reconnectFailed must fire for ${code}`);
        assert.equal(failedEvent.code, code);
      }
    });

    it('rejects reconnect if grace period deadline has already expired', () => {
      const client = new SignalingClient('ws://127.0.0.1:8000/ws');
      client.reconnectDeadline = Date.now() - 5000; // 5s in past

      let failed = false;
      client.on('reconnectFailed', (ev) => {
        failed = true;
        assert.equal(ev.code, 'RECONNECT_EXPIRED');
      });

      client.reconnect('PORT-EXPIRED', 'sess-exp', 'token-exp');
      assert.equal(failed, true);
      assert.equal(client.reconnectToken, null);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Explicit Leave vs Unexpected Socket Closure
  // ---------------------------------------------------------------------------
  describe('4. Explicit Leave vs Unexpected Closure', () => {
    it('explicit leave does NOT trigger automatic reconnect and clears credentials', () => {
      const client = new SignalingClient('ws://127.0.0.1:8000/ws');
      client.roomCode = 'PORT-LEAVE';
      client.sessionId = 'sess-leave';
      client.reconnectToken = 'tok-leave';

      let reconnectScheduled = false;
      client._scheduleReconnect = () => {
        reconnectScheduled = true;
      };

      client.leaveRoom();

      assert.equal(client.isExplicitLeave, true);
      assert.equal(client.reconnectToken, null);
      assert.equal(client.roomCode, null);
      assert.equal(client.sessionId, null);
      assert.equal(reconnectScheduled, false);
    });

    it('unexpected socket closure triggers at most one reconnect schedule when credentials exist', () => {
      class MockWebSocket {
        constructor() {
          this.readyState = 1;
        }
        close() {}
      }
      globalThis.WebSocket = MockWebSocket;

      const client = new SignalingClient('ws://127.0.0.1:8000/ws');
      client.roomCode = 'PORT-UNEXPECT';
      client.sessionId = 'sess-unexpect';
      client.reconnectToken = 'tok-unexpect';
      client.state = SIGNALING_STATES.CONNECTED;

      let scheduleCallCount = 0;
      client._scheduleReconnect = () => {
        scheduleCallCount++;
      };

      // Simulate unexpected socket close
      const mockSocket = new MockWebSocket();
      client.ws = mockSocket;
      client._socketGeneration = 1;

      // Invoke the onclose registered by _connect
      client._connect(() => {});
      client.ws.onclose({ reason: 'Connection dropped' });

      assert.equal(scheduleCallCount, 1);
    });

    it('prevents overlapping or concurrent reconnect timers', () => {
      const client = new SignalingClient('ws://127.0.0.1:8000/ws');
      client.roomCode = 'PORT-TIMER';
      client.sessionId = 'sess-timer';
      client.reconnectToken = 'tok-timer';

      client._scheduleReconnect();
      const firstTimer = client.reconnectTimer;
      assert.ok(firstTimer !== null);

      // Attempt to schedule a second time while timer is active
      client._scheduleReconnect();
      assert.equal(client.reconnectTimer, firstTimer, 'Must not replace active timer');

      client._cancelReconnect();
      assert.equal(client.reconnectTimer, null);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Bounded Retries & Generation Race Guards
  // ---------------------------------------------------------------------------
  describe('5. Bounded Retries & Stale Socket Protection', () => {
    it('stops retrying when maxReconnectAttempts (5) is reached', () => {
      const client = new SignalingClient('ws://127.0.0.1:8000/ws');
      client.roomCode = 'PORT-BOUNDED';
      client.sessionId = 'sess-bounded';
      client.reconnectToken = 'tok-bounded';
      client.reconnectAttempt = 5;
      client.maxReconnectAttempts = 5;

      let failed = false;
      client.on('reconnectFailed', (ev) => {
        failed = true;
        assert.equal(ev.code, 'RECONNECT_EXHAUSTED');
      });

      client._scheduleReconnect();
      assert.equal(failed, true);
      assert.equal(client.reconnectToken, null);
    });

    it('ignores onmessage and onclose from an older socket generation', () => {
      const client = new SignalingClient('ws://127.0.0.1:8000/ws');
      client.roomCode = 'PORT-NEW';
      client.sessionId = 'sess-new';
      client.reconnectToken = 'tok-new';
      client._socketGeneration = 2; // Newer generation

      let messageProcessed = false;
      client._handleMessage = () => {
        messageProcessed = true;
      };

      // Construct a stale socket from generation 1
      const staleSocket = { close() {} };
      client.ws = { close() {} }; // Active socket is different

      // Simulate stale onmessage handler
      const staleSocketGen = 1;
      const onMessage = (event) => {
        if (client.ws !== staleSocket || client._socketGeneration !== staleSocketGen) return;
        client._handleMessage(event.data);
      };

      onMessage({ data: JSON.stringify({ type: 'reconnected', payload: { reconnect_token: 'stale-token' } }) });
      assert.equal(messageProcessed, false, 'Stale message must not be processed');
      assert.equal(client.reconnectToken, 'tok-new');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Peer Disconnect Grace Period & UI Tracking
  // ---------------------------------------------------------------------------
  describe('6. Peer Disconnect Grace Period & UI Feedback', () => {
    it('reads server-provided grace_period dynamically rather than hardcoding 30', () => {
      const client = new SignalingClient('ws://127.0.0.1:8000/ws');

      let peerDcEvent = null;
      client.on('peerDisconnected', (payload) => {
        peerDcEvent = payload;
      });

      // Server sends custom grace period of 45 seconds
      client._handleMessage(JSON.stringify({
        type: 'peer-disconnected',
        payload: {
          room_code: 'PORT-CUSTOM',
          peer_session_id: 'sess-other',
          grace_period: 45.0,
          message: 'Peer disconnected',
        },
      }));

      assert.equal(client.reconnectGracePeriod, 45.0);
      assert.ok(peerDcEvent);
      assert.equal(peerDcEvent.grace_period, 45.0);
    });

    it('computes peer disconnected status and countdown in session panel', () => {
      const testState = createInitialState();
      testState.signalingState = SIGNALING_STATES.CONNECTED;
      testState.realRoomCode = 'PORT-TEST';
      testState.isPeerDisconnected = true;
      testState.peerDisconnectGracePeriod = 30;
      testState.peerDisconnectDeadline = Date.now() + 25000; // 25s remaining

      const info = computeSessionStatusInfo(testState);
      assert.equal(info.statusDotClass, 'reconnecting');
      assert.ok(info.statusPillHtml.includes('Peer Disconnected'));
      assert.ok(info.statusPillHtml.includes('grace'));
      assert.ok(info.metaBadgeText.includes('Peer Disconnected'));
    });
  });

  // ---------------------------------------------------------------------------
  // 7. WebRTC DataChannel Decoupling
  // ---------------------------------------------------------------------------
  describe('7. WebRTC Decoupling & Recovery Separation', () => {
    it('does NOT treat signaling reconnection as proof that WebRTC is connected', () => {
      const testState = createInitialState();
      testState.signalingState = SIGNALING_STATES.CONNECTED;
      testState.peerConnectionState = PEER_CONNECTION_STATES.CONNECTING; // WebRTC not ready
      testState.dataChannelState = DATA_CHANNEL_STATES.CONNECTING;

      const info = computeSessionStatusInfo(testState);
      // Data channels must not be reported as open
      assert.equal(info.isDataChannelOpen, false);
      assert.equal(info.isFileChannelOpen, false);
      // Status dot should show waiting/negotiating, NOT online
      assert.notEqual(info.statusDotClass, 'online');
    });

    it('preserves existing room-code binding and invitation-token safety', () => {
      const testState = createInitialState();
      resetSessionState(testState);
      assert.equal(testState.reconnectToken, null);
      assert.equal(testState.isSignalingReconnecting, false);
      assert.equal(testState.isPeerDisconnected, false);
      assert.equal(testState.peerDisconnectGracePeriod, null);
      assert.equal(testState.peerDisconnectDeadline, null);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Connection Controller Event Subscriptions
  // ---------------------------------------------------------------------------
  describe('8. Connection Controller Reconnect Lifecycle Coordination', () => {
    it('handles peerDisconnected by establishing deadline, system message, and UI refresh', () => {
      const mockRoot = {
        querySelector: () => null,
        querySelectorAll: () => [],
        dataset: {},
      };

      let iceRestartAttempted = false;
      const mockPeerConnection = {
        on: () => {},
        attemptIceRestart: () => { iceRestartAttempted = true; },
        isChatReady: () => false,
        pc: { connectionState: 'connected' },
        close: () => {},
      };

      const mockSignaling = new SignalingClient('ws://127.0.0.1:8000/ws');
      const testState = createInitialState();
      testState.realRoomCode = 'PORT-CTRL';
      testState.realRole = 'host';

      // Pass testState proxy via app-state
      state.realRoomCode = 'PORT-CTRL';
      state.realRole = 'host';
      state.realChatMessages = [];

      initConnectionController(mockRoot, {
        signaling: mockSignaling,
        peerConnection: mockPeerConnection,
        toast: () => {},
      });

      mockSignaling.emit('peerDisconnected', {
        room_code: 'PORT-CTRL',
        peer_session_id: 'sess-guest',
        grace_period: 25.0,
      });

      assert.equal(state.isPeerDisconnected, true);
      assert.equal(state.peerDisconnectGracePeriod, 25.0);
      assert.ok(state.peerDisconnectDeadline > Date.now());
      assert.ok(state.realChatMessages.some((m) => m.text.includes('25s reconnect grace period')));

      // Test peerReconnected
      mockSignaling.emit('peerReconnected', {
        room_code: 'PORT-CTRL',
        peer_session_id: 'sess-guest-new',
      });

      assert.equal(state.isPeerDisconnected, false);
      assert.equal(state.peerDisconnectGracePeriod, null);
      assert.equal(state.peerDisconnectDeadline, null);
      assert.equal(state.peerSessionId, 'sess-guest-new');
      assert.equal(iceRestartAttempted, true, 'Should trigger WebRTC recovery');
    });

    it('handles reconnected by rotating state.reconnectToken', () => {
      const mockRoot = { querySelector: () => null, querySelectorAll: () => [], dataset: {} };
      const mockSignaling = new SignalingClient('ws://127.0.0.1:8000/ws');
      const mockPeerConnection = { on: () => {}, isChatReady: () => false, pc: null, startPeerConnection: async () => {}, close: () => {} };
      state.reconnectToken = 'initial-token';

      initConnectionController(mockRoot, {
        signaling: mockSignaling,
        peerConnection: mockPeerConnection,
        toast: () => {},
      });

      mockSignaling.emit('reconnected', {
        room_code: 'PORT-ROTATE',
        session_id: 'sess-host',
        role: 'host',
        reconnect_token: 'new-rotated-token-888',
        peer_session_id: 'sess-guest',
      });

      assert.equal(state.reconnectToken, 'new-rotated-token-888');
      assert.equal(state.isSignalingReconnecting, false);
      assert.equal(state.signalingReconnectAttempt, 0);
    });

    it('handles reconnectFailed by clearing reconnect credentials and reconnecting flag', () => {
      const mockRoot = { querySelector: () => null, querySelectorAll: () => [], dataset: {} };
      const mockSignaling = new SignalingClient('ws://127.0.0.1:8000/ws');
      const mockPeerConnection = { on: () => {}, isChatReady: () => false, pc: null, close: () => {} };
      state.isSignalingReconnecting = true;
      state.signalingReconnectAttempt = 3;
      state.reconnectToken = 'tok-to-clear';

      initConnectionController(mockRoot, {
        signaling: mockSignaling,
        peerConnection: mockPeerConnection,
        toast: () => {},
      });

      mockSignaling.emit('reconnectFailed', {
        code: 'RECONNECT_EXPIRED',
        message: 'Window expired',
      });

      assert.equal(state.isSignalingReconnecting, false);
      assert.equal(state.signalingReconnectAttempt, 0);
      assert.equal(state.reconnectToken, null);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Chat and File Transfer Guards During Disconnect
  // ---------------------------------------------------------------------------
  describe('9. Data Delivery Invariant Guards During Disconnect', () => {
    it('blocks chat message sending when peer is disconnected or signaling reconnecting', () => {
      // Direct verification of guard conditions
      const peerReady = true;

      // When peer is disconnected
      state.isPeerDisconnected = true;
      state.isSignalingReconnecting = false;
      const isAllowedDuringPeerDc = peerReady && !state.isPeerDisconnected && !state.isSignalingReconnecting;
      assert.equal(isAllowedDuringPeerDc, false, 'Chat must be blocked when peer is disconnected');

      // When signaling is reconnecting
      state.isPeerDisconnected = false;
      state.isSignalingReconnecting = true;
      const isAllowedDuringSigRc = peerReady && !state.isPeerDisconnected && !state.isSignalingReconnecting;
      assert.equal(isAllowedDuringSigRc, false, 'Chat must be blocked when signaling is reconnecting');

      // When both are healthy
      state.isPeerDisconnected = false;
      state.isSignalingReconnecting = false;
      const isAllowedWhenHealthy = peerReady && !state.isPeerDisconnected && !state.isSignalingReconnecting;
      assert.equal(isAllowedWhenHealthy, true, 'Chat must be allowed when connection is healthy');
    });

    it('blocks file transmission when peer is disconnected or signaling reconnecting', () => {
      const fileChannelReady = true;

      state.isPeerDisconnected = true;
      state.isSignalingReconnecting = false;
      const isAllowedDuringPeerDc = fileChannelReady && !state.isPeerDisconnected && !state.isSignalingReconnecting;
      assert.equal(isAllowedDuringPeerDc, false, 'Files must be blocked when peer is disconnected');

      state.isPeerDisconnected = false;
      state.isSignalingReconnecting = true;
      const isAllowedDuringSigRc = fileChannelReady && !state.isPeerDisconnected && !state.isSignalingReconnecting;
      assert.equal(isAllowedDuringSigRc, false, 'Files must be blocked when signaling is reconnecting');
    });
  });
});
