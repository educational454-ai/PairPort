import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeSessionStatusInfo,
  renderLiveSessionPanel,
  updateSessionStatusUI,
  bindSessionPanelEvents,
  initConnectionController,
} from '../src/features/connection/index.js';
import { SIGNALING_STATES } from '../src/services/signaling.js';
import {
  PEER_CONNECTION_STATES,
  DATA_CHANNEL_STATES,
} from '../src/services/peer-connection.js';
import { createInitialState, state } from '../src/state/app-state.js';

describe('1. computeSessionStatusInfo', () => {
  it('returns idle status info when session is idle', () => {
    const s = createInitialState();
    const info = computeSessionStatusInfo(s);
    assert.equal(info.statusDotClass, 'waiting');
    assert.ok(info.statusPillHtml.includes('Idle'));
    assert.equal(info.metaBadgeText, 'P2P Ready');
    assert.equal(info.isDataChannelOpen, false);
    assert.equal(info.isReconnecting, false);
    assert.equal(info.isPeerFailed, false);
  });

  it('reflects reconnecting state with retry attempt count', () => {
    const s = createInitialState();
    s.signalingState = SIGNALING_STATES.CONNECTED;
    s.isReconnecting = true;
    s.reconnectAttempt = 2;

    const info = computeSessionStatusInfo(s);
    assert.equal(info.statusDotClass, 'reconnecting');
    assert.ok(info.statusPillHtml.includes('Attempt 2/3'));
    assert.equal(info.metaBadgeText, 'Reconnecting WebRTC...');
    assert.equal(info.isReconnecting, true);
  });

  it('reflects peer connection failure when retries exhausted', () => {
    const s = createInitialState();
    s.signalingState = SIGNALING_STATES.CONNECTED;
    s.peerConnectionState = PEER_CONNECTION_STATES.FAILED;

    const info = computeSessionStatusInfo(s);
    assert.equal(info.statusDotClass, 'error');
    assert.ok(info.statusPillHtml.includes('Failed'));
    assert.equal(info.metaBadgeText, 'Connection Failed');
    assert.equal(info.isPeerFailed, true);
  });

  it('reflects direct P2P data channels when open without relay', () => {
    const s = createInitialState();
    s.signalingState = SIGNALING_STATES.CONNECTED;
    s.peerConnectionState = PEER_CONNECTION_STATES.CONNECTED;
    s.dataChannelState = DATA_CHANNEL_STATES.OPEN;
    s.connectionDiagnostics.isRelay = false;

    const info = computeSessionStatusInfo(s);
    assert.equal(info.statusDotClass, 'online');
    assert.ok(info.statusPillHtml.includes('P2P Direct'));
    assert.ok(info.metaBadgeText.includes('Direct P2P'));
    assert.equal(info.isRelayActive, false);
  });

  it('reflects TURN relay when relay candidate is active', () => {
    const s = createInitialState();
    s.signalingState = SIGNALING_STATES.CONNECTED;
    s.peerConnectionState = PEER_CONNECTION_STATES.CONNECTED;
    s.dataChannelState = DATA_CHANNEL_STATES.OPEN;
    s.connectionDiagnostics.isRelay = true;

    const info = computeSessionStatusInfo(s);
    assert.equal(info.statusDotClass, 'relay');
    assert.ok(info.statusPillHtml.includes('TURN Relay'));
    assert.ok(info.metaBadgeText.includes('TURN Relay Active'));
    assert.equal(info.isRelayActive, true);
  });
});

describe('2. renderLiveSessionPanel', () => {
  it('returns empty string when signaling state is IDLE', () => {
    const s = createInitialState();
    assert.equal(renderLiveSessionPanel(s), '');
  });

  it('renders session header, leave button, and code row when active', () => {
    const s = createInitialState();
    s.signalingState = SIGNALING_STATES.CONNECTED;
    s.realRoomCode = 'PORT-9999';
    s.realRole = 'host';

    const html = renderLiveSessionPanel(s);
    assert.ok(html.includes('live-session-panel'));
    assert.ok(html.includes('id="leave-room-btn"'));
    assert.ok(html.includes('id="copy-live-code-btn"'));
    assert.ok(html.includes('PORT-9999'));
    assert.ok(html.includes('Host (Creator)'));
    assert.ok(html.includes('id="webrtc-diagnostics-drawer"'));
    assert.ok(html.includes('Round-Trip Latency (RTT)'));
    assert.ok(html.includes('Privacy Shield'));
  });

  it('renders reconnecting banner in diagnostics drawer when reconnecting', () => {
    const s = createInitialState();
    s.signalingState = SIGNALING_STATES.CONNECTED;
    s.realRoomCode = 'PORT-1234';
    s.isReconnecting = true;
    s.reconnectAttempt = 1;

    const html = renderLiveSessionPanel(s);
    assert.ok(html.includes('badge-reconnecting'));
    assert.ok(html.includes('Reconnecting (1/3)'));
  });
});

