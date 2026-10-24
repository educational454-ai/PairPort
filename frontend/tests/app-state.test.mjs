import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  state,
  createDefaultDiagnostics,
  createInitialState,
  resetSessionState,
} from '../src/state/app-state.js';
import { SIGNALING_STATES } from '../src/services/signaling.js';
import {
  PEER_CONNECTION_STATES,
  DATA_CHANNEL_STATES,
} from '../src/services/peer-connection.js';

describe('1. createDefaultDiagnostics', () => {
  it('returns default diagnostic values and structure', () => {
    const diag = createDefaultDiagnostics();
    assert.equal(diag.connectionState, 'idle');
    assert.equal(diag.iceConnectionState, 'idle');
    assert.equal(diag.iceGatheringState, 'idle');
    assert.equal(diag.signalingState, 'idle');
    assert.equal(diag.selectedCandidateType, 'unknown');
    assert.equal(diag.isRelay, false);
    assert.equal(diag.bytesSent, 0);
    assert.equal(diag.bytesReceived, 0);
    assert.equal(diag.reconnectAttempts, 0);
    assert.equal(diag.maxReconnectAttempts, 3);
    assert.equal(typeof diag.hasTurnConfigured, 'boolean');
  });
});

describe('2. createInitialState', () => {
  it('creates an independent state object with proper defaults', () => {
    const s = createInitialState();
    assert.equal(s.signalingState, SIGNALING_STATES.IDLE);
    assert.equal(s.realRoomCode, null);
    assert.equal(s.realSessionId, null);
    assert.equal(s.realRole, null);
    assert.equal(s.peerSessionId, null);
    assert.equal(s.peerConnectionState, PEER_CONNECTION_STATES.IDLE);
    assert.equal(s.dataChannelState, DATA_CHANNEL_STATES.IDLE);
    assert.equal(s.fileChannelState, DATA_CHANNEL_STATES.IDLE);
    assert.deepEqual(s.realChatMessages, []);
    assert.deepEqual(s.realFiles, []);
    assert.equal(s.activeTransfer, null);
    assert.equal(s.isReconnecting, false);
    assert.equal(s.reconnectAttempt, 0);
    assert.equal(s.isDiagnosticsOpen, false);
    assert.equal(s.isMobileMenuOpen, false);
    assert.ok(Array.isArray(s.demoMessages));
  });
});

describe('3. resetSessionState', () => {
  it('resets room and session data while preserving UI preferences', () => {
    const testState = createInitialState();

    // Populate active session data
    testState.signalingState = SIGNALING_STATES.CONNECTED;
    testState.realRoomCode = 'TEST-ROOM';
    testState.realSessionId = 'sess-123';
    testState.realRole = 'host';
    testState.peerSessionId = 'peer-456';
    testState.peerConnectionState = PEER_CONNECTION_STATES.CONNECTED;
    testState.dataChannelState = DATA_CHANNEL_STATES.OPEN;
    testState.fileChannelState = DATA_CHANNEL_STATES.OPEN;
    testState.isReconnecting = true;
    testState.reconnectAttempt = 2;
    testState.isDiagnosticsOpen = true;
    testState.connectionDiagnostics.bytesSent = 50000;
    testState.realChatMessages = [{ id: '1', text: 'Hello' }];
    testState.realFiles = [{ id: 'f1', name: 'doc.pdf' }];
    testState.activeTransfer = { id: 'f1' };

    // Set UI preferences that should NOT be wiped by session reset
    testState.isMobileMenuOpen = true;
    testState.demoMessages = [{ id: 'demo-1' }];

    // Reset session state
    const result = resetSessionState(testState);
    assert.equal(result, testState);

    // Verify session data was cleared
    assert.equal(testState.signalingState, SIGNALING_STATES.IDLE);
    assert.equal(testState.realRoomCode, null);
    assert.equal(testState.realSessionId, null);
    assert.equal(testState.realRole, null);
    assert.equal(testState.peerSessionId, null);
    assert.equal(testState.peerConnectionState, PEER_CONNECTION_STATES.IDLE);
    assert.equal(testState.dataChannelState, DATA_CHANNEL_STATES.IDLE);
    assert.equal(testState.fileChannelState, DATA_CHANNEL_STATES.IDLE);
    assert.equal(testState.isReconnecting, false);
    assert.equal(testState.reconnectAttempt, 0);
    assert.equal(testState.isDiagnosticsOpen, false);
    assert.equal(testState.connectionDiagnostics.bytesSent, 0);
    assert.deepEqual(testState.realChatMessages, []);
    assert.deepEqual(testState.realFiles, []);
    assert.equal(testState.activeTransfer, null);

    // Verify UI preferences were preserved
    assert.equal(testState.isMobileMenuOpen, true);
    assert.equal(testState.demoMessages.length, 1);
  });
});

describe('4. state singleton export', () => {
  it('exports an active state singleton matching default structure', () => {
    assert.ok(state);
    assert.equal(state.signalingState, SIGNALING_STATES.IDLE);
    assert.equal(typeof state.connectionDiagnostics, 'object');
  });
});
