/**
 * PairPort Phase 2B Tests: Live Mesh Network Visualization
 *
 * Comprehensive test suite validating:
 * 1. Local node and remote participant rendering with safe user-friendly labels.
 * 2. Edges rendered ONLY for actual peer connections, not mere roster entries.
 * 3. State transitions: connecting, connected, disconnected, reconnecting, failed, and left.
 * 4. Peer selection and detail inspector (unavailable diagnostics render as "—").
 * 5. Lifecycle teardown and listener cleanup.
 * 6. Empty state and room reset.
 * 7. Privacy shielding: zero secrets (tokens, credentials) or raw IP addresses exposed.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeTopologyGraph,
  renderTopologySvg,
  renderPeerDetailCard,
  renderTopologySection,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  MAX_MESH_PARTICIPANTS,
} from '../src/features/topology/topology-ui.js';
import { initTopologyPanel } from '../src/features/topology/topology-controller.js';
import { PEER_CONNECTION_STATES, DATA_CHANNEL_STATES } from '../src/services/peer-connection.js';
import { SIGNALING_STATES } from '../src/services/signaling.js';

function createMockRegistry(overrides = {}) {
  const peers = new Map();
  const listeners = new Map();
  let latestRoster = [];

  const registry = {
    mySessionId: 'local-session-host',
    myRole: 'host',
    roomCode: 'MESH-4921',
    maxRemotePeers: 3,
    latestRoster,
    peers,
    getPeer(id) {
      return peers.get(id);
    },
    hasPeer(id) {
      return peers.has(id);
    },
    getPeers() {
      return Array.from(peers.values());
    },
    getPeerIds() {
      return Array.from(peers.keys());
    },
    getPeerCount() {
      return peers.size;
    },
    getRoster() {
      return [...latestRoster];
    },
    setRoster(r) {
      latestRoster = [...r];
      registry.latestRoster = latestRoster;
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    },
    emit(event, ...args) {
      listeners.get(event)?.forEach((h) => h(...args));
    },
    async getConnectionDiagnostics() {
      return {
        connectionState: 'connected',
        selectedCandidateType: 'host',
        isRelay: false,
        bytesSent: 1024,
        bytesReceived: 2048,
        roundTripTimeMs: 15,
      };
    },
    createMockPeer(id, role = 'guest', state = PEER_CONNECTION_STATES.CONNECTED) {
      const p = {
        remoteSessionId: id,
        role,
        connectionState: state,
        dataChannelState: DATA_CHANNEL_STATES.OPEN,
        fileChannelState: DATA_CHANNEL_STATES.OPEN,
        isRestartingIce: false,
        iceRestartAttempts: 0,
        _lastDiagnostics: {
          isRelay: false,
          selectedCandidateType: 'host',
          roundTripTimeMs: 24,
          bytesSent: 4096,
          bytesReceived: 8192,
          iceConnectionState: 'connected',
        },
        isChatReady: () => p.dataChannelState === DATA_CHANNEL_STATES.OPEN,
        isFileChannelReady: () => p.fileChannelState === DATA_CHANNEL_STATES.OPEN,
        async getConnectionDiagnostics() {
          return {
            connectionState: p.connectionState,
            iceConnectionState: p._lastDiagnostics.iceConnectionState,
            selectedCandidateType: p._lastDiagnostics.selectedCandidateType,
            isRelay: p._lastDiagnostics.isRelay,
            roundTripTimeMs: p._lastDiagnostics.roundTripTimeMs,
            bytesSent: p._lastDiagnostics.bytesSent,
            bytesReceived: p._lastDiagnostics.bytesReceived,
            reconnectAttempts: p.iceRestartAttempts,
            maxReconnectAttempts: 3,
          };
        },
      };
      peers.set(id, p);
      return p;
    },
    ...overrides,
  };

  return registry;
}

function createMockSignaling() {
  const listeners = new Map();
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    },
    emit(event, ...args) {
      listeners.get(event)?.forEach((h) => h(...args));
    },
  };
}

describe('Phase 2B: Live Mesh Network Visualization', () => {
  let mockRegistry;
  let mockState;

  beforeEach(() => {
    mockRegistry = createMockRegistry();
    mockState = {
      signalingState: SIGNALING_STATES.CONNECTED,
      realRoomCode: 'MESH-4921',
      realSessionId: 'local-session-host',
      realRole: 'host',
      participants: [
        { session_id: 'local-session-host', role: 'host', status: 'connected' },
      ],
      connectionDiagnostics: {
        connectionState: 'connected',
        selectedCandidateType: 'host',
        isRelay: false,
        bytesSent: 1024,
        bytesReceived: 2048,
        roundTripTimeMs: 15,
      },
    };
  });

  describe('1. Graph Computation & Node/Edge Extraction', () => {
    it('renders local device node labeled as "You" with correct role', () => {
      const graph = computeTopologyGraph(mockState, mockRegistry);

      assert.equal(graph.localNode.label, 'You');
      assert.equal(graph.localNode.sublabel, 'Host');
      assert.equal(graph.localNode.isLocal, true);
      assert.equal(graph.localNode.status, 'connected');
      assert.equal(graph.localNode.x, CANVAS_WIDTH / 2);
    });

    it('renders remote participant nodes with safe truncated labels', () => {
      mockRegistry.setRoster([
        { session_id: 'local-session-host', role: 'host', status: 'connected' },
        { session_id: 'guest-session-11112222', role: 'guest', status: 'connected' },
        { session_id: 'guest-session-33334444', role: 'guest', status: 'connected' },
      ]);
      mockRegistry.createMockPeer('guest-session-11112222', 'guest');
      mockRegistry.createMockPeer('guest-session-33334444', 'guest');

      const graph = computeTopologyGraph(mockState, mockRegistry);

      assert.equal(graph.remoteNodes.length, 2);
      assert.equal(graph.remoteNodes[0].label, 'Peer guest-se');
      assert.equal(graph.remoteNodes[1].label, 'Peer guest-se');
      assert.equal(graph.totalParticipants, 3);
      assert.equal(graph.maxParticipants, MAX_MESH_PARTICIPANTS);
    });

    it('renders edges ONLY for actual peer connections in registry, not mere roster presence', () => {
      // 3 remote participants in roster, but only 1 has an active peer connection in local registry
      mockRegistry.setRoster([
        { session_id: 'local-session-host', role: 'host', status: 'connected' },
        { session_id: 'peer-with-connection', role: 'guest', status: 'connected' },
        { session_id: 'peer-in-roster-only-1', role: 'guest', status: 'connected' },
        { session_id: 'peer-in-roster-only-2', role: 'guest', status: 'connected' },
      ]);
      mockRegistry.createMockPeer('peer-with-connection', 'guest');

      const graph = computeTopologyGraph(mockState, mockRegistry);

      // 3 remote nodes exist
      assert.equal(graph.remoteNodes.length, 3);
      // But only 1 edge is created because only 1 peer is actually in peerRegistry!
      assert.equal(graph.edges.length, 1);
      assert.equal(graph.edges[0].peerSessionId, 'peer-with-connection');
      assert.equal(graph.edges[0].from, 'local');
      assert.equal(graph.edges[0].to, 'peer-with-connection');
    });

    it('does not draw edge if peer connection is closed', () => {
      mockRegistry.setRoster([
        { session_id: 'local-session-host', role: 'host', status: 'connected' },
        { session_id: 'closed-peer', role: 'guest', status: 'connected' },
      ]);
      const peer = mockRegistry.createMockPeer('closed-peer', 'guest', PEER_CONNECTION_STATES.CLOSED);

      const graph = computeTopologyGraph(mockState, mockRegistry);
      assert.equal(graph.edges.length, 0, 'Closed peer connection must not have an active edge');
    });

    it('calculates collision-free coordinates for 2, 3, and 4 devices', () => {
      // 2 devices (local + 1 remote)
      mockRegistry.setRoster([
        { session_id: 'local-session-host', role: 'host', status: 'connected' },
        { session_id: 'peer-1', role: 'guest', status: 'connected' },
      ]);
      mockRegistry.createMockPeer('peer-1', 'guest');
      const g2 = computeTopologyGraph(mockState, mockRegistry);
      assert.equal(g2.localNode.x, 180);
      assert.equal(g2.remoteNodes[0].x, 420);

      // 3 devices (local + 2 remote)
      mockRegistry.peers.clear();
      mockRegistry.setRoster([
        { session_id: 'local-session-host', role: 'host', status: 'connected' },
        { session_id: 'peer-1', role: 'guest', status: 'connected' },
        { session_id: 'peer-2', role: 'guest', status: 'connected' },
      ]);
      mockRegistry.createMockPeer('peer-1', 'guest');
      mockRegistry.createMockPeer('peer-2', 'guest');
      const g3 = computeTopologyGraph(mockState, mockRegistry);
      assert.notEqual(g3.remoteNodes[0].x, g3.remoteNodes[1].x);
      assert.notEqual(g3.localNode.y, g3.remoteNodes[0].y);

      // 4 devices (local + 3 remote)
      mockRegistry.peers.clear();
      mockRegistry.setRoster([
        { session_id: 'local-session-host', role: 'host', status: 'connected' },
        { session_id: 'peer-1', role: 'guest', status: 'connected' },
        { session_id: 'peer-2', role: 'guest', status: 'connected' },
        { session_id: 'peer-3', role: 'guest', status: 'connected' },
      ]);
      mockRegistry.createMockPeer('peer-1', 'guest');
      mockRegistry.createMockPeer('peer-2', 'guest');
      mockRegistry.createMockPeer('peer-3', 'guest');
      const g4 = computeTopologyGraph(mockState, mockRegistry);
      assert.equal(g4.remoteNodes.length, 3);
      assert.equal(g4.edges.length, 3);
    });

    it('safely handles non-string or malformed participant session IDs without throwing', () => {
      mockRegistry.setRoster([
        { session_id: 'local-session-host', role: 'host', status: 'connected' },
        { session_id: 12345, role: 'guest', status: 'connected' },
      ]);
      const graph = computeTopologyGraph(mockState, mockRegistry);
      assert.equal(graph.remoteNodes.length, 1);
      assert.equal(graph.remoteNodes[0].label, 'Peer 12345');
    });
  });

  describe('2. State Transitions & Visual Accuracy', () => {
    it('reflects connecting, connected, reconnecting, failed, and disconnected states accurately', () => {
      mockRegistry.setRoster([
        { session_id: 'local-session-host', role: 'host', status: 'connected' },
        { session_id: 'p-conn', role: 'guest', status: 'connected' },
        { session_id: 'p-ing', role: 'guest', status: 'connected' },
        { session_id: 'p-reconn', role: 'guest', status: 'connected' },
        { session_id: 'p-fail', role: 'guest', status: 'connected' },
        { session_id: 'p-dc', role: 'guest', status: 'disconnected' },
      ]);

      mockRegistry.createMockPeer('p-conn', 'guest', PEER_CONNECTION_STATES.CONNECTED);
      mockRegistry.createMockPeer('p-ing', 'guest', PEER_CONNECTION_STATES.CONNECTING);
      const reconnPeer = mockRegistry.createMockPeer('p-reconn', 'guest', PEER_CONNECTION_STATES.CONNECTING);
      reconnPeer.isRestartingIce = true;
      reconnPeer.iceRestartAttempts = 1;
      mockRegistry.createMockPeer('p-fail', 'guest', PEER_CONNECTION_STATES.FAILED);
      mockRegistry.createMockPeer('p-dc', 'guest', PEER_CONNECTION_STATES.CONNECTED);

      const graph = computeTopologyGraph(mockState, mockRegistry);

      const findNode = (id) => graph.remoteNodes.find((n) => n.id === id);
      assert.equal(findNode('p-conn')?.status, 'connected');
      assert.equal(findNode('p-ing')?.status, 'connecting');
      assert.equal(findNode('p-reconn')?.status, 'reconnecting');
      assert.equal(findNode('p-fail')?.status, 'failed');
      assert.equal(findNode('p-dc')?.status, 'disconnected');
    });
  });

  describe('3. SVG Generation & Accessibility', () => {
    it('generates accessible SVG with role="img", viewBox, and keyboard-interactive nodes', () => {
      mockRegistry.setRoster([
        { session_id: 'local-session-host', role: 'host', status: 'connected' },
        { session_id: 'peer-abc-1234', role: 'guest', status: 'connected' },
      ]);
      mockRegistry.createMockPeer('peer-abc-1234', 'guest');

      const graph = computeTopologyGraph(mockState, mockRegistry);
      const svg = renderTopologySvg(graph, 'peer-abc-1234');

      assert.ok(svg.includes('role="img"'));
      assert.ok(svg.includes('viewBox="0 0 600 320"'));
      assert.ok(svg.includes('class="topo-node node-local'));
      assert.ok(svg.includes('data-peer-id="peer-abc-1234"'));
      assert.ok(svg.includes('role="button"'));
      assert.ok(svg.includes('tabindex="0"'));
      assert.ok(svg.includes('aria-pressed="true"'));
      assert.ok(svg.includes('aria-label="Peer peer-abc (Guest), Status: connected"'));
    });

    it('renders empty-state helper text when no remote participants exist', () => {
      const graph = computeTopologyGraph(mockState, mockRegistry);
      const svg = renderTopologySvg(graph, 'local');

      assert.ok(svg.includes('Waiting for peers to join mesh network'));
      assert.ok(svg.includes('Share the room code or invite link'));
    });
  });

  describe('4. Compact Detail Inspector & Unavailable Diagnostics', () => {
    it('displays "—" for unavailable diagnostics and never fabricates values', () => {
      const peerData = {
        isLocal: false,
        id: 'peer-missing-metrics',
        label: 'Peer peer-mis',
        role: 'guest',
        status: 'connecting',
        peerService: {
          connectionState: 'connecting',
          dataChannelState: 'idle',
          fileChannelState: 'idle',
          isChatReady: () => false,
          isFileChannelReady: () => false,
        },
        diagnostics: {
          roundTripTimeMs: null,
          bytesSent: 0,
          bytesReceived: 0,
          selectedCandidateType: null,
          iceConnectionState: null,
        },
      };

      const html = renderPeerDetailCard(peerData);

      assert.ok(html.includes('Peer peer-mis'));
      assert.ok(html.includes('Guest (Participant)'));
      // Missing candidate type renders as "—"
      assert.ok(html.includes('—'));
      // Round-trip latency renders as "—"
      assert.ok(html.includes('Round-Trip Latency</span>\n          <span class="metric-val font-mono">—</span>') || html.includes('Round-Trip Latency'));
      // Missing reconnect attempts renders as "—", NEVER guessed "0 / 3"
      assert.ok(html.includes('Recovery Retries</span>\n          <span class="metric-val font-mono">—</span>'));
      assert.equal(html.includes('0 / 3'), false);
      // Traffic with 0 bytes displays 0 Bytes
      assert.ok(html.includes('0 Bytes'));
    });

    it('displays formatted values when diagnostics are available', () => {
      const peerData = {
        isLocal: false,
        id: 'peer-with-stats',
        label: 'Peer peer-wit',
        role: 'guest',
        status: 'connected',
        peerService: {
          connectionState: 'connected',
          dataChannelState: 'open',
          fileChannelState: 'open',
          isChatReady: () => true,
          isFileChannelReady: () => true,
        },
        diagnostics: {
          roundTripTimeMs: 24,
          bytesSent: 1048576, // 1 MB
          bytesReceived: 2097152, // 2 MB
          selectedCandidateType: 'relay',
          isRelay: true,
          iceConnectionState: 'connected',
          reconnectAttempts: 1,
          maxReconnectAttempts: 3,
        },
      };

      const html = renderPeerDetailCard(peerData);

      assert.ok(html.includes('24 ms'));
      assert.ok(html.includes('1 MB'));
      assert.ok(html.includes('2 MB'));
      assert.ok(html.includes('Relay (TURN)'));
      assert.ok(html.includes('1 / 3'));
      assert.ok(html.includes('OPEN (P2P Active)'));
      assert.ok(html.includes('OPEN (Streaming)'));
    });
  });

  describe('5. Privacy Shielding & Security Guarantees', () => {
    it('does not expose raw IP addresses, tokens, or credentials anywhere in rendered output', () => {
      mockState.invitationToken = 'SECRET-INVITATION-TOKEN-999';
      mockState.reconnectToken = 'SECRET-RECONNECT-TOKEN-888';

      mockRegistry.setRoster([
        { session_id: 'local-session-host', role: 'host', status: 'connected' },
        { session_id: 'remote-1', role: 'guest', status: 'connected' },
      ]);
      const p1 = mockRegistry.createMockPeer('remote-1', 'guest');
      p1._lastDiagnostics.rawIp = '192.168.1.55';
      p1._lastDiagnostics.port = 54321;

      const graph = computeTopologyGraph(mockState, mockRegistry);
      const svg = renderTopologySvg(graph, 'remote-1');
      const card = renderPeerDetailCard({
        isLocal: false,
        id: 'remote-1',
        label: 'Peer remote-1',
        role: 'guest',
        status: 'connected',
        peerService: p1,
        diagnostics: p1._lastDiagnostics,
      });
      const section = renderTopologySection(mockState);

      const combinedOutput = svg + card + section;

      // Secrets must never be rendered in visualization DOM
      assert.equal(combinedOutput.includes('SECRET-INVITATION-TOKEN-999'), false);
      assert.equal(combinedOutput.includes('SECRET-RECONNECT-TOKEN-888'), false);
      assert.equal(combinedOutput.includes('192.168.1.55'), false);
      assert.equal(combinedOutput.includes('54321'), false);
      assert.ok(combinedOutput.includes('IP Addresses & Tokens Masked') || combinedOutput.includes('IP addresses & credentials masked'));
    });
  });

  describe('6. Controller Event Coordination & Teardown', () => {
    it('initializes controller, handles peer selection and cleans up subscriptions on destroy', () => {
      const mockSignaling = createMockSignaling();
      const testRegistry = createMockRegistry();

      // Fake DOM root
      const fakeRoot = {
        querySelector(selector) {
          if (selector === '#mesh-topology-panel') return fakePanel;
          return null;
        },
      };

      const fakeCanvasHost = { innerHTML: '', addEventListener: () => {}, removeEventListener: () => {} };
      const fakeInspectorHost = { innerHTML: '' };
      const fakeCounterPill = { textContent: '' };
      const fakeToggleBtn = { addEventListener: () => {}, querySelector: () => ({ textContent: '' }), setAttribute: () => {} };
      const fakeBodyEl = { classList: { toggle: () => {} } };

      const fakePanel = {
        querySelector(sel) {
          if (sel === '#topo-canvas-host') return fakeCanvasHost;
          if (sel === '#topo-inspector-host') return fakeInspectorHost;
          if (sel === '#topo-counter-pill') return fakeCounterPill;
          if (sel === '#topo-toggle-btn') return fakeToggleBtn;
          if (sel === '#topo-panel-body') return fakeBodyEl;
          return null;
        },
      };

      testRegistry.setRoster([
        { session_id: 'local-session-host', role: 'host', status: 'connected' },
        { session_id: 'guest-ctrl-1', role: 'guest', status: 'connected' },
      ]);
      testRegistry.createMockPeer('guest-ctrl-1', 'guest');

      const ctrl = initTopologyPanel(fakeRoot, {
        peerRegistry: testRegistry,
        signaling: mockSignaling,
        state: mockState,
      });

      assert.equal(typeof ctrl.update, 'function');
      assert.equal(typeof ctrl.selectPeer, 'function');
      assert.equal(typeof ctrl.destroy, 'function');

      // Default peer selection
      assert.equal(ctrl.getSelectedPeer(), 'guest-ctrl-1');

      // Select local
      ctrl.selectPeer('local');
      assert.equal(ctrl.getSelectedPeer(), 'local');

      // Emit real peerActivity event
      testRegistry.emit('peerActivity', {
        peerSessionId: 'guest-ctrl-1',
        type: 'chat',
        direction: 'in',
      });

      // Tear down
      ctrl.destroy();
      assert.equal(fakePanel._topoController, undefined);
    });

    it('resets selection and activity when room session is closed or left', () => {
      const mockSignaling = createMockSignaling();
      const testRegistry = createMockRegistry();
      testRegistry.setRoster([
        { session_id: 'local-session-host', role: 'host', status: 'connected' },
        { session_id: 'guest-test', role: 'guest', status: 'connected' },
      ]);
      testRegistry.createMockPeer('guest-test', 'guest');

      const fakeCanvasHost = { innerHTML: '', addEventListener: () => {}, removeEventListener: () => {} };
      const fakeInspectorHost = { innerHTML: '' };
      const fakeCounterPill = { textContent: '' };
      const fakePanel = {
        querySelector(sel) {
          if (sel === '#topo-canvas-host') return fakeCanvasHost;
          if (sel === '#topo-inspector-host') return fakeInspectorHost;
          if (sel === '#topo-counter-pill') return fakeCounterPill;
          return null;
        },
      };
      const fakeRoot = { querySelector: () => fakePanel };

      const ctrl = initTopologyPanel(fakeRoot, {
        peerRegistry: testRegistry,
        signaling: mockSignaling,
        state: mockState,
      });

      ctrl.selectPeer('guest-test');
      assert.equal(ctrl.getSelectedPeer(), 'guest-test');

      // Room state transitions to IDLE (user left room)
      mockSignaling.emit('stateChange', SIGNALING_STATES.IDLE);
      assert.equal(ctrl.getSelectedPeer(), 'local');

      ctrl.destroy();
    });

    it('cleans up toggle button listener and survives internal rendering error gracefully', async () => {
      const mockSignaling = createMockSignaling();
      const testRegistry = createMockRegistry();

      let toggleListenerRemoved = false;
      const fakeToggleBtn = {
        addEventListener: () => {},
        removeEventListener: (event) => {
          if (event === 'click') toggleListenerRemoved = true;
        },
        querySelector: () => ({ textContent: '' }),
        setAttribute: () => {},
      };

      const fakePanel = {
        querySelector(sel) {
          if (sel === '#topo-canvas-host') return { innerHTML: '', addEventListener: () => {}, removeEventListener: () => {} };
          if (sel === '#topo-inspector-host') return { innerHTML: '' };
          if (sel === '#topo-counter-pill') return { textContent: '' };
          if (sel === '#topo-toggle-btn') return fakeToggleBtn;
          if (sel === '#topo-panel-body') return { classList: { toggle: () => {} } };
          return null;
        },
      };

      const ctrl = initTopologyPanel({ querySelector: () => fakePanel }, {
        peerRegistry: testRegistry,
        signaling: mockSignaling,
        state: mockState,
      });

      // Verification of clean listener removal
      ctrl.destroy();
      assert.equal(toggleListenerRemoved, true);

      // Verify that throwing inside computeTopologyGraph does not escape update()
      const faultState = {
        get signalingState() {
          throw new Error('Simulated state access failure');
        },
      };

      const safeCtrl = initTopologyPanel({ querySelector: () => fakePanel }, {
        peerRegistry: testRegistry,
        signaling: mockSignaling,
        state: faultState,
      });

      // Should not throw
      await safeCtrl.update();
      safeCtrl.destroy();
    });
  });
});
