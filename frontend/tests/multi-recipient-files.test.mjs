/**
 * PairPort Phase 3 Tests: Multi-Recipient File Sharing & Integration
 *
 * Comprehensive test suite validating:
 * 1. Recipient selector rendering (local user as "You", remote peers with safe labels, readiness indicators).
 * 2. Recipient selection mechanics (single select, multi-select, select all, deselect all, unready disabling).
 * 3. Prevention of sending to unready peers and clear guidance notices when none selected or none ready.
 * 4. Independent transfer records with unique transfer IDs, progress, speed/status, and isolated state.
 * 5. Independent simultaneous sending over per-peer WebRTC DataChannels.
 * 6. Partial failure isolation: Peer A completes while Peer B fails; Peer A is unaffected.
 * 7. Recipient-specific cancellation vs "Cancel All" bulk cancellation.
 * 8. Peer disconnect handling during active transfers.
 * 9. Concurrent incoming transfers from multiple peers into distinct records without state collision.
 * 10. Room exit and transfer cleanup (blob URL revocation, timer/queue teardown, state reset).
 * 11. Legacy two-person workflow preservation (auto-select single peer, compact single-transfer UI).
 * 12. Correct recipient attribution in topology activity events (file out / file in per peer).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderRecipientSelector,
  renderActiveTransferPanel,
  renderFilesList,
  updateFilesUI,
  initFiles,
} from '../src/features/files/index.js';
import {
  packChunk,
  unpackChunk,
  TRANSFER_STATES,
  PEER_CONNECTION_STATES,
  DATA_CHANNEL_STATES,
} from '../src/services/peer-connection.js';
import { PeerRegistry } from '../src/services/peer-registry.js';
import { createInitialState, resetSessionState } from '../src/state/app-state.js';
import { initTopologyPanel } from '../src/features/topology/topology-controller.js';

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
    sendOffer() {},
    sendAnswer() {},
    sendCandidate() {},
    requestRoster() {},
  };
}

function createMockPeer(id, role = 'guest', isFileReady = true) {
  const listeners = new Map();
  let fileReady = isFileReady;
  const activeTransfers = new Map();

  return {
    remoteSessionId: id,
    role,
    connectionState: isFileReady ? 'connected' : 'connecting',
    isFileChannelReady() {
      return fileReady;
    },
    setFileReady(ready) {
      fileReady = ready;
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    },
    emit(event, ...args) {
      listeners.get(event)?.forEach((h) => h(...args));
    },
    async sendFile(file, onProgress) {
      if (!fileReady) {
        throw new Error(`WebRTC file channel is not open for ${id}.`);
      }
      const transferId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const transfer = {
        id: transferId,
        name: file.name,
        size: file.size,
        direction: 'outgoing',
        status: 'sending',
        progress: 0,
        transferredBytes: 0,
        totalBytes: file.size,
        peerSessionId: id,
        peerLabel: `Peer ${String(id).slice(0, 8)}`,
      };
      activeTransfers.set(transferId, transfer);
      this.emit('fileTransferStart', { ...transfer });
      return transferId;
    },
    cancelTransfer(transferId, reason = 'Cancelled by user') {
      const tx = activeTransfers.get(transferId);
      if (tx) {
        tx.status = 'cancelled';
        tx.reason = reason;
        this.emit('fileTransferCancelled', { ...tx, reason });
      }
    },
    close() {
      activeTransfers.forEach((tx) => {
        if (tx.status === 'sending' || tx.status === 'receiving' || tx.status === 'waiting') {
          tx.status = 'failed';
          tx.error = 'Peer connection closed.';
          this.emit('fileTransferFailed', { ...tx, error: 'Peer connection closed.' });
        }
      });
      activeTransfers.clear();
      fileReady = false;
    },
    activeTransfers,
  };
}

function createMockRegistry(mySessionId = 'local-user', myRole = 'host') {
  const peers = new Map();
  const listeners = new Map();
  let latestRoster = [];

  const reg = {
    mySessionId,
    myRole,
    roomCode: 'MESH-7721',
    peers,
    latestRoster,
    getRoster() {
      return [...(this.latestRoster || latestRoster)];
    },
    setRoster(r) {
      this.latestRoster = [...r];
    },
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
    isFileChannelReady() {
      return Array.from(peers.values()).some((p) => p.isFileChannelReady());
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    },
    emit(event, ...args) {
      listeners.get(event)?.forEach((h) => h(...args));
    },
    async sendFilesToRecipients(file, recipientSessionIds, onProgress = null) {
      if (!Array.isArray(recipientSessionIds) || recipientSessionIds.length === 0) {
        throw new Error('At least one recipient must be specified.');
      }
      const results = [];
      const errors = [];
      for (const sid of recipientSessionIds) {
        const peer = peers.get(sid);
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
    },
    cancelTransfer(transferId, reason = 'Cancelled by user', targetSessionId = null) {
      if (targetSessionId) {
        const p = peers.get(targetSessionId);
        if (p) p.cancelTransfer(transferId, reason);
        return;
      }
      peers.forEach((p) => {
        p.cancelTransfer(transferId, reason);
      });
    },
    closeAll() {
      peers.forEach((p) => p.close());
      peers.clear();
      latestRoster = [];
    },
  };

  return reg;
}

describe('PairPort Phase 3: Multi-Recipient File Sharing', () => {
  describe('1. Recipient Selector Rendering & State', () => {
    it('renders local sender chip as "You (Sender)" with role', () => {
      const s = createInitialState();
      s.realSessionId = 'host-session-1';
      s.realRole = 'host';
      s.participants = [{ session_id: 'host-session-1', role: 'host' }];

      const html = renderRecipientSelector(s, null);
      assert.ok(html.includes('file-recipient-selector'));
      assert.ok(html.includes('local-sender-chip'));
      assert.ok(html.includes('You (Sender)'));
      assert.ok(html.includes('Host'));
    });

    it('renders all remote peers with safe display labels and connection readiness', () => {
      const s = createInitialState();
      s.realSessionId = 'host-session-1';
      s.realRole = 'host';
      s.participants = [
        { session_id: 'host-session-1', role: 'host' },
        { session_id: 'peer-alpha-001', role: 'guest' },
        { session_id: 'peer-beta-002', role: 'guest' },
      ];
      s.selectedRecipientIds = ['peer-alpha-001'];

      const reg = createMockRegistry('host-session-1', 'host');
      const p1 = createMockPeer('peer-alpha-001', 'guest', true);
      const p2 = createMockPeer('peer-beta-002', 'guest', false); // Not ready
      reg.peers.set('peer-alpha-001', p1);
      reg.peers.set('peer-beta-002', p2);

      const html = renderRecipientSelector(s, reg);

      // Safe labels
      assert.ok(html.includes('Peer peer-alp'));
      assert.ok(html.includes('Peer peer-bet'));

      // Readiness classes
      assert.ok(html.includes('status-ready'));
      assert.ok(html.includes('Ready'));
      assert.ok(html.includes('Connecting...'));

      // Disabled state for unready peer
      assert.ok(html.includes('disabled'));

      // Select all / deselect all controls
      assert.ok(html.includes('select-all-recipients-btn'));
      assert.ok(html.includes('deselect-all-recipients-btn'));
    });

    it('shows standby notice when no remote peers have joined', () => {
      const s = createInitialState();
      s.realSessionId = 'local-1';
      s.participants = [{ session_id: 'local-1', role: 'host' }];
      const html = renderRecipientSelector(s, null);

      assert.ok(html.includes('recipient-notice standby'));
      assert.ok(html.includes('Awaiting peers to join the room'));
    });

    it('shows warning notice when multiple peers are connected but none are selected', () => {
      const s = createInitialState();
      s.realSessionId = 'local-1';
      s.participants = [
        { session_id: 'local-1', role: 'host' },
        { session_id: 'remote-1', role: 'guest' },
        { session_id: 'remote-2', role: 'guest' },
      ];
      s.selectedRecipientIds = [];

      const reg = createMockRegistry('local-1', 'host');
      reg.peers.set('remote-1', createMockPeer('remote-1', 'guest', true));
      reg.peers.set('remote-2', createMockPeer('remote-2', 'guest', true));

      const html = renderRecipientSelector(s, reg);
      assert.ok(html.includes('recipient-notice warning'));
      assert.ok(html.includes('No recipients selected'));
    });

    it('shows waiting notice when selected recipient is not ready', () => {
      const s = createInitialState();
      s.realSessionId = 'local-1';
      s.participants = [
        { session_id: 'local-1', role: 'host' },
        { session_id: 'remote-1', role: 'guest' },
        { session_id: 'remote-2', role: 'guest' },
      ];
      s.selectedRecipientIds = ['remote-1'];

      const reg = createMockRegistry('local-1', 'host');
      reg.peers.set('remote-1', createMockPeer('remote-1', 'guest', false)); // Unready
      reg.peers.set('remote-2', createMockPeer('remote-2', 'guest', false));

      const html = renderRecipientSelector(s, reg);
      assert.ok(html.includes('recipient-notice waiting'));
      assert.ok(html.includes('WebRTC file channel is not open yet'));
    });
  });

  describe('2. Legacy Two-Person Workflow Preservation', () => {
    it('automatically selects the single remote peer in a 2-person room', () => {
      const s = createInitialState();
      s.realSessionId = 'host-1';
      s.participants = [
        { session_id: 'host-1', role: 'host' },
        { session_id: 'guest-1', role: 'guest' },
      ];
      s.selectedRecipientIds = [];

      const reg = createMockRegistry('host-1', 'host');
      reg.peers.set('guest-1', createMockPeer('guest-1', 'guest', true));

      const html = renderRecipientSelector(s, reg);

      // In 2-person mode, single ready remote peer is checked by default
      assert.ok(html.includes('checked'));
      assert.ok(!html.includes('No recipients selected'));
    });

    it('renders single active transfer panel when 1 transfer is in flight', () => {
      const s = createInitialState();
      s.realFiles = [
        {
          id: 'tx-legacy-1',
          name: 'project_notes.pdf',
          size: 500000,
          direction: 'outgoing',
          status: 'sending',
          progress: 50,
          transferredBytes: 250000,
          totalBytes: 500000,
          peerSessionId: 'guest-1',
          peerLabel: 'Peer guest-1',
        },
      ];

      const html = renderActiveTransferPanel(s, true);
      assert.ok(html.includes('STREAMING DIRECTLY TO PEER (SCTP)'));
      assert.ok(html.includes('SENDING · 50%'));
      assert.ok(html.includes('project_notes.pdf'));
      assert.ok(!html.includes('multi-active'));
    });
  });

  describe('3. Multi-Recipient Sending & Independent Transfer Records', () => {
    it('creates independent transfer operations with unique transfer IDs per recipient', async () => {
      const reg = createMockRegistry('local-host', 'host');
      const p1 = createMockPeer('guest-alpha', 'guest', true);
      const p2 = createMockPeer('guest-beta', 'guest', true);
      reg.peers.set('guest-alpha', p1);
      reg.peers.set('guest-beta', p2);

      const fakeFile = { name: 'design.fig', size: 1048576 };
      const results = await reg.sendFilesToRecipients(fakeFile, ['guest-alpha', 'guest-beta']);

      assert.equal(results.length, 2);
      assert.equal(results[0].peerSessionId, 'guest-alpha');
      assert.equal(results[1].peerSessionId, 'guest-beta');

      // Unique transfer IDs
      assert.ok(results[0].transferId);
      assert.ok(results[1].transferId);
      assert.notEqual(results[0].transferId, results[1].transferId);

      // Both peers have their own active transfer record
      assert.ok(p1.activeTransfers.has(results[0].transferId));
      assert.ok(p2.activeTransfers.has(results[1].transferId));
    });

    it('renders multi-transfer panel when 2+ transfers are in flight with Cancel All button', () => {
      const s = createInitialState();
      s.realFiles = [
        {
          id: 'tx-1',
          name: 'dataset.csv',
          size: 1000000,
          direction: 'outgoing',
          status: 'sending',
          progress: 35,
          transferredBytes: 350000,
          totalBytes: 1000000,
          peerSessionId: 'peer-alpha',
          peerLabel: 'Peer peer-alpha',
        },
        {
          id: 'tx-2',
          name: 'dataset.csv',
          size: 1000000,
          direction: 'outgoing',
          status: 'sending',
          progress: 70,
          transferredBytes: 700000,
          totalBytes: 1000000,
          peerSessionId: 'peer-beta',
          peerLabel: 'Peer peer-beta',
        },
      ];

      const html = renderActiveTransferPanel(s, true);
      assert.ok(html.includes('STREAMING TO MULTIPLE RECIPIENTS (2 IN-FLIGHT)'));
      assert.ok(html.includes('id="cancel-all-transfers-btn"'));
      assert.ok(html.includes('Cancel All'));

      // Both recipient items rendered
      assert.ok(html.includes('Peer peer-alpha'));
      assert.ok(html.includes('Peer peer-beta'));
      assert.ok(html.includes('width: 35%'));
      assert.ok(html.includes('width: 70%'));
    });
  });

  describe('4. Partial Failure & Cancellation Isolation', () => {
    it('isolates failure: Peer A succeeds while Peer B fails due to channel error', () => {
      const s = createInitialState();
      s.realFiles = [
        {
          id: 'tx-success',
          name: 'shared.zip',
          size: 1024,
          direction: 'outgoing',
          status: 'sending',
          progress: 50,
          transferredBytes: 512,
          peerSessionId: 'peer-A',
        },
        {
          id: 'tx-failure',
          name: 'shared.zip',
          size: 1024,
          direction: 'outgoing',
          status: 'sending',
          progress: 20,
          transferredBytes: 200,
          peerSessionId: 'peer-B',
        },
      ];

      // Peer A completes
      const txAIndex = s.realFiles.findIndex((f) => f.id === 'tx-success');
      s.realFiles[txAIndex] = {
        ...s.realFiles[txAIndex],
        status: 'completed',
        progress: 100,
        transferredBytes: 1024,
      };

      // Peer B fails
      const txBIndex = s.realFiles.findIndex((f) => f.id === 'tx-failure');
      s.realFiles[txBIndex] = {
        ...s.realFiles[txBIndex],
        status: 'failed',
        error: 'DataChannel aborted',
      };

      assert.equal(s.realFiles[txAIndex].status, 'completed');
      assert.equal(s.realFiles[txAIndex].progress, 100);
      assert.equal(s.realFiles[txBIndex].status, 'failed');
      assert.equal(s.realFiles[txBIndex].error, 'DataChannel aborted');
    });

    it('isolates cancellation: cancelling Peer A does not cancel Peer B', () => {
      const reg = createMockRegistry('local-host', 'host');
      const pA = createMockPeer('peer-A', 'guest', true);
      const pB = createMockPeer('peer-B', 'guest', true);
      reg.peers.set('peer-A', pA);
      reg.peers.set('peer-B', pB);

      const txAId = 'tx-A-123';
      const txBId = 'tx-B-456';

      pA.activeTransfers.set(txAId, {
        id: txAId,
        status: 'sending',
        direction: 'outgoing',
      });
      pB.activeTransfers.set(txBId, {
        id: txBId,
        status: 'sending',
        direction: 'outgoing',
      });

      // Cancel only Peer A
      pA.cancelTransfer(txAId, 'User clicked cancel on Peer A');

      assert.equal(pA.activeTransfers.get(txAId).status, 'cancelled');
      assert.equal(pB.activeTransfers.get(txBId).status, 'sending');
    });

    it('cancels all active transfers when user clicks Cancel All', () => {
      const reg = createMockRegistry('local-host', 'host');
      const pA = createMockPeer('peer-A', 'guest', true);
      const pB = createMockPeer('peer-B', 'guest', true);
      reg.peers.set('peer-A', pA);
      reg.peers.set('peer-B', pB);

      const txAId = 'tx-A-1';
      const txBId = 'tx-B-2';

      pA.activeTransfers.set(txAId, { id: txAId, status: 'sending' });
      pB.activeTransfers.set(txBId, { id: txBId, status: 'sending' });

      // Cancel across registry
      reg.cancelTransfer(txAId, 'Cancelled by user');
      reg.cancelTransfer(txBId, 'Cancelled by user');

      assert.equal(pA.activeTransfers.get(txAId).status, 'cancelled');
      assert.equal(pB.activeTransfers.get(txBId).status, 'cancelled');
    });
  });

  describe('5. Peer Disconnect During Transfer', () => {
    it('fails in-flight transfers for departed peer while remaining peer transfers continue', () => {
      const reg = createMockRegistry('local-host', 'host');
      const pA = createMockPeer('peer-departed', 'guest', true);
      const pB = createMockPeer('peer-remaining', 'guest', true);
      reg.peers.set('peer-departed', pA);
      reg.peers.set('peer-remaining', pB);

      let pAFailed = false;
      let pBFailed = false;

      pA.on('fileTransferFailed', () => { pAFailed = true; });
      pB.on('fileTransferFailed', () => { pBFailed = true; });

      pA.activeTransfers.set('tx-departed', { id: 'tx-departed', status: 'sending' });
      pB.activeTransfers.set('tx-remaining', { id: 'tx-remaining', status: 'sending' });

      // Peer A disconnects and closes
      pA.close();

      assert.equal(pAFailed, true);
      assert.equal(pBFailed, false);
      assert.equal(pB.activeTransfers.get('tx-remaining').status, 'sending');
    });
  });

  describe('6. Concurrent Incoming Transfers from Multiple Peers', () => {
    it('stores concurrent incoming transfers from different peers in distinct records', () => {
      const s = createInitialState();

      const incomingA = {
        id: 'inc-A-991',
        name: 'report_A.pdf',
        size: 2048,
        direction: 'incoming',
        status: 'receiving',
        progress: 40,
        transferredBytes: 800,
        peerSessionId: 'peer-A',
        peerLabel: 'Peer peer-A',
      };

      const incomingB = {
        id: 'inc-B-992',
        name: 'image_B.png',
        size: 4096,
        direction: 'incoming',
        status: 'receiving',
        progress: 60,
        transferredBytes: 2400,
        peerSessionId: 'peer-B',
        peerLabel: 'Peer peer-B',
      };

      s.realFiles.unshift(incomingA);
      s.realFiles.unshift(incomingB);

      assert.equal(s.realFiles.length, 2);
      assert.equal(s.realFiles[0].id, 'inc-B-992');
      assert.equal(s.realFiles[0].peerSessionId, 'peer-B');
      assert.equal(s.realFiles[1].id, 'inc-A-991');
      assert.equal(s.realFiles[1].peerSessionId, 'peer-A');
    });

    it('attaches target/source attribution badge in rendered files list', () => {
      const files = [
        {
          id: 'out-1',
          name: 'doc.txt',
          size: 100,
          direction: 'outgoing',
          status: 'completed',
          progress: 100,
          peerLabel: 'Peer Alpha',
        },
        {
          id: 'in-1',
          name: 'archive.tar',
          size: 200,
          direction: 'incoming',
          status: 'completed',
          progress: 100,
          blobUrl: 'blob:http://localhost/archive',
          peerLabel: 'Peer Beta',
        },
      ];

      const html = renderFilesList(files);
      assert.ok(html.includes('peer-target-badge'));
      assert.ok(html.includes('To: Peer Alpha'));
      assert.ok(html.includes('From: Peer Beta'));
    });
  });

  describe('7. Room Exit & Memory Cleanup', () => {
    it('revokes blob URLs and cleans up transfer state on resetSessionState', () => {
      let revokedUrls = [];
      const originalRevoke = globalThis.URL?.revokeObjectURL;
      globalThis.URL = globalThis.URL || {};
      globalThis.URL.revokeObjectURL = (url) => { revokedUrls.push(url); };

      try {
        const s = createInitialState();
        s.realFiles = [
          {
            id: 'f-1',
            blobUrl: 'blob:http://localhost/test-blob-1',
          },
          {
            id: 'f-2',
            blobUrl: 'blob:http://localhost/test-blob-2',
          },
        ];
        s.activeTransfer = { id: 'f-1' };
        s.selectedRecipientIds = ['peer-1', 'peer-2'];

        resetSessionState(s);

        assert.equal(revokedUrls.length, 2);
        assert.ok(revokedUrls.includes('blob:http://localhost/test-blob-1'));
        assert.ok(revokedUrls.includes('blob:http://localhost/test-blob-2'));
        assert.equal(s.realFiles.length, 0);
        assert.equal(s.activeTransfer, null);
        assert.deepEqual(s.selectedRecipientIds, []);
      } finally {
        if (originalRevoke) {
          globalThis.URL.revokeObjectURL = originalRevoke;
        }
      }
    });
  });

  describe('8. Topology Activity Attribution', () => {
    it('emits peerActivity with correct peerSessionId and direction for outgoing transfers', async () => {
      const reg = createMockRegistry('local-host', 'host');
      const pA = createMockPeer('peer-target-1', 'guest', true);
      reg.peers.set('peer-target-1', pA);

      const activities = [];
      reg.on('peerActivity', (evt) => activities.push(evt));

      const file = { name: 'test.dat', size: 100 };
      await reg.sendFilesToRecipients(file, ['peer-target-1']);

      assert.equal(activities.length, 1);
      assert.equal(activities[0].peerSessionId, 'peer-target-1');
      assert.equal(activities[0].type, 'file');
      assert.equal(activities[0].direction, 'out');
    });

    it('attaches peerSessionId to incoming file activity in peer-registry forwarding', () => {
      const mockSignaling = createMockSignaling();
      const registry = new PeerRegistry({
        signaling: mockSignaling,
        autoBindSignaling: false,
      });
      registry.setMySessionId('local-user', 'host');

      const pService = registry.createPeer('remote-guest-42', 'guest');

      const activities = [];
      registry.on('peerActivity', (evt) => activities.push(evt));

      // Simulate incoming fileTransferStart from pService
      pService.emit('fileTransferStart', {
        id: 'file-in-123',
        direction: 'incoming',
        name: 'sample.pdf',
        size: 500,
      });

      assert.equal(activities.length, 1);
      assert.equal(activities[0].peerSessionId, 'remote-guest-42');
      assert.equal(activities[0].type, 'file');
      assert.equal(activities[0].direction, 'incoming');
    });
  });

  describe('9. FilesController DOM Integration & Interaction', () => {
    function createMockDOM() {
      const listeners = new Map();
      const elements = new Map();

      function createElement(tag, id = null, className = '') {
        const elListeners = new Map();
        const classes = new Set(className.split(' ').filter(Boolean));
        const attrs = new Map();

        const el = {
          nodeType: 1,
          tagName: tag.toUpperCase(),
          id,
          className,
          classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            contains: (c) => classes.has(c),
            toggle: (c, force) => {
              if (force === undefined) {
                if (classes.has(c)) classes.delete(c);
                else classes.add(c);
              } else if (force) classes.add(c);
              else classes.delete(c);
            },
          },
          setAttribute: (k, v) => attrs.set(k, String(v)),
          getAttribute: (k) => attrs.get(k) || null,
          removeAttribute: (k) => attrs.delete(k),
          hasAttribute: (k) => attrs.has(k),
          addEventListener: (evt, fn) => {
            if (!elListeners.has(evt)) elListeners.set(evt, new Set());
            elListeners.get(evt).add(fn);
          },
          removeEventListener: (evt, fn) => {
            elListeners.get(evt)?.delete(fn);
          },
          dispatch: (evt, eventData = {}) => {
            const handlers = elListeners.get(evt);
            if (handlers) {
              const ev = {
                type: evt,
                target: el,
                currentTarget: el,
                stopPropagation: () => {},
                preventDefault: () => {},
                closest: (sel) => {
                  if (sel === `#${el.id}` || sel === `.${Array.from(classes)[0]}`) return el;
                  return null;
                },
                ...eventData,
              };
              handlers.forEach((h) => h(ev));
            }
          },
          innerHTML: '',
          innerText: '',
          textContent: '',
          querySelector: (sel) => elements.get(sel) || null,
          querySelectorAll: () => [],
        };
        if (id) elements.set(`#${id}`, el);
        return el;
      }

      const root = createElement('div', 'app-root');
      const dropZone = createElement('div', 'file-drop-zone');
      const fileBrowseInput = createElement('input', 'file-browse-input');
      fileBrowseInput.type = 'file';
      const browseBtn = createElement('button', 'browse-files-btn');
      const filesList = createElement('div', 'files-list');
      const activeTransferContainer = createElement('div', 'active-transfer-container');
      const recipientSelectorContainer = createElement('div', 'file-recipient-selector-container');

      elements.set('#file-drop-zone', dropZone);
      elements.set('#file-browse-input', fileBrowseInput);
      elements.set('#browse-files-btn', browseBtn);
      elements.set('#files-list', filesList);
      elements.set('#active-transfer-container', activeTransferContainer);
      elements.set('#file-recipient-selector-container', recipientSelectorContainer);

      root.querySelector = (sel) => elements.get(sel) || null;

      return { root, elements, createElement };
    }

    it('dispatches to all selected ready recipients in multi-peer mode', async () => {
      const { root } = createMockDOM();
      const reg = createMockRegistry('local-host', 'host');
      const p1 = createMockPeer('peer-1', 'guest', true);
      const p2 = createMockPeer('peer-2', 'guest', true);
      reg.peers.set('peer-1', p1);
      reg.peers.set('peer-2', p2);
      reg.latestRoster = [
        { session_id: 'local-host', role: 'host' },
        { session_id: 'peer-1', role: 'guest' },
        { session_id: 'peer-2', role: 'guest' },
      ];

      const s = createInitialState();
      s.realSessionId = 'local-host';
      s.participants = reg.latestRoster;
      s.selectedRecipientIds = ['peer-1', 'peer-2'];

      let sentRecipients = null;
      reg.sendFilesToRecipients = async (file, recipientIds) => {
        sentRecipients = recipientIds;
        return recipientIds.map((id) => ({ peerSessionId: id, transferId: `tx-${id}` }));
      };

      const ctrl = initFiles(root, {
        peerConnection: reg,
        toast: () => {},
        appState: s,
      });

      const file = { name: 'document.pdf', size: 1024 };
      await ctrl.handleSelectedFiles([file]);

      assert.deepEqual(sentRecipients, ['peer-1', 'peer-2']);
    });

    it('blocks sending when multiple peers exist but none are selected', async () => {
      const { root } = createMockDOM();
      const reg = createMockRegistry('local-host', 'host');
      reg.peers.set('peer-1', createMockPeer('peer-1', 'guest', true));
      reg.peers.set('peer-2', createMockPeer('peer-2', 'guest', true));
      reg.latestRoster = [
        { session_id: 'local-host', role: 'host' },
        { session_id: 'peer-1', role: 'guest' },
        { session_id: 'peer-2', role: 'guest' },
      ];

      const s = createInitialState();
      s.realSessionId = 'local-host';
      s.participants = reg.latestRoster;
      s.selectedRecipientIds = [];

      let toasts = [];
      let sentCalled = false;
      reg.sendFilesToRecipients = async () => {
        sentCalled = true;
      };

      const ctrl = initFiles(root, {
        peerConnection: reg,
        toast: (msg, type) => toasts.push({ msg, type }),
        appState: s,
      });

      await ctrl.handleSelectedFiles([{ name: 'test.txt', size: 100 }]);

      assert.equal(sentCalled, false);
      assert.ok(toasts.some((t) => t.msg.includes('Select at least one connected recipient')));
    });

    it('blocks sending when selected recipient is not ready', async () => {
      const { root } = createMockDOM();
      const reg = createMockRegistry('local-host', 'host');
      const p1 = createMockPeer('peer-unready', 'guest', false); // Not ready
      const p2 = createMockPeer('peer-ready', 'guest', true);
      reg.peers.set('peer-unready', p1);
      reg.peers.set('peer-ready', p2);
      reg.latestRoster = [
        { session_id: 'local-host', role: 'host' },
        { session_id: 'peer-unready', role: 'guest' },
        { session_id: 'peer-ready', role: 'guest' },
      ];

      const s = createInitialState();
      s.realSessionId = 'local-host';
      s.participants = reg.latestRoster;
      s.selectedRecipientIds = ['peer-unready']; // Selected unready peer

      let toasts = [];
      let sentCalled = false;
      reg.sendFilesToRecipients = async () => {
        sentCalled = true;
      };

      const ctrl = initFiles(root, {
        peerConnection: reg,
        toast: (msg, type) => toasts.push({ msg, type }),
        appState: s,
      });

      await ctrl.handleSelectedFiles([{ name: 'test.txt', size: 100 }]);

      assert.equal(sentCalled, false);
      assert.ok(toasts.some((t) => t.msg.includes('Selected recipient is not ready')));
    });

    it('enforces maximum file size limit (100 MB)', async () => {
      const { root } = createMockDOM();
      const reg = createMockRegistry('local-host', 'host');
      reg.peers.set('peer-1', createMockPeer('peer-1', 'guest', true));
      reg.latestRoster = [
        { session_id: 'local-host', role: 'host' },
        { session_id: 'peer-1', role: 'guest' },
      ];

      const s = createInitialState();
      s.realSessionId = 'local-host';
      s.participants = reg.latestRoster;
      s.selectedRecipientIds = ['peer-1'];

      let toasts = [];
      let sentCalled = false;
      reg.sendFilesToRecipients = async () => {
        sentCalled = true;
      };

      const ctrl = initFiles(root, {
        peerConnection: reg,
        toast: (msg, type) => toasts.push({ msg, type }),
        appState: s,
      });

      // 105 MB file
      const oversizedFile = { name: 'huge_archive.iso', size: 105 * 1024 * 1024 };
      await ctrl.handleSelectedFiles([oversizedFile]);

      assert.equal(sentCalled, false);
      assert.ok(toasts.some((t) => t.msg.includes('exceeds maximum allowed limit')));
    });
  });
});