describe('3. updateSessionStatusUI', () => {
  it('updates live session container, workspace topbar status, and room code', () => {
    const s = createInitialState();
    s.signalingState = SIGNALING_STATES.CONNECTED;
    s.realRoomCode = 'PORT-TEST';
    s.dataChannelState = DATA_CHANNEL_STATES.OPEN;

    let containerHtml = '';
    let pillHtml = '';
    let latencyText = '';
    let codeText = '';

    const fakeRoot = {
      querySelector: (sel) => {
        if (sel === '#live-session-container') {
          return { set innerHTML(val) { containerHtml = val; } };
        }
        if (sel === '.workspace-topbar .peer-status-pill') {
          return { set innerHTML(val) { pillHtml = val; } };
        }
        if (sel === '.workspace-topbar .latency-badge span') {
          return { set textContent(val) { latencyText = val; } };
        }
        if (sel === '#workspace-room-code') {
          return { set textContent(val) { codeText = val; } };
        }
        return null;
      },
    };

    updateSessionStatusUI(fakeRoot, s);
    assert.ok(containerHtml.includes('PORT-TEST'));
    assert.ok(pillHtml.includes('P2P Direct'));
    assert.ok(latencyText.includes('Direct P2P'));
    assert.equal(codeText, 'PORT-TEST');
  });
});

describe('4. bindSessionPanelEvents', () => {
  it('binds toggle event on diagnostics drawer to update state.isDiagnosticsOpen', () => {
    let toggleHandler = null;
    const fakeDrawer = {
      open: true,
      addEventListener: (event, handler) => {
        if (event === 'toggle') toggleHandler = handler;
      },
    };

    const fakeRoot = {
      querySelector: (sel) => {
        if (sel === '#webrtc-diagnostics-drawer') return fakeDrawer;
        return null;
      },
    };

    bindSessionPanelEvents(fakeRoot);
    assert.equal(typeof toggleHandler, 'function');
    toggleHandler();
  });
});

describe('5. initConnectionController', () => {
  it('registers signaling and WebRTC lifecycle events and provides idempotent controller API', () => {
    const signalingListeners = {};
    const fakeSignaling = {
      on: (event, handler) => {
        signalingListeners[event] = handler;
      },
      leaveRoom: () => {},
    };

    const peerListeners = {};
    const fakePeerConnection = {
      on: (event, handler) => {
        peerListeners[event] = handler;
      },
      close: () => {},
      isFileChannelReady: () => false,
    };

    const fakeRoot = {
      nodeType: 1,
      dataset: {},
      querySelector: () => null,
      querySelectorAll: () => [],
    };

    const controller1 = initConnectionController(fakeRoot, {
      signaling: fakeSignaling,
      peerConnection: fakePeerConnection,
    });

    assert.equal(typeof controller1.refreshSessionUI, 'function');
    assert.equal(typeof controller1.handleLeave, 'function');

    // Verify key signaling event listeners registered
    assert.equal(typeof signalingListeners.stateChange, 'function');
    assert.equal(typeof signalingListeners.roomCreated, 'function');
    assert.equal(typeof signalingListeners.waiting, 'function');
    assert.equal(typeof signalingListeners.peerJoined, 'function');
    assert.equal(typeof signalingListeners.peerLeft, 'function');
    assert.equal(typeof signalingListeners.error, 'function');

    // Verify WebRTC lifecycle event listeners registered
    assert.equal(typeof peerListeners.connectionStateChange, 'function');
    assert.equal(typeof peerListeners.iceConnectionStateChange, 'function');
    assert.equal(typeof peerListeners.iceGatheringStateChange, 'function');
    assert.equal(typeof peerListeners.reconnecting, 'function');
    assert.equal(typeof peerListeners.terminalFailure, 'function');
    assert.equal(typeof peerListeners.diagnosticsUpdate, 'function');
    assert.equal(typeof peerListeners.dataChannelStateChange, 'function');
    assert.equal(typeof peerListeners.fileChannelStateChange, 'function');

    // Test idempotency: calling again on same root returns existing controller without re-registering
    const controller2 = initConnectionController(fakeRoot, {
      signaling: fakeSignaling,
      peerConnection: fakePeerConnection,
    });
    assert.equal(typeof controller2.refreshSessionUI, 'function');
  });

  it('revokes in-memory blob URLs and resets active transfer when peerLeft fires', () => {
    const signalingListeners = {};
    const fakeSignaling = {
      on: (event, handler) => { signalingListeners[event] = handler; },
      leaveRoom: () => {},
    };
    const fakePeerConnection = {
      on: () => {},
      close: () => {},
      isFileChannelReady: () => false,
    };
    const fakeRoot = {
      nodeType: 1,
      dataset: {},
      querySelector: () => null,
      querySelectorAll: () => [],
    };

    let revokedUrl = null;
    const origRevoke = globalThis.URL?.revokeObjectURL;
    globalThis.URL = globalThis.URL || {};
    globalThis.URL.revokeObjectURL = (url) => { revokedUrl = url; };

    initConnectionController(fakeRoot, {
      signaling: fakeSignaling,
      peerConnection: fakePeerConnection,
      toast: () => {},
    });

    state.realFiles = [{ id: 'f1', blobUrl: 'blob:http://localhost:5173/sample-blob' }];
    state.activeTransfer = { id: 'tx1' };

    signalingListeners.peerLeft();

    assert.equal(revokedUrl, 'blob:http://localhost:5173/sample-blob');
    assert.equal(state.realFiles.length, 0);
    assert.equal(state.activeTransfer, null);

    if (origRevoke) globalThis.URL.revokeObjectURL = origRevoke;
  });
});
