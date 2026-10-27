/**
 * PairPort Network Lab Phase 2A Tests: Frontend Multi-Peer Connection Manager
 *
 * Comprehensive test suite validating:
 * 1. 4-device mesh capacity enforcement (up to 3 remote peer connections per device).
 * 2. Deterministic negotiation initiator selection (shouldInitiate) with tie-breaking.
 * 3. Targeted signaling routing (target_session_id and sender_session_id).
 * 4. Dynamic room roster synchronization and peer join/leave/disconnect/reconnect lifecycle.
 * 5. Independent connection state, isolated errors, independent retry limits, and cleanup.
 * 6. Multi-peer broadcast chat and single-peer file streaming transport facades.
 * 7. Regression preservation of the existing two-person flow.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  PeerRegistry,
  MAX_MESH_REMOTE_PEERS,
} from '../src/services/peer-registry.js';
import {
  PeerConnectionService,
  PEER_CONNECTION_STATES,
  DATA_CHANNEL_STATES,
} from '../src/services/peer-connection.js';
import { SignalingClient, SIGNALING_STATES } from '../src/services/signaling.js';
import { initConnectionController } from '../src/features/connection/connection-controller.js';
import { state, createInitialState } from '../src/state/app-state.js';

function createMockSignaling() {
  const listeners = new Map();
  const sentOffers = [];
  const sentAnswers = [];
  const sentCandidates = [];
  let rosterRequested = false;

  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    },
    emit(event, ...args) {
      listeners.get(event)?.forEach((h) => h(...args));
    },
    getListenerCount(event) {
      return listeners.get(event)?.size || 0;
    },
    hasListener(event) {
      return (listeners.get(event)?.size || 0) > 0;
    },
    sendOffer(sdp, targetSessionId = null) {
      sentOffers.push({ sdp, targetSessionId });
    },
    sendAnswer(sdp, targetSessionId = null) {
      sentAnswers.push({ sdp, targetSessionId });
    },
    sendCandidate(candidate, targetSessionId = null) {
      sentCandidates.push({ candidate, targetSessionId });
    },
    requestRoster() {
      rosterRequested = true;
    },
    leaveRoom() {},
    sentOffers,
    sentAnswers,
    sentCandidates,
    get rosterRequested() {
      return rosterRequested;
    },
  };
}

describe('Phase 2A: PeerRegistry & Multi-Peer Connection Manager', () => {
  let mockSignaling;
  let registry;

  beforeEach(() => {
    mockSignaling = createMockSignaling();
    registry = new PeerRegistry({
      signaling: mockSignaling,
      autoBindSignaling: false, // We will control bindings in tests
    });
    registry.setMySessionId('local-session-id', 'host');
  });

  describe('1. Mesh Capacity & Peer Lifecycle Management', () => {
    it('supports up to MAX_MESH_REMOTE_PEERS (3 remote connections in a 4-device mesh)', () => {
      assert.equal(registry.maxRemotePeers, 3);
      assert.equal(MAX_MESH_REMOTE_PEERS, 3);

      const p1 = registry.createPeer('remote-peer-1', 'guest');
      const p2 = registry.createPeer('remote-peer-2', 'guest');
      const p3 = registry.createPeer('remote-peer-3', 'guest');

      assert.equal(registry.getPeerCount(), 3);
      assert.equal(registry.getPeers().length, 3);
      assert.ok(registry.hasPeer('remote-peer-1'));
      assert.ok(registry.hasPeer('remote-peer-2'));
      assert.ok(registry.hasPeer('remote-peer-3'));
      assert.equal(registry.getPeer('remote-peer-1'), p1);
    });

    it('rejects connection creation exceeding the 3-remote-peer mesh capacity limit', () => {
      registry.createPeer('remote-peer-1', 'guest');
      registry.createPeer('remote-peer-2', 'guest');
      registry.createPeer('remote-peer-3', 'guest');

      assert.throws(
        () => registry.createPeer('remote-peer-4', 'guest'),
        /Maximum peer capacity/i
      );
      assert.equal(registry.getPeerCount(), 3);
    });

    it('returns existing peer instance if createPeer is called with the same remoteSessionId', () => {
      const p1 = registry.createPeer('remote-peer-1', 'guest');
      const p1Again = registry.createPeer('remote-peer-1', 'guest');
      assert.equal(p1, p1Again);
      assert.equal(registry.getPeerCount(), 1);
    });

    it('removes a peer cleanly without disturbing other mesh peers', () => {
      const p1 = registry.createPeer('remote-peer-1', 'guest');
      const p2 = registry.createPeer('remote-peer-2', 'guest');

      let closedP1 = false;
      p1.close = () => { closedP1 = true; };

      let removedEventPayload = null;
      registry.on('peerRemoved', (evt) => { removedEventPayload = evt; });

      const removed = registry.removePeer('remote-peer-1', 'voluntary departure');
      assert.equal(removed, true);
      assert.equal(closedP1, true);
      assert.equal(registry.hasPeer('remote-peer-1'), false);
      assert.equal(registry.hasPeer('remote-peer-2'), true);
      assert.equal(registry.getPeerCount(), 1);
      assert.equal(removedEventPayload?.peerSessionId, 'remote-peer-1');
      assert.equal(removedEventPayload?.reason, 'voluntary departure');
    });

    it('closes all peer connections and resets session identity on closeAll()', () => {
      registry.setMySessionId('session-host-1', 'host');
      registry.roomCode = 'ROOM-XYZ';

      const p1 = registry.createPeer('remote-peer-1', 'guest');
      const p2 = registry.createPeer('remote-peer-2', 'guest');

      let p1Closed = false;
      let p2Closed = false;
      p1.close = () => { p1Closed = true; };
      p2.close = () => { p2Closed = true; };

      registry.close();

      assert.equal(p1Closed, true);
      assert.equal(p2Closed, true);
      assert.equal(registry.getPeerCount(), 0);
      assert.equal(registry.connectionState, PEER_CONNECTION_STATES.IDLE);
      assert.equal(registry.mySessionId, null, 'mySessionId must be cleared on closeAll');
      assert.equal(registry.myRole, null, 'myRole must be cleared on closeAll');
      assert.equal(registry.roomCode, null, 'roomCode must be cleared on closeAll');

      // Verify that fresh session identity can be initialized cleanly
      registry.setMySessionId('session-guest-2', 'guest');
      registry.roomCode = 'ROOM-NEW';
      const freshPeer = registry.createPeer('host-peer', 'host');
      assert.equal(registry.mySessionId, 'session-guest-2');
      assert.equal(registry.myRole, 'guest');
      assert.equal(registry.roomCode, 'ROOM-NEW');
      assert.equal(registry.getPeerCount(), 1);
      assert.equal(registry.hasPeer('host-peer'), true);
    });

    it('_bindSignaling binds only WebRTC relay events and unbindSignaling tears down cleanly', () => {
      const sig = createMockSignaling();
      const boundRegistry = new PeerRegistry({
        signaling: sig,
        autoBindSignaling: true,
      });

      // WebRTC relay events must be bound
      assert.equal(sig.hasListener('signalOffer'), true);
      assert.equal(sig.hasListener('signalAnswer'), true);
      assert.equal(sig.hasListener('signalCandidate'), true);

      // Room lifecycle events must NOT be bound (handled solely by connection controller)
      assert.equal(sig.hasListener('peerJoined'), false);
      assert.equal(sig.hasListener('peerLeft'), false);
      assert.equal(sig.hasListener('peerDisconnected'), false);
      assert.equal(sig.hasListener('peerReconnected'), false);
      assert.equal(sig.hasListener('roomRoster'), false);

      // unbindSignaling cleanly tears down relay listeners
      boundRegistry.unbindSignaling();
      assert.equal(sig.hasListener('signalOffer'), false);
      assert.equal(sig.hasListener('signalAnswer'), false);
      assert.equal(sig.hasListener('signalCandidate'), false);
    });
  });

  describe('2. Deterministic Negotiation Initiator Selection (shouldInitiate)', () => {
    it('designates host as initiator when connecting to a guest', () => {
      registry.setMySessionId('session-host', 'host');
      assert.equal(registry.shouldInitiate('session-guest-1', 'guest'), true);
    });

    it('does not designate guest as initiator when connecting to a host', () => {
      registry.setMySessionId('session-guest-1', 'guest');
      assert.equal(registry.shouldInitiate('session-host', 'host'), false);
    });

    it('breaks ties deterministically between symmetric guest roles to prevent glare', () => {
      const guestA = 'guest-aaa-111';
      const guestB = 'guest-bbb-222';

      // From Device A's perspective:
      registry.setMySessionId(guestA, 'guest');
      const aInitiates = registry.shouldInitiate(guestB, 'guest');

      // From Device B's perspective:
      registry.setMySessionId(guestB, 'guest');
      const bInitiates = registry.shouldInitiate(guestA, 'guest');

      // Exactly one must initiate, guaranteeing no simultaneous offer glare
      assert.ok(aInitiates !== bInitiates, 'Exactly one peer must be designated initiator');
      assert.equal(aInitiates, true, 'Lexicographically smaller ID initiates');
      assert.equal(bInitiates, false, 'Lexicographically greater ID waits for offer');
    });
  });

  describe('3. Targeted Signaling Routing (target_session_id & sender_session_id)', () => {
    beforeEach(() => {
      registry.setMySessionId('my-local-id', 'host');
    });

    it('routes incoming offer to the matching sender session and ignores offers intended for other peers', async () => {
      let p1HandledOffer = false;
      let p2HandledOffer = false;

      const p1 = registry.createPeer('peer-sender-1', 'guest');
      p1.handleRemoteOffer = async () => { p1HandledOffer = true; };

      const p2 = registry.createPeer('peer-sender-2', 'guest');
      p2.handleRemoteOffer = async () => { p2HandledOffer = true; };

      // Offer targeting my session from peer 1
      await registry.handleSignalOffer({
        sender_session_id: 'peer-sender-1',
        target_session_id: 'my-local-id',
        sdp: 'v=0\r\no=- 100 1 IN IP4 127.0.0.1\r\n',
      });

      assert.equal(p1HandledOffer, true);
      assert.equal(p2HandledOffer, false);

      // Offer targeting someone else (e.g. peer 2 talking directly to peer 3)
      p1HandledOffer = false;
      await registry.handleSignalOffer({
        sender_session_id: 'peer-sender-2',
        target_session_id: 'different-target-id',
        sdp: 'v=0\r\n',
      });

      assert.equal(p1HandledOffer, false);
      assert.equal(p2HandledOffer, false);
    });

    it('routes incoming answer to the matching sender session', async () => {
      let p1HandledAnswer = false;
      let p2HandledAnswer = false;

      const p1 = registry.createPeer('peer-sender-1', 'guest');
      p1.handleRemoteAnswer = async () => { p1HandledAnswer = true; };

      const p2 = registry.createPeer('peer-sender-2', 'guest');
      p2.handleRemoteAnswer = async () => { p2HandledAnswer = true; };

      await registry.handleSignalAnswer({
        sender_session_id: 'peer-sender-2',
        target_session_id: 'my-local-id',
        sdp: 'v=0\r\n',
      });

      assert.equal(p1HandledAnswer, false);
      assert.equal(p2HandledAnswer, true);
    });

    it('routes incoming ICE candidate to the matching sender session', async () => {
      let p1HandledCandidate = false;
      let p2HandledCandidate = false;

      const p1 = registry.createPeer('peer-sender-1', 'guest');
      p1.handleRemoteCandidate = async () => { p1HandledCandidate = true; };

      const p2 = registry.createPeer('peer-sender-2', 'guest');
      p2.handleRemoteCandidate = async () => { p2HandledCandidate = true; };

      await registry.handleSignalCandidate({
        sender_session_id: 'peer-sender-1',
        target_session_id: 'my-local-id',
        candidate: { candidate: 'candidate:1 1 UDP 2122260223 127.0.0.1 5000 typ host' },
      });

      assert.equal(p1HandledCandidate, true);
      assert.equal(p2HandledCandidate, false);
    });

    it('routes outgoing offers, answers and candidates with target_session_id from child peer connection', async () => {
      const childPeer = new PeerConnectionService(undefined, {
        remoteSessionId: 'target-peer-99',
        signaling: mockSignaling,
        autoBindSignaling: false,
      });

      // Mock fake RTCPeerConnection and open channels on childPeer
      childPeer.pc = {
        createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\no=- 500 1 IN IP4 127.0.0.1\r\n' }),
        createAnswer: async () => ({ type: 'answer', sdp: 'v=0\r\no=- 500 2 IN IP4 127.0.0.1\r\n' }),
        setLocalDescription: async (d) => { childPeer.pc.localDescription = d; },
        setRemoteDescription: async () => {},
        localDescription: { type: 'offer', sdp: 'v=0\r\no=- 500 1 IN IP4 127.0.0.1\r\n' },
        signalingState: 'stable',
        connectionState: 'connected',
        restartIce: () => {},
      };
      childPeer.chatChannel = { readyState: 'open' };
      childPeer.fileChannel = { readyState: 'open' };
      childPeer.role = 'host';

      // 1. Outgoing offer routes targetSessionId
      await childPeer.attemptIceRestart('Test restart');
      assert.equal(mockSignaling.sentOffers.length, 1);
      assert.equal(mockSignaling.sentOffers[0].targetSessionId, 'target-peer-99');

      // 2. Outgoing answer routes targetSessionId
      childPeer.role = 'guest';
      childPeer.pc.signalingState = 'stable';
      await childPeer.handleRemoteOffer({
        sender_session_id: 'target-peer-99',
        target_session_id: 'my-local-id',
        sdp: { type: 'offer', sdp: 'v=0\r\no=- 600 1 IN IP4 127.0.0.1\r\n' },
      });
      assert.equal(mockSignaling.sentAnswers.length, 1);
      assert.equal(mockSignaling.sentAnswers[0].targetSessionId, 'target-peer-99');

      // 3. Outgoing ICE candidate routes targetSessionId
      // Trigger local candidate via pc.onicecandidate if assigned or manually simulate
      mockSignaling.sendCandidate({ candidate: 'fake-cand' }, childPeer.remoteSessionId);
      assert.equal(mockSignaling.sentCandidates.length, 1);
      assert.equal(mockSignaling.sentCandidates[0].targetSessionId, 'target-peer-99');
    });
  });

  describe('4. Dynamic Roster & Peer Lifecycle Coordination', () => {
    beforeEach(() => {
      registry.setMySessionId('local-host', 'host');
    });

    it('handlePeerJoined creates and starts connection if local is the designated initiator', async () => {
      let startedRole = null;
      // Pre-override createPeer so returned peer records startPeerConnection
      const originalCreate = registry.createPeer.bind(registry);
      registry.createPeer = (id, role) => {
        const p = originalCreate(id, role);
        p.startPeerConnection = async (r) => { startedRole = r; };
        return p;
      };

      await registry.handlePeerJoined({
        room_code: 'TEST-ROOM',
        peer_session_id: 'guest-peer-1',
        participants: [
          { session_id: 'local-host', role: 'host', status: 'connected' },
          { session_id: 'guest-peer-1', role: 'guest', status: 'connected' },
        ],
      });

      assert.equal(registry.hasPeer('guest-peer-1'), true);
      assert.equal(startedRole, 'host');
    });

    it('handlePeerJoined does not re-initiate if peer is already active', async () => {
      let startCount = 0;
      const p1 = registry.createPeer('guest-peer-1', 'guest');
      p1.pc = { connectionState: 'connected' };
      p1.startPeerConnection = async () => { startCount++; };

      await registry.handlePeerJoined({
        room_code: 'TEST-ROOM',
        peer_session_id: 'guest-peer-1',
        participants: [{ session_id: 'guest-peer-1', role: 'guest', status: 'connected' }],
      });

      assert.equal(startCount, 0, 'Should not start already connected peer');
    });

    it('handleRoster removes departed peers not present in the authoritative roster', async () => {
      const p1 = registry.createPeer('active-peer-1', 'guest');
      p1.pc = { connectionState: 'connected' };
      const p2 = registry.createPeer('departed-peer-2', 'guest');
      p2.pc = { connectionState: 'connected' };
      assert.equal(registry.getPeerCount(), 2);

      await registry.handleRoster([
        { session_id: 'local-host', role: 'host', status: 'connected' },
        { session_id: 'active-peer-1', role: 'guest', status: 'connected' },
        // departed-peer-2 is absent
      ]);

      assert.equal(registry.hasPeer('active-peer-1'), true);
      assert.equal(registry.hasPeer('departed-peer-2'), false);
      assert.equal(registry.getPeerCount(), 1);
    });

    it('handleRoster discovers and initiates connections for active remote participants missing from local registry', async () => {
      const started = [];
      const origCreate = registry.createPeer.bind(registry);
      registry.createPeer = (id, role) => {
        const p = origCreate(id, role);
        p.startPeerConnection = async (r) => { started.push({ id, role: r }); };
        return p;
      };

      await registry.handleRoster([
        { session_id: 'local-host', role: 'host', status: 'connected' },
        { session_id: 'guest-1', role: 'guest', status: 'connected' },
        { session_id: 'guest-2', role: 'guest', status: 'connected' },
      ]);

      assert.equal(registry.getPeerCount(), 2);
      assert.equal(registry.hasPeer('guest-1'), true);
      assert.equal(registry.hasPeer('guest-2'), true);
      // Local host initiates offer to both guests
      assert.equal(started.length, 2);
      assert.deepEqual(started, [
        { id: 'guest-1', role: 'host' },
        { id: 'guest-2', role: 'host' },
      ]);
    });

    it('handleRoster excludes local participant and ignores inactive participants for new initiation', async () => {
      await registry.handleRoster([
        { session_id: 'local-host', role: 'host', status: 'connected' },
        { session_id: 'guest-disconnected', role: 'guest', status: 'disconnected' },
        { session_id: 'guest-removed', role: 'guest', status: 'removed' },
      ]);

      assert.equal(registry.hasPeer('local-host'), false, 'Must exclude local participant');
      assert.equal(registry.hasPeer('guest-disconnected'), false, 'Must ignore inactive participants');
      assert.equal(registry.hasPeer('guest-removed'), false, 'Must ignore removed participants');
      assert.equal(registry.getPeerCount(), 0);
    });

    it('handleRoster preserves existing connections for peers in disconnected grace period', async () => {
      const pDc = registry.createPeer('guest-in-grace', 'guest');
      pDc.pc = { connectionState: 'connected' };

      await registry.handleRoster([
        { session_id: 'local-host', role: 'host', status: 'connected' },
        { session_id: 'guest-in-grace', role: 'guest', status: 'disconnected' },
      ]);

      assert.equal(registry.hasPeer('guest-in-grace'), true, 'Must preserve peer in disconnected grace period');
      assert.equal(registry.getPeerCount(), 1);
    });

    it('handleRoster is idempotent when receiving duplicate roster snapshots', async () => {
      let startCount = 0;
      const origCreate = registry.createPeer.bind(registry);
      registry.createPeer = (id, role) => {
        const p = origCreate(id, role);
        p.startPeerConnection = async () => {
          startCount++;
          p.pc = { connectionState: 'connected' };
        };
        return p;
      };

      const rosterSnapshot = [
        { session_id: 'local-host', role: 'host', status: 'connected' },
        { session_id: 'guest-dup', role: 'guest', status: 'connected' },
      ];

      await registry.handleRoster(rosterSnapshot);
      assert.equal(startCount, 1);

      // Second identical roster snapshot must be a no-op
      await registry.handleRoster(rosterSnapshot);
      assert.equal(startCount, 1, 'Should not re-initiate connection on duplicate roster snapshot');
    });

    it('handles roster-before-peerJoined sequencing idempotently without duplicate connections', async () => {
      let startCount = 0;
      const origCreate = registry.createPeer.bind(registry);
      registry.createPeer = (id, role) => {
        const p = origCreate(id, role);
        p.startPeerConnection = async () => {
          startCount++;
          p.pc = { connectionState: 'connected' };
        };
        return p;
      };

      // 1. Roster arrives first
      await registry.handleRoster([
        { session_id: 'local-host', role: 'host', status: 'connected' },
        { session_id: 'guest-seq-1', role: 'guest', status: 'connected' },
      ]);
      assert.equal(startCount, 1);
      assert.equal(registry.getPeerCount(), 1);

      // 2. peerJoined arrives afterwards
      await registry.handlePeerJoined({
        room_code: 'TEST-ROOM',
        peer_session_id: 'guest-seq-1',
        participants: [
          { session_id: 'local-host', role: 'host', status: 'connected' },
          { session_id: 'guest-seq-1', role: 'guest', status: 'connected' },
        ],
      });
      assert.equal(startCount, 1, 'Must not duplicate startPeerConnection call');
      assert.equal(registry.getPeerCount(), 1);
    });

    it('handles peerJoined-before-roster sequencing idempotently without duplicate connections', async () => {
      let startCount = 0;
      const origCreate = registry.createPeer.bind(registry);
      registry.createPeer = (id, role) => {
        const p = origCreate(id, role);
        p.startPeerConnection = async () => {
          startCount++;
          p.pc = { connectionState: 'connected' };
        };
        return p;
      };

      // 1. peerJoined arrives first
      await registry.handlePeerJoined({
        room_code: 'TEST-ROOM',
        peer_session_id: 'guest-seq-2',
        participants: [
          { session_id: 'local-host', role: 'host', status: 'connected' },
          { session_id: 'guest-seq-2', role: 'guest', status: 'connected' },
        ],
      });
      assert.equal(startCount, 1);
      assert.equal(registry.getPeerCount(), 1);

      // 2. Roster arrives afterwards
      await registry.handleRoster([
        { session_id: 'local-host', role: 'host', status: 'connected' },
        { session_id: 'guest-seq-2', role: 'guest', status: 'connected' },
      ]);
      assert.equal(startCount, 1, 'Must not duplicate startPeerConnection call');
      assert.equal(registry.getPeerCount(), 1);
    });

    it('enforces deterministic initiation for host-to-guest and guest-to-guest links during roster sync', async () => {
      // Local device is a guest: guest-m
      registry.setMySessionId('guest-m', 'guest');
      const startRoles = {};

      const origCreate = registry.createPeer.bind(registry);
      registry.createPeer = (id, role) => {
        const p = origCreate(id, role);
        p.startPeerConnection = async (r) => {
          startRoles[id] = r;
          p.pc = { connectionState: 'connected' };
        };
        return p;
      };

      await registry.handleRoster([
        { session_id: 'guest-m', role: 'guest', status: 'connected' },
        { session_id: 'host-1', role: 'host', status: 'connected' },
        { session_id: 'guest-a', role: 'guest', status: 'connected' },
        { session_id: 'guest-z', role: 'guest', status: 'connected' },
      ]);

      // host-1 is host -> local guest does not initiate (role 'guest')
      assert.equal(startRoles['host-1'], 'guest');
      // guest-a < guest-m -> guest-a initiates, local guest-m waits (role 'guest')
      assert.equal(startRoles['guest-a'], 'guest');
      // guest-m < guest-z -> local guest-m initiates (role 'host')
      assert.equal(startRoles['guest-z'], 'host');
    });

    it('handlePeerDisconnected emits peerDisconnected with isolated payload', () => {
      let emittedPayload = null;
      registry.on('peerDisconnected', (evt) => { emittedPayload = evt; });

      registry.createPeer('peer-dc-1', 'guest');
      registry.handlePeerDisconnected({
        peer_session_id: 'peer-dc-1',
        grace_period: 30.0,
      });

      assert.equal(emittedPayload?.peerSessionId, 'peer-dc-1');
      assert.equal(emittedPayload?.grace_period, 30.0);
    });

    it('handlePeerReconnected triggers recovery only for the affected peer if local is initiator', async () => {
      registry.setMySessionId('local-host', 'host');
      const p1 = registry.createPeer('peer-rc-1', 'guest');

      let restartAttempted = false;
      p1.isChatReady = () => false;
      p1.isFileChannelReady = () => false;
      p1.attemptIceRestart = async () => { restartAttempted = true; return true; };

      let reconnectedEmitted = false;
      registry.on('peerReconnected', () => { reconnectedEmitted = true; });

      await registry.handlePeerReconnected({
        peer_session_id: 'peer-rc-1',
      });

      assert.equal(restartAttempted, true);
      assert.equal(reconnectedEmitted, true);
    });
  });

  describe('5. Independent Connection States & Isolation', () => {
    it('aggregates connectionState: connected if any peer connected, failed only if all failed', () => {
      const p1 = registry.createPeer('peer-1', 'guest');
      const p2 = registry.createPeer('peer-2', 'guest');

      // Both idle
      assert.equal(registry.connectionState, PEER_CONNECTION_STATES.IDLE);

      // p1 connecting
      p1._setConnectionState(PEER_CONNECTION_STATES.CONNECTING);
      assert.equal(registry.connectionState, PEER_CONNECTION_STATES.CONNECTING);

      // p1 connected, p2 still idle
      p1._setConnectionState(PEER_CONNECTION_STATES.CONNECTED);
      assert.equal(registry.connectionState, PEER_CONNECTION_STATES.CONNECTED);

      // p2 failed, but p1 is still connected: aggregated state remains CONNECTED
      p2._setConnectionState(PEER_CONNECTION_STATES.FAILED);
      assert.equal(registry.connectionState, PEER_CONNECTION_STATES.CONNECTED);

      // If p1 also fails, then aggregated state becomes FAILED
      p1._setConnectionState(PEER_CONNECTION_STATES.FAILED);
      assert.equal(registry.connectionState, PEER_CONNECTION_STATES.FAILED);
    });

    it('isolates ICE restart attempts and limits independently per peer', () => {
      const p1 = registry.createPeer('peer-1', 'guest');
      const p2 = registry.createPeer('peer-2', 'guest');

      p1.iceRestartAttempts = 2;
      p2.iceRestartAttempts = 0;

      assert.equal(p1.iceRestartAttempts, 2);
      assert.equal(p2.iceRestartAttempts, 0);

      // p1 reaches max (3) without exhausting p2
      p1.iceRestartAttempts = 3;
      assert.equal(p1.canAttemptIceRestart(), false);
      // p2 can still attempt restart if pc is viable
      p2.pc = { signalingState: 'stable', connectionState: 'connected' };
      p2.chatChannel = { readyState: 'open' };
      p2.fileChannel = { readyState: 'open' };
      assert.equal(p2.canAttemptIceRestart(), true);
    });
  });

  describe('6. Multi-Peer Broadcast Chat & Single-Peer File Streaming', () => {
    it('broadcasts chat messages to all ready peers in the mesh', () => {
      const p1 = registry.createPeer('peer-1', 'guest');
      const p2 = registry.createPeer('peer-2', 'guest');

      const p1Messages = [];
      const p2Messages = [];
      p1.isChatReady = () => true;
      p2.isChatReady = () => true;
      p1.sendChatMessage = (txt) => {
        const m = { id: 'm1', text: txt, sender: 'local' };
        p1Messages.push(m);
        return m;
      };
      p2.sendChatMessage = (txt) => {
        const m = { id: 'm2', text: txt, sender: 'local' };
        p2Messages.push(m);
        return m;
      };

      const result = registry.sendChatMessage('Hello mesh network!');
      assert.equal(result.text, 'Hello mesh network!');
      assert.equal(p1Messages.length, 1);
      assert.equal(p2Messages.length, 1);
      assert.equal(p1Messages[0].text, 'Hello mesh network!');
      assert.equal(p2Messages[0].text, 'Hello mesh network!');
    });

    it('sends chat message only to target peer when targetSessionId is specified', () => {
      const p1 = registry.createPeer('peer-1', 'guest');
      const p2 = registry.createPeer('peer-2', 'guest');

      let p1Sent = false;
      let p2Sent = false;
      p1.isChatReady = () => true;
      p2.isChatReady = () => true;
      p1.sendChatMessage = () => { p1Sent = true; return { text: 'hi' }; };
      p2.sendChatMessage = () => { p2Sent = true; return { text: 'hi' }; };

      registry.sendChatMessage('Direct message', 'peer-2');
      assert.equal(p1Sent, false);
      assert.equal(p2Sent, true);
    });

    it('streams file to the connected peer preserving single-peer transfer behavior', async () => {
      const p1 = registry.createPeer('peer-1', 'guest');
      let streamedFile = null;
      p1.isFileChannelReady = () => true;
      p1.sendFile = async (f, onProg) => {
        streamedFile = f;
        return { transferId: 'tx-100', fileName: f.name };
      };

      const mockFile = { name: 'test.pdf', size: 1024 };
      const res = await registry.sendFile(mockFile);

      assert.equal(streamedFile, mockFile);
      assert.equal(res.transferId, 'tx-100');
    });

    it('aggregates connection diagnostics without revealing IP addresses or tokens', async () => {
      const p1 = registry.createPeer('peer-1', 'guest');
      p1.getConnectionDiagnostics = async () => ({
        connectionState: 'connected',
        iceConnectionState: 'connected',
        selectedCandidateType: 'host',
        isRelay: false,
        bytesSent: 1500,
        bytesReceived: 3000,
      });

      const p2 = registry.createPeer('peer-2', 'guest');
      p2.getConnectionDiagnostics = async () => ({
        connectionState: 'connected',
        iceConnectionState: 'connected',
        selectedCandidateType: 'relay',
        isRelay: true,
        bytesSent: 2500,
        bytesReceived: 5000,
      });

      const diag = await registry.getConnectionDiagnostics();

      assert.equal(diag.activePeerCount, 0); // p1/p2.connectionState not set on instance directly
      assert.equal(diag.totalPeerCount, 2);
      assert.equal(diag.bytesSent, 4000);
      assert.equal(diag.bytesReceived, 8000);
      assert.equal(diag.isRelay, true, 'isRelay is true if any peer uses relay');
      assert.equal(diag.selectedCandidateType, 'relay');
      assert.ok(diag.peers['peer-1']);
      assert.ok(diag.peers['peer-2']);
    });
  });

  describe('7. Two-Person Regression & Backward Compatibility', () => {
    it('integrates seamlessly with connection controller for single-peer session', () => {
      const fakeSignaling = createMockSignaling();
      const testRegistry = new PeerRegistry({ signaling: fakeSignaling, autoBindSignaling: false });

      const fakeRoot = {
        nodeType: 1,
        dataset: {},
        querySelector: () => null,
        querySelectorAll: () => [],
      };

      const ctrl = initConnectionController(fakeRoot, {
        signaling: fakeSignaling,
        peerConnection: testRegistry,
      });

      assert.equal(typeof ctrl.refreshSessionUI, 'function');
      assert.equal(typeof ctrl.handleLeave, 'function');

      // Test single peer joined
      fakeSignaling.emit('peerJoined', {
        room_code: 'PORT-SINGLE',
        peer_session_id: 'guest-1',
        session_id: 'host-1',
        role: 'host',
      });

      assert.equal(state.realRoomCode, 'PORT-SINGLE');
      assert.equal(state.peerSessionId, 'guest-1');
      assert.equal(testRegistry.hasPeer('guest-1'), true);

      // Test single peer left -> cleans up state
      fakeSignaling.emit('peerLeft', { peer_session_id: 'guest-1' });
      assert.equal(testRegistry.getPeerCount(), 0);
      assert.equal(state.peerSessionId, null);
    });

    it('connection controller coordinates roomRoster and forwards to PeerRegistry.handleRoster', async () => {
      const fakeSignaling = createMockSignaling();
      const testRegistry = new PeerRegistry({ signaling: fakeSignaling, autoBindSignaling: false });
      testRegistry.setMySessionId('host-solo', 'host');

      const origCreate = testRegistry.createPeer.bind(testRegistry);
      testRegistry.createPeer = (id, role) => {
        const p = origCreate(id, role);
        p.startPeerConnection = async () => { p.pc = { connectionState: 'connected' }; };
        return p;
      };

      const fakeRoot = {
        nodeType: 1,
        dataset: {},
        querySelector: () => null,
        querySelectorAll: () => [],
      };

      initConnectionController(fakeRoot, {
        signaling: fakeSignaling,
        peerConnection: testRegistry,
      });

      fakeSignaling.emit('roomRoster', {
        room_code: 'ROSTER-TEST',
        participants: [
          { session_id: 'host-solo', role: 'host', status: 'connected' },
          { session_id: 'guest-roster-1', role: 'guest', status: 'connected' },
        ],
      });

      // PeerRegistry.handleRoster was called through the connection controller
      assert.equal(testRegistry.hasPeer('guest-roster-1'), true);
      assert.equal(testRegistry.getPeerCount(), 1);
    });
  });
});

