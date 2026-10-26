/**
 * PairPort WebRTC Recovery Lifecycle & Renegotiation Hardening Tests (Step 9J-3B)
 *
 * Verifies:
 * - Deterministic ICE restart viability checks (DataChannel closed invariants)
 * - Safe symmetric renegotiation between host and guest (SDP session tracking)
 * - Bounded candidate queueing and FIFO draining
 * - Stale callback isolation across replaced peer connections
 * - Duplicate recovery trigger serialization
 * - Grace-period expiry and terminal failure cleanup
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PeerConnectionService,
  PEER_CONNECTION_STATES,
  DATA_CHANNEL_STATES,
  extractSdpSessionId,
  extractSdpSessionVersion,
} from '../src/services/peer-connection.js';
import { SignalingClient, SIGNALING_STATES } from '../src/services/signaling.js';
import { initConnectionController } from '../src/features/connection/connection-controller.js';
import { computeSessionStatusInfo } from '../src/features/connection/session-panel.js';
import { state, createInitialState } from '../src/state/app-state.js';

describe('WebRTC Recovery Lifecycle Hardening (Step 9J-3B)', () => {
  beforeEach(() => {
    state.realRoomCode = null;
    state.realRole = null;
    state.realChatMessages = [];
    state.realFiles = [];
    state.isSignalingReconnecting = false;
    state.isPeerDisconnected = false;
    state.isReconnecting = false;
  });

  describe('1. SDP Session & Version Parsing', () => {
    it('extracts session ID and version from valid RFC 4566/8866 SDP', () => {
      const sdp = [
        'v=0',
        'o=- 4829104820194820 2 IN IP4 127.0.0.1',
        's=-',
        't=0 0',
      ].join('\r\n');

      assert.equal(extractSdpSessionId(sdp), '4829104820194820');
      assert.equal(extractSdpSessionVersion(sdp), 2);
    });

    it('returns null when SDP is malformed or missing origin line', () => {
      assert.equal(extractSdpSessionId(''), null);
      assert.equal(extractSdpSessionId(null), null);
      assert.equal(extractSdpSessionId('v=0\r\ns=-\r\n'), null);
      assert.equal(extractSdpSessionVersion(''), null);
    });
  });

  describe('2. ICE Restart Viability & Closed DataChannel Invariants', () => {
    it('allows ICE restart on a recoverable connection with open channels', () => {
      const svc = new PeerConnectionService();
      svc.pc = {
        signalingState: 'stable',
        connectionState: 'connected',
        restartIce: () => {},
        createOffer: async () => ({ type: 'offer', sdp: 'o=- 100 1 IN IP4 127.0.0.1\r\n' }),
        setLocalDescription: async () => {},
        localDescription: { type: 'offer', sdp: 'o=- 100 1 IN IP4 127.0.0.1\r\n' },
      };
      svc.chatChannel = { readyState: 'open' };
      svc.fileChannel = { readyState: 'open' };

      assert.equal(svc.canAttemptIceRestart(), true);
    });

    it('refuses ICE restart when chatChannel is closed (RFC 8831 invariant)', async () => {
      const svc = new PeerConnectionService();
      svc.pc = {
        signalingState: 'stable',
        connectionState: 'connected',
      };
      svc.chatChannel = { readyState: 'closed' };
      svc.fileChannel = { readyState: 'open' };

      assert.equal(svc.canAttemptIceRestart(), false);
      const result = await svc.attemptIceRestart('test disruption');
      assert.equal(result, false, 'attemptIceRestart must return false when DataChannel is closed');
      assert.equal(svc.isRestartingIce, false);
    });

    it('refuses ICE restart when peer connection is failed or closed', async () => {
      const svc = new PeerConnectionService();
      svc.pc = {
        signalingState: 'closed',
        connectionState: 'failed',
      };
      svc.chatChannel = { readyState: 'open' };

      assert.equal(svc.canAttemptIceRestart(), false);
      const result = await svc.attemptIceRestart('failed pc');
      assert.equal(result, false);
    });
  });

  describe('3. Host and Guest Renegotiation Coordination', () => {
    it('guest re-initializes fresh RTCPeerConnection when receiving offer from a new session', async () => {
      const svc = new PeerConnectionService();
      let closeCalled = false;
      let startGuestCalled = false;

      svc.lastRemoteSdpSessionId = '10001';
      svc.lastRemoteSdpSessionVersion = 1;

      // Mock existing dead/old connection
      svc.pc = {
        signalingState: 'closed',
        connectionState: 'closed',
        setRemoteDescription: async () => {},
        createAnswer: async () => ({ type: 'answer', sdp: 'v=0' }),
        setLocalDescription: async () => {},
        localDescription: { type: 'answer', sdp: 'v=0' },
      };

      svc.close = () => { closeCalled = true; };
      svc.startPeerConnection = async (role) => {
        startGuestCalled = true;
        svc.pc = {
          signalingState: 'stable',
          connectionState: 'connecting',
          setRemoteDescription: async () => {},
          createAnswer: async () => ({ type: 'answer', sdp: 'v=0' }),
          setLocalDescription: async () => {},
          localDescription: { type: 'answer', sdp: 'v=0' },
        };
      };

      // Incoming offer with NEW session ID '20002'
      const newOfferPayload = {
        sdp: {
          type: 'offer',
          sdp: 'v=0\r\no=- 20002 1 IN IP4 127.0.0.1\r\ns=-\r\n',
        },
      };

      await svc.handleRemoteOffer(newOfferPayload);

      assert.equal(startGuestCalled, true, 'Guest must initialize fresh peer connection for new host session');
      assert.equal(svc.lastRemoteSdpSessionId, '20002');
      assert.equal(svc.lastRemoteSdpSessionVersion, 1);
    });

    it('guest applies ICE restart offer without resetting PC when session ID matches and version is incremented', async () => {
      const svc = new PeerConnectionService();
      let startGuestCalled = false;
      let remoteDescriptionSet = false;

      svc.lastRemoteSdpSessionId = '10001';
      svc.lastRemoteSdpSessionVersion = 1;

      svc.pc = {
        signalingState: 'stable',
        connectionState: 'connected',
        setRemoteDescription: async () => { remoteDescriptionSet = true; },
        createAnswer: async () => ({ type: 'answer', sdp: 'v=0' }),
        setLocalDescription: async () => {},
        localDescription: { type: 'answer', sdp: 'v=0' },
      };
      svc.chatChannel = { readyState: 'open' };
      svc.fileChannel = { readyState: 'open' };

      svc.startPeerConnection = async () => { startGuestCalled = true; };

      // Same session '10001', incremented version 2
      const restartOffer = {
        sdp: {
          type: 'offer',
          sdp: 'v=0\r\no=- 10001 2 IN IP4 127.0.0.1\r\ns=-\r\n',
        },
      };

      await svc.handleRemoteOffer(restartOffer);

      assert.equal(startGuestCalled, false, 'Guest must NOT reset healthy peer connection on in-session ICE restart');
      assert.equal(remoteDescriptionSet, true);
      assert.equal(svc.lastRemoteSdpSessionVersion, 2);
    });

    it('ignores duplicate or delayed offers with older or equal version for same session', async () => {
      const svc = new PeerConnectionService();
      let setRemoteDescriptionCount = 0;

      svc.lastRemoteSdpSessionId = '55555';
      svc.lastRemoteSdpSessionVersion = 3;

      svc.pc = {
        signalingState: 'stable',
        setRemoteDescription: async () => { setRemoteDescriptionCount++; },
      };

      // Delayed offer with version 2 (older than 3)
      await svc.handleRemoteOffer({
        sdp: { type: 'offer', sdp: 'v=0\r\no=- 55555 2 IN IP4 127.0.0.1\r\n' },
      });

      // Duplicate offer with version 3
      await svc.handleRemoteOffer({
        sdp: { type: 'offer', sdp: 'v=0\r\no=- 55555 3 IN IP4 127.0.0.1\r\n' },
      });

      assert.equal(setRemoteDescriptionCount, 0, 'Must ignore duplicate or delayed older offers');
    });
  });

  describe('4. ICE Candidate Queue Bounding & Stale Callback Isolation', () => {
    it('bounds pending candidates to 64 to prevent unbounded memory growth', async () => {
      const svc = new PeerConnectionService();
      svc.pc = null; // Forces queueing

      for (let i = 0; i < 80; i++) {
        await svc.handleRemoteCandidate({ candidate: { candidate: `cand-${i}` } });
      }

      assert.equal(svc.pendingCandidates.length, 64, 'Candidate queue must cap at maxPendingCandidates (64)');
      assert.equal(svc.pendingCandidates[0].candidate, 'cand-0');
      assert.equal(svc.pendingCandidates[63].candidate, 'cand-63');
    });

    it('isolates stale DataChannel callbacks from replaced connections', () => {
      const svc = new PeerConnectionService();
      svc._connectionGeneration = 1;

      let openEmitted = 0;
      svc.on('dataChannelOpen', () => { openEmitted++; });

      const mockOldChannel = {};
      svc._bindChatChannelEvents(mockOldChannel, 1);

      // Now connection is replaced: generation advances to 2
      svc._connectionGeneration = 2;

      // Stale event fires on old channel
      mockOldChannel.onopen();

      assert.equal(openEmitted, 0, 'Stale onopen callback from old generation must be ignored');
    });
  });

  describe('5. Duplicate Recovery Deduplication & Grace Period Expiry', () => {
    it('deduplicates concurrent recovery triggers', async () => {
      const mockRoot = { querySelector: () => null, querySelectorAll: () => [], dataset: {} };
      const signaling = new SignalingClient('ws://127.0.0.1:8000/ws');

      let attemptCount = 0;
      const mockPc = {
        on: () => {},
        isChatReady: () => false,
        isFileChannelReady: () => false,
        canAttemptIceRestart: () => true,
        attemptIceRestart: async () => {
          attemptCount++;
          // Simulate async delay
          await new Promise((r) => setTimeout(r, 10));
          return true;
        },
      };

      state.realRoomCode = 'PORT-DEDUP';
      state.realRole = 'host';

      initConnectionController(mockRoot, {
        signaling,
        peerConnection: mockPc,
        toast: () => {},
      });

      // Fire both triggers concurrently
      const p1 = signaling.emit('reconnected', {
        room_code: 'PORT-DEDUP',
        peer_session_id: 'peer-1',
        reconnect_token: 'tok-1',
      });
      const p2 = signaling.emit('peerReconnected', {
        room_code: 'PORT-DEDUP',
        peer_session_id: 'peer-1',
      });

      await Promise.all([p1, p2]);

      assert.equal(attemptCount, 1, 'Only one recovery attempt must run when triggered concurrently');
    });

    it('cleans up resources and marks state failed when reconnect grace period expires', () => {
      let closeCalled = false;
      let revokedUrl = null;

      const mockRoot = { querySelector: () => null, querySelectorAll: () => [], dataset: {} };
      const signaling = new SignalingClient('ws://127.0.0.1:8000/ws');
      const mockPc = {
        on: () => {},
        close: () => { closeCalled = true; },
        isChatReady: () => false,
      };

      const origRevoke = globalThis.URL?.revokeObjectURL;
      globalThis.URL = globalThis.URL || {};
      globalThis.URL.revokeObjectURL = (u) => { revokedUrl = u; };

      try {
        state.realRoomCode = 'PORT-EXP';
        state.realRole = 'guest';
        state.realFiles = [{ id: 'f1', blobUrl: 'blob:http://localhost/temp-file' }];

        initConnectionController(mockRoot, {
          signaling,
          peerConnection: mockPc,
          toast: () => {},
        });

        // Trigger peerDisconnected with 0.001s grace period (expires immediately)
        signaling.emit('peerDisconnected', {
          room_code: 'PORT-EXP',
          peer_session_id: 'peer-exp',
          grace_period: 0.001,
        });

        // Force deadline to past
        state.peerDisconnectDeadline = Date.now() - 1000;

        // Terminal error triggers failure cleanup
        signaling.emit('reconnectFailed', {
          message: 'Grace period expired.',
        });

        assert.equal(closeCalled, true, 'peerConnection.close() must be called on recovery failure');
        assert.equal(state.peerConnectionState, PEER_CONNECTION_STATES.FAILED);
        assert.equal(state.dataChannelState, DATA_CHANNEL_STATES.CLOSED);
        assert.equal(state.fileChannelState, DATA_CHANNEL_STATES.CLOSED);
        assert.equal(state.isPeerDisconnected, false);
        assert.ok(state.realChatMessages.some((m) => m.text.includes('Connection lost')));
      } finally {
        if (origRevoke) globalThis.URL.revokeObjectURL = origRevoke;
      }
    });
  });

  describe('6. Safe Diagnostics & Bounded Fresh Connection Recovery', () => {
    it('records candidate summary and state transitions without exposing IP addresses or tokens', async () => {
      const svc = new PeerConnectionService();
      svc._recordStateTransition('ConnectionState', 'connecting', 'connected');
      svc._recordStateTransition('ICEState', 'checking', 'connected');

      // Emulate candidate arrival with IP
      await svc.handleRemoteCandidate({
        candidate: {
          candidate: 'candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host',
          type: 'host',
          protocol: 'udp',
        },
      });

      const diag = await svc.getConnectionDiagnostics();

      assert.equal(diag.remoteCandidateTypes.includes('host/udp'), true);
      assert.equal(diag.hasRelayCandidate, false);
      assert.equal(diag.stateTransitions.length, 2);
      assert.equal(diag.stateTransitions[0].from, 'connecting');
      assert.equal(diag.stateTransitions[0].to, 'connected');

      const diagString = JSON.stringify(diag);
      assert.equal(diagString.includes('192.168.1.100'), false, 'Diagnostics must not expose raw IP addresses');
      assert.equal(diagString.includes('54321'), false, 'Diagnostics must not expose port numbers');
    });

    it('identifies relay candidates in diagnostics when present', async () => {
      const svc = new PeerConnectionService();
      await svc.handleRemoteCandidate({
        candidate: {
          candidate: 'candidate:2 1 UDP 33562367 198.51.100.1 3478 typ relay raddr 0.0.0.0 rport 0',
          type: 'relay',
          protocol: 'udp',
        },
      });

      const diag = await svc.getConnectionDiagnostics();
      assert.equal(diag.hasRelayCandidate, true);
      assert.equal(diag.hasRemoteRelay, true);
    });

    it('tracks whether PC was closed before restart was attempted', async () => {
      const svc = new PeerConnectionService();
      svc.pc = {
        signalingState: 'closed',
        connectionState: 'closed',
      };

      const result = await svc.attemptIceRestart('peer connection failed');
      assert.equal(result, false);
      assert.equal(svc.wasClosedBeforeRestart, true);

      const diag = await svc.getConnectionDiagnostics();
      assert.equal(diag.wasClosedBeforeRestart, true);
      assert.equal(diag.lastRestartReason, 'peer connection failed');
    });

    it('host initiates fresh negotiation when in-place restart is not viable and retries are within limit', async () => {
      const svc = new PeerConnectionService();
      svc.role = 'host';
      // PC is failed, so in-place restart is not viable under RFC 8831
      svc.pc = {
        signalingState: 'stable',
        connectionState: 'failed',
      };
      svc.chatChannel = { readyState: 'closed' };

      let freshNegotiationCalled = false;
      let passedRecoveryFlag = false;

      svc.startPeerConnection = async (role, isRecovery) => {
        freshNegotiationCalled = true;
        passedRecoveryFlag = isRecovery;
        svc.pc = {
          signalingState: 'stable',
          connectionState: 'connecting',
        };
      };

      const result = await svc.attemptIceRestart('Peer connection failed');
      assert.equal(result, true, 'Host should initiate fresh recovery negotiation');
      assert.equal(freshNegotiationCalled, true);
      assert.equal(passedRecoveryFlag, true);
      assert.equal(svc.iceRestartAttempts, 1);
    });

    it('guest awaits host fresh offer and increments attempt count without crashing', async () => {
      const svc = new PeerConnectionService();
      svc.role = 'guest';
      svc.pc = {
        signalingState: 'stable',
        connectionState: 'failed',
      };

      let reconnectEventEmitted = null;
      svc.on('reconnecting', (ev) => {
        reconnectEventEmitted = ev;
      });

      const result = await svc.attemptIceRestart('Peer connection failed');
      assert.equal(result, true);
      assert.equal(svc.iceRestartAttempts, 1);
      assert.ok(reconnectEventEmitted);
      assert.equal(reconnectEventEmitted.attempt, 1);
    });

    it('terminates recovery when maxIceRestartAttempts (3) is exhausted without infinite loops', async () => {
      const svc = new PeerConnectionService();
      svc.role = 'host';
      svc.iceRestartAttempts = 3;
      svc.pc = {
        signalingState: 'stable',
        connectionState: 'failed',
      };

      let terminalFailureEmitted = false;
      svc.on('terminalFailure', (ev) => {
        terminalFailureEmitted = true;
        assert.equal(ev.reason, 'EXHAUSTED_RETRIES');
      });

      const result = await svc.attemptIceRestart('Connection failure test');
      assert.equal(result, false, 'Must not restart when attempts are exhausted');
      assert.equal(terminalFailureEmitted, true);
      assert.equal(svc.connectionState, PEER_CONNECTION_STATES.FAILED);
    });

    it('session status info distinguishes retry exhaustion from initial connectivity failure', () => {
      const testState = createInitialState();
      testState.peerConnectionState = PEER_CONNECTION_STATES.FAILED;

      // 0 attempts - not exhausted yet
      testState.connectionDiagnostics = { reconnectAttempts: 0, maxReconnectAttempts: 3 };
      const info1 = computeSessionStatusInfo(testState);
      assert.ok(info1.statusPillHtml.includes('Direct connectivity unavailable'));
      assert.ok(!info1.statusPillHtml.includes('Retries exhausted'));

      // 3 attempts - retries exhausted
      testState.connectionDiagnostics = { reconnectAttempts: 3, maxReconnectAttempts: 3 };
      const info2 = computeSessionStatusInfo(testState);
      assert.ok(info2.statusPillHtml.includes('Retries exhausted'));
    });
  });
});
