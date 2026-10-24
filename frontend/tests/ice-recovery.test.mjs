/**
 * PairPort Phase 6 — Unit Tests for WebRTC ICE Negotiation, Recovery & Diagnostics
 * Covers:
 *  - ICE candidate queueing when remote description is missing/delayed
 *  - Candidate flushing in FIFO order once remote description is applied
 *  - Duplicate offer and invalid signaling state protection
 *  - Bounded ICE restart with max retry limits (3 attempts)
 *  - Terminal failure transition when retries are exhausted
 *  - In-flight file transfer cancellation on connection failure
 *  - Complete resource and timer cleanup on close()
 *  - Diagnostics getStats() parsing (Relay vs Direct) and IP masking
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PeerConnectionService,
  PEER_CONNECTION_STATES,
  TRANSFER_STATES,
} from '../src/services/peer-connection.js';

test('1. ICE Candidate Queueing & Flushing', async (t) => {
  await t.test('queues incoming candidates when remote description is not yet set', async () => {
    const service = new PeerConnectionService();
    // Mock pc without remote description
    service.pc = {
      remoteDescription: null,
      signalingState: 'have-local-offer',
      addIceCandidate: async () => {},
    };

    const cand1 = { candidate: 'candidate:1 1 UDP ...', sdpMid: '0', sdpMLineIndex: 0 };
    const cand2 = { candidate: 'candidate:2 1 UDP ...', sdpMid: '1', sdpMLineIndex: 1 };

    await service.handleRemoteCandidate({ candidate: cand1 });
    await service.handleRemoteCandidate({ candidate: cand2 });

    assert.equal(service.pendingCandidates.length, 2);
    assert.deepEqual(service.pendingCandidates[0], cand1);
    assert.deepEqual(service.pendingCandidates[1], cand2);
  });

  await t.test('flushes queued candidates in FIFO order when remote description is applied', async () => {
    const service = new PeerConnectionService();
    const appliedCandidates = [];

    // Mock global RTCIceCandidate for node environment
    const prevRTCIceCandidate = globalThis.RTCIceCandidate;
    globalThis.RTCIceCandidate = class {
      constructor(init) { Object.assign(this, init); }
    };

    try {
      service.pc = {
        remoteDescription: { type: 'offer', sdp: 'v=0...' },
        signalingState: 'stable',
        addIceCandidate: async (c) => {
          appliedCandidates.push(c.candidate);
        },
      };

      service.pendingCandidates = [
        { candidate: 'cand-first' },
        { candidate: 'cand-second' },
        { candidate: 'cand-third' },
      ];

      await service._drainPendingCandidates();

      assert.equal(service.pendingCandidates.length, 0);
      assert.deepEqual(appliedCandidates, ['cand-first', 'cand-second', 'cand-third']);
    } finally {
      globalThis.RTCIceCandidate = prevRTCIceCandidate;
    }
  });

  await t.test('continues draining remaining candidates if one candidate fails', async () => {
    const service = new PeerConnectionService();
    const applied = [];

    const prevRTCIceCandidate = globalThis.RTCIceCandidate;
    globalThis.RTCIceCandidate = class {
      constructor(init) { Object.assign(this, init); }
    };

    try {
      service.pc = {
        remoteDescription: { type: 'offer' },
        addIceCandidate: async (c) => {
          if (c.candidate === 'cand-corrupt') {
            throw new Error('Invalid candidate format');
          }
          applied.push(c.candidate);
        },
      };

      service.pendingCandidates = [
        { candidate: 'cand-1' },
        { candidate: 'cand-corrupt' },
        { candidate: 'cand-3' },
      ];

      await service._drainPendingCandidates();

      assert.equal(service.pendingCandidates.length, 0);
      assert.deepEqual(applied, ['cand-1', 'cand-3']);
    } finally {
      globalThis.RTCIceCandidate = prevRTCIceCandidate;
    }
  });
});

test('2. Signaling State & Duplicate Offer Guards', async (t) => {
  await t.test('host ignores remote offer when signaling state is not stable (glare protection)', async () => {
    const service = new PeerConnectionService();
    service.role = 'host';
    service.pc = {
      signalingState: 'have-local-offer',
      setRemoteDescription: async () => {
        throw new Error('Should not be called on offer collision');
      },
    };

    // Host receives unexpected offer while awaiting answer
    await service.handleRemoteOffer({
      sdp: { type: 'offer', sdp: 'v=0...' },
    });

    assert.equal(service.isProcessingDescription, false);
  });

  await t.test('ignores remote answer if not in have-local-offer state', async () => {
    const service = new PeerConnectionService();
    let setRemoteCalled = false;
    service.pc = {
      signalingState: 'stable',
      setRemoteDescription: async () => { setRemoteCalled = true; },
    };

    await service.handleRemoteAnswer({
      sdp: { type: 'answer', sdp: 'v=0...' },
    });

    assert.equal(setRemoteCalled, false);
  });
});

test('3. Bounded ICE Restart & Terminal Failure', async (t) => {
  await t.test('enforces idempotency: does not start concurrent competing restarts', async () => {
    const service = new PeerConnectionService();
    service.role = 'host';
    service.pc = {
      restartIce: () => {},
      createOffer: async () => ({ type: 'offer', sdp: 'v=0...' }),
      setLocalDescription: async () => {},
    };

    service.isRestartingIce = true;
    const initialAttempts = service.iceRestartAttempts;

    await service.attemptIceRestart('concurrent-call');
    assert.equal(service.iceRestartAttempts, initialAttempts);
  });

  await t.test('increments restart counter and emits reconnecting event', async () => {
    const service = new PeerConnectionService();
    service.role = 'host';
    service.pc = {
      restartIce: () => {},
      createOffer: async () => ({ type: 'offer', sdp: 'v=0...' }),
      setLocalDescription: async () => {},
      localDescription: { type: 'offer', sdp: 'v=0...' },
    };

    let emittedEvent = null;
    service.on('reconnecting', (info) => {
      emittedEvent = info;
    });

    await service.attemptIceRestart('test-drop');

    assert.equal(service.iceRestartAttempts, 1);
    assert.ok(emittedEvent);
    assert.equal(emittedEvent.attempt, 1);
    assert.equal(emittedEvent.maxAttempts, 3);
  });

  await t.test('transitions to FAILED and emits terminalFailure when retries reach limit', async () => {
    const service = new PeerConnectionService();
    service.iceRestartAttempts = 3;
    service.maxIceRestartAttempts = 3;
    service.pc = {};

    let terminalEvent = null;
    service.on('terminalFailure', (info) => {
      terminalEvent = info;
    });

    // Mock active file transfer
    service.activeTransfers.set('transfer-1', {
      id: 'transfer-1',
      status: TRANSFER_STATES.SENDING,
      error: null,
    });

    await service.attemptIceRestart('retry-exhausted');

    assert.equal(service.connectionState, PEER_CONNECTION_STATES.FAILED);
    assert.ok(terminalEvent);
    assert.equal(terminalEvent.reason, 'EXHAUSTED_RETRIES');

    // In-flight transfer must be failed
    const transfer = service.getTransfer('transfer-1');
    assert.equal(transfer.status, TRANSFER_STATES.FAILED);
    assert.ok(transfer.error.includes('exhausted'));
  });
});

test('4. Teardown & Resource Cleanup', async (t) => {
  await t.test('close() cleans up timers, reset restart counters, and clears state', () => {
    const service = new PeerConnectionService();
    service.iceDisconnectTimer = setTimeout(() => {}, 10000);
    service.iceRestartAttempts = 2;
    service.isRestartingIce = true;
    service.pendingCandidates = [{ candidate: 'c1' }];

    service.activeTransfers.set('t-1', {
      id: 't-1',
      status: TRANSFER_STATES.RECEIVING,
      blobUrl: 'blob:http://localhost/test-uuid',
    });

    // Mock global URL.revokeObjectURL
    let revokedUrl = null;
    const prevRevoke = globalThis.URL.revokeObjectURL;
    globalThis.URL.revokeObjectURL = (url) => { revokedUrl = url; };

    try {
      service.close();

      assert.equal(service.iceDisconnectTimer, null);
      assert.equal(service.iceRestartAttempts, 0);
      assert.equal(service.isRestartingIce, false);
      assert.equal(service.pendingCandidates.length, 0);
      assert.equal(service.connectionState, PEER_CONNECTION_STATES.IDLE);
      assert.equal(service.activeTransfers.size, 0);
      assert.equal(revokedUrl, 'blob:http://localhost/test-uuid');
    } finally {
      globalThis.URL.revokeObjectURL = prevRevoke;
    }
  });
});

test('5. Connection Diagnostics & Privacy Protection', async (t) => {
  await t.test('detects TURN relay from getStats() candidate pair and candidate reports', async () => {
    const service = new PeerConnectionService();

    // Mock RTCPeerConnection with stats
    service.pc = {
      connectionState: 'connected',
      iceConnectionState: 'connected',
      iceGatheringState: 'complete',
      signalingState: 'stable',
      getStats: async () => {
        const statsMap = new Map();
        statsMap.set('pair-1', {
          type: 'candidate-pair',
          selected: true,
          state: 'succeeded',
          localCandidateId: 'cand-local',
          remoteCandidateId: 'cand-remote',
          currentRoundTripTime: 0.045, // 45ms
          bytesSent: 1024,
          bytesReceived: 2048,
        });
        statsMap.set('cand-local', {
          id: 'cand-local',
          type: 'local-candidate',
          candidateType: 'relay', // TURN
          ip: '198.51.100.25', // Private/public IP that must not leak
          port: 54321,
        });
        statsMap.set('cand-remote', {
          id: 'cand-remote',
          type: 'remote-candidate',
          candidateType: 'srflx',
          ip: '203.0.113.10',
          port: 12345,
        });
        return statsMap;
      },
    };

    const diag = await service.getConnectionDiagnostics();

    assert.equal(diag.connectionState, 'connected');
    assert.equal(diag.isRelay, true);
    assert.equal(diag.selectedCandidateType, 'relay');
    assert.equal(diag.roundTripTimeMs, 45);
    assert.equal(diag.bytesSent, 1024);
    assert.equal(diag.bytesReceived, 2048);

    // Verify privacy: no raw IPs or ports in diagnostics object
    assert.equal(diag.ip, undefined);
    assert.equal(diag.port, undefined);
    assert.equal(diag.localIp, undefined);
    assert.equal(diag.remoteIp, undefined);
  });

  await t.test('detects Direct P2P (host / srflx) when no relay candidate is active', async () => {
    const service = new PeerConnectionService();
    service.pc = {
      connectionState: 'connected',
      iceConnectionState: 'connected',
      iceGatheringState: 'complete',
      signalingState: 'stable',
      getStats: async () => {
        const statsMap = new Map();
        statsMap.set('pair-1', {
          type: 'candidate-pair',
          selected: true,
          state: 'succeeded',
          localCandidateId: 'cand-local',
          remoteCandidateId: 'cand-remote',
          currentRoundTripTime: 0.012,
        });
        statsMap.set('cand-local', {
          id: 'cand-local',
          type: 'local-candidate',
          candidateType: 'srflx',
        });
        statsMap.set('cand-remote', {
          id: 'cand-remote',
          type: 'remote-candidate',
          candidateType: 'srflx',
        });
        return statsMap;
      },
    };

    const diag = await service.getConnectionDiagnostics();
    assert.equal(diag.isRelay, false);
    assert.equal(diag.selectedCandidateType, 'srflx');
    assert.equal(diag.roundTripTimeMs, 12);
  });
});
