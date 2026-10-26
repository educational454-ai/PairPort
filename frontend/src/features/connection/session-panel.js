/**
 * PairPort Session Panel & Diagnostics UI Component
 * Renders active signaling state, WebRTC connection info, and ICE telemetry drawer.
 */

import { APP_CONFIG } from '../../config/app-config.js';
import { icons } from '../../components/icons.js';
import { state } from '../../state/app-state.js';
import { SIGNALING_STATES } from '../../services/signaling.js';
import {
  peerConnectionService,
  PEER_CONNECTION_STATES,
  DATA_CHANNEL_STATES,
} from '../../services/peer-connection.js';
import { escapeHtml } from '../../utils/ui-helpers.js';

/**
 * Compute aggregate status indicators for session display and topbar pill.
 *
 * @param {object} [currentState=state] - Current state
 * @returns {object} Status classes and localized labels
 */
export function computeSessionStatusInfo(currentState = state) {
  const isDataChannelOpen = currentState.dataChannelState === DATA_CHANNEL_STATES.OPEN;
  const isFileChannelOpen = currentState.fileChannelState === DATA_CHANNEL_STATES.OPEN || peerConnectionService.isFileChannelReady();
  const isSessionActive = currentState.signalingState !== SIGNALING_STATES.IDLE;
  const isReconnecting = currentState.isReconnecting;
  const isSignalingReconnecting = currentState.isSignalingReconnecting;
  const isPeerDisconnected = currentState.isPeerDisconnected;
  const isPeerFailed = currentState.peerConnectionState === PEER_CONNECTION_STATES.FAILED;
  const isRelayActive = currentState.connectionDiagnostics?.isRelay;

  let remainingPeerSec = 0;
  if (isPeerDisconnected && currentState.peerDisconnectDeadline) {
    remainingPeerSec = Math.max(0, Math.ceil((currentState.peerDisconnectDeadline - Date.now()) / 1000));
  }

  let statusDotClass = 'waiting';
  let statusPillHtml = `Status: <strong>Idle</strong> (Pair above to connect)`;
  let metaBadgeText = 'P2P Ready';

  if (isSignalingReconnecting) {
    statusDotClass = 'reconnecting';
    const p2pSuffix = isDataChannelOpen && isFileChannelOpen ? ' (P2P Active)' : '';
    statusPillHtml = `Signaling: <strong>Reconnecting (${currentState.signalingReconnectAttempt || 1}/5)</strong>${p2pSuffix}`;
    metaBadgeText = isDataChannelOpen && isFileChannelOpen ? 'Signaling Reconnecting · P2P Active' : 'Reconnecting Signaling...';
  } else if (isPeerDisconnected) {
    statusDotClass = 'reconnecting';
    const p2pSuffix = isDataChannelOpen && isFileChannelOpen ? ' (P2P Active)' : '';
    statusPillHtml = `Peer Disconnected: <strong>Waiting (${remainingPeerSec}s grace)</strong>${p2pSuffix}`;
    metaBadgeText = isDataChannelOpen && isFileChannelOpen ? `Peer Disconnected (${remainingPeerSec}s) · P2P Active` : `Peer Disconnected (${remainingPeerSec}s)`;
  } else if (isReconnecting) {
    statusDotClass = 'reconnecting';
    statusPillHtml = `Reconnecting: <strong>Attempt ${currentState.reconnectAttempt || 1}/3</strong> (Recovering link...)`;
    metaBadgeText = 'Reconnecting WebRTC...';
  } else if (isPeerFailed) {
    const attempts = currentState.connectionDiagnostics?.reconnectAttempts ?? currentState.reconnectAttempt ?? 0;
    const maxAttempts = currentState.connectionDiagnostics?.maxReconnectAttempts ?? 3;
    const isRetriesExhausted = attempts >= maxAttempts;

    statusDotClass = 'error';
    statusPillHtml = isRetriesExhausted
      ? `Connection: <strong>Failed</strong> (Retries exhausted. TURN relay recommended)`
      : `Connection: <strong>Failed</strong> (Direct connectivity unavailable. TURN relay recommended)`;
    metaBadgeText = 'Connection Failed';
  } else if (isDataChannelOpen || isFileChannelOpen) {
    if (isRelayActive) {
      statusDotClass = 'relay';
      statusPillHtml = `TURN Relay: <strong>Peer Connected</strong> (Encrypted Transport)`;
      metaBadgeText = 'TURN Relay Active';
    } else {
      statusDotClass = 'online';
      statusPillHtml = `P2P Direct: <strong>Peer Connected</strong> (WebRTC DataChannels)`;
      metaBadgeText = 'Direct P2P (0 Server Relay)';
    }
  } else if (isSessionActive) {
    statusDotClass = 'waiting';
    statusPillHtml = `Signaling: <strong>${currentState.signalingState.toUpperCase()}</strong>`;
    metaBadgeText = 'Negotiating WebRTC...';
  }

  return {
    statusDotClass,
    statusPillHtml,
    metaBadgeText,
    isDataChannelOpen,
    isFileChannelOpen,
    isSessionActive,
    isReconnecting,
    isSignalingReconnecting,
    isPeerDisconnected,
    isPeerFailed,
    isRelayActive,
  };
}

/**
 * Render the live session panel and accessible WebRTC diagnostics drawer.
 *
 * @param {object} [currentState=state] - Current application state
 * @returns {string} HTML string
 */
export function renderLiveSessionPanel(currentState = state) {
  if (currentState.signalingState === SIGNALING_STATES.IDLE) {
    return '';
  }

  const isSignalingConnected = currentState.signalingState === SIGNALING_STATES.CONNECTED;
  const isWaiting = currentState.signalingState === SIGNALING_STATES.WAITING;
  const isCreating = currentState.signalingState === SIGNALING_STATES.CREATING;
  const isJoining = currentState.signalingState === SIGNALING_STATES.JOINING;
  const isSignalingError = currentState.signalingState === SIGNALING_STATES.ERROR;

  const isPeerConnected = currentState.peerConnectionState === PEER_CONNECTION_STATES.CONNECTED;
  const isPeerConnecting = currentState.peerConnectionState === PEER_CONNECTION_STATES.CONNECTING;
  const isPeerFailed = currentState.peerConnectionState === PEER_CONNECTION_STATES.FAILED;
  const isReconnecting = currentState.isReconnecting;
  const isSignalingReconnecting = currentState.isSignalingReconnecting;
  const isPeerDisconnected = currentState.isPeerDisconnected;
  const isDataChannelOpen = currentState.dataChannelState === DATA_CHANNEL_STATES.OPEN;
  const isFileChannelOpen = currentState.fileChannelState === DATA_CHANNEL_STATES.OPEN || peerConnectionService.isFileChannelReady();
  const isRelayActive = currentState.connectionDiagnostics?.isRelay;

  let remainingPeerSec = 0;
  if (isPeerDisconnected && currentState.peerDisconnectDeadline) {
    remainingPeerSec = Math.max(0, Math.ceil((currentState.peerDisconnectDeadline - Date.now()) / 1000));
  }

  let overallStatusClass = 'waiting';
  let overallStatusText = 'Connecting...';

  if (isSignalingReconnecting) {
    overallStatusClass = 'reconnecting';
    if (isDataChannelOpen && isFileChannelOpen) {
      overallStatusText = `Signaling Reconnecting (${currentState.signalingReconnectAttempt || 1}/5) · Direct P2P channels still active`;
    } else {
      overallStatusText = `Reconnecting to signaling server (Attempt ${currentState.signalingReconnectAttempt || 1}/5)...`;
    }
  } else if (isPeerDisconnected) {
    overallStatusClass = 'reconnecting';
    if (isDataChannelOpen && isFileChannelOpen) {
      overallStatusText = `Peer disconnected from signaling (${remainingPeerSec}s grace remaining) · Direct P2P channels still active`;
    } else {
      overallStatusText = `Peer disconnected temporarily. Waiting for peer to reconnect (${remainingPeerSec}s remaining)...`;
    }
  } else if (isReconnecting) {
    overallStatusClass = 'reconnecting';
    overallStatusText = `Reconnecting WebRTC link (Attempt ${currentState.reconnectAttempt || 1}/3)...`;
  } else if (isPeerFailed) {
    const attempts = currentState.connectionDiagnostics?.reconnectAttempts ?? currentState.reconnectAttempt ?? 0;
    const maxAttempts = currentState.connectionDiagnostics?.maxReconnectAttempts ?? 3;
    const isRetriesExhausted = attempts >= maxAttempts;

    overallStatusClass = 'error';
    overallStatusText = isRetriesExhausted
      ? 'WebRTC Connection Failed (Retries exhausted. TURN relay recommended)'
      : 'WebRTC Connection Failed (Direct connectivity unavailable. TURN relay recommended)';
  } else if (isDataChannelOpen && isFileChannelOpen) {
    if (isRelayActive) {
      overallStatusClass = 'relay';
      overallStatusText = 'Connected via TURN Relay · WebRTC DataChannels Active (P2P Encrypted)';
    } else {
      overallStatusClass = 'online';
      overallStatusText = 'Connected Directly (P2P) · WebRTC DataChannels Active (Zero Server Relay)';
    }
  } else if (isDataChannelOpen || isFileChannelOpen) {
    if (isRelayActive) {
      overallStatusClass = 'relay';
      overallStatusText = 'Connected via TURN Relay · WebRTC DataChannel Active';
    } else {
      overallStatusClass = 'online';
      overallStatusText = 'Connected Directly (P2P) · WebRTC DataChannel Active';
    }
  } else if (isPeerConnected) {
    overallStatusClass = isRelayActive ? 'relay' : 'online';
    overallStatusText = isRelayActive
      ? 'WebRTC Peer Connected via TURN Relay (Opening DataChannels...)'
      : 'WebRTC Peer Connected Directly (Opening DataChannels...)';
  } else if (isPeerConnecting) {
    overallStatusClass = 'waiting';
    overallStatusText = 'Negotiating WebRTC ICE Candidates & Handshake...';
  } else if (isSignalingConnected && !isDataChannelOpen && !isFileChannelOpen) {
    overallStatusClass = 'waiting';
    overallStatusText = 'Signaling Connected · WebRTC DataChannels closed';
  } else if (isWaiting) {
    overallStatusClass = 'waiting';
    overallStatusText = 'Waiting for Peer to Join Room...';
  } else if (isCreating) {
    overallStatusClass = 'waiting';
    overallStatusText = 'Creating room on signaling server...';
  } else if (isJoining) {
    overallStatusClass = 'waiting';
    overallStatusText = 'Joining room on signaling server...';
  } else if (isSignalingError) {
    overallStatusClass = 'error';
    overallStatusText = `Signaling Error: ${escapeHtml(currentState.signalingError || 'Failed')}`;
  }

  const diag = currentState.connectionDiagnostics || {};

  return `
    <div class="live-session-panel" role="region" aria-label="Active WebRTC signaling session">
      <div class="live-session-header">
        <div class="live-status-group">
          <span class="status-indicator-dot ${overallStatusClass}"></span>
          <span class="live-status-text">${overallStatusText}</span>
        </div>
        <button type="button" id="leave-room-btn" class="btn btn-danger btn-sm" aria-label="Leave active room">
          ${icons.x(16)}
          <span>Leave Room</span>
        </button>
      </div>

      ${currentState.realRoomCode ? `
        <div class="live-code-row">
          <div class="live-code-display">
            <span class="live-code-label">Active Room Code</span>
            <span class="live-code-val" id="active-live-code">${escapeHtml(currentState.realRoomCode)}</span>
          </div>
          <div class="code-actions-group">
            <button type="button" id="copy-live-code-btn" class="btn btn-secondary btn-copy" aria-label="Copy active room code">
              ${icons.copy(18)}
              <span class="copy-live-text">Copy code</span>
            </button>
            ${currentState.invitationToken ? `
              <button type="button" id="copy-live-invite-btn" class="btn btn-primary btn-copy btn-copy-invite" aria-label="Copy secure invite link">
                ${icons.sparkles(16)}
                <span class="copy-live-invite-text">Copy Invite Link</span>
              </button>
            ` : ''}
          </div>
        </div>
      ` : ''}

      <div class="live-session-details">
        <div class="detail-item">
          <span class="detail-label">Your Role</span>
          <span class="detail-val">${currentState.realRole ? (currentState.realRole === 'host' ? 'Host (Creator)' : 'Guest (Participant)') : 'Assigning...'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Signaling Status</span>
          <span class="detail-val">${
            isSignalingReconnecting
              ? `Reconnecting (${currentState.signalingReconnectAttempt || 1}/5)`
              : isPeerDisconnected
              ? `Peer Disconnected (${remainingPeerSec}s)`
              : isSignalingConnected
              ? 'Connected (2 Peers)'
              : isWaiting
              ? 'Waiting for Peer (1/2)'
              : 'Connecting...'
          }</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">WebRTC Peer Connection</span>
          <span class="detail-val ${isPeerConnected ? 'status-completed' : isPeerFailed ? 'status-failed' : ''}">
            ${isReconnecting ? `RECONNECTING (${currentState.reconnectAttempt || 1}/3)` : isPeerConnected ? (isRelayActive ? 'Connected (TURN Relay)' : 'Connected (Direct P2P)') : currentState.peerConnectionState.toUpperCase()}
          </span>
        </div>
        <div class="detail-item">
          <span class="detail-label">DataChannel (Chat)</span>
          <span class="detail-val ${isDataChannelOpen ? 'status-completed' : ''}">${isDataChannelOpen ? 'OPEN (P2P Live)' : currentState.dataChannelState.toUpperCase()}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">DataChannel (Files)</span>
          <span class="detail-val ${isFileChannelOpen ? 'status-completed' : ''}">${isFileChannelOpen ? 'OPEN (P2P Streaming)' : currentState.fileChannelState.toUpperCase()}</span>
        </div>
      </div>

      <!-- Phase 6: Accessible WebRTC Diagnostics & ICE Telemetry Drawer -->
      <details class="diagnostics-details" id="webrtc-diagnostics-drawer" ${currentState.isDiagnosticsOpen ? 'open' : ''}>
        <summary class="diagnostics-summary" aria-label="Toggle WebRTC network diagnostics">
          <span class="diagnostics-summary-left">
            ${(icons.activity || icons.wifi)(14)}
            <span>Connection Diagnostics & ICE Telemetry</span>
          </span>
          <span class="diagnostics-mode-badge ${
            isSignalingReconnecting || isPeerDisconnected || isReconnecting
              ? 'badge-reconnecting'
              : diag.isRelay
              ? 'badge-relay'
              : isPeerConnected
              ? 'badge-direct'
              : 'badge-neutral'
          }">
            ${
              isSignalingReconnecting
                ? `Signaling (${currentState.signalingReconnectAttempt || 1}/5)`
                : isPeerDisconnected
                ? `Peer Reconnecting (${remainingPeerSec}s)`
                : isReconnecting
                ? `Reconnecting (${currentState.reconnectAttempt || 1}/3)`
                : diag.isRelay
                ? 'TURN Relay'
                : isPeerConnected
                ? 'Direct P2P'
                : 'Configuring'
            }
          </span>
        </summary>
        <div class="diagnostics-grid">
          <div class="diag-card">
            <span class="diag-label">Connection Mode</span>
            <span class="diag-value ${diag.isRelay ? 'val-relay' : isPeerConnected ? 'val-direct' : ''}">
              ${
                isSignalingReconnecting
                  ? 'Reconnecting Signaling'
                  : isPeerDisconnected
                  ? 'Peer Disconnected (Grace Period)'
                  : diag.isRelay
                  ? 'Relayed (TURN Transport)'
                  : isPeerConnected
                  ? 'Direct P2P (Peer-to-Peer)'
                  : isReconnecting
                  ? 'Reconnecting'
                  : 'Negotiating'
              }
            </span>
          </div>
          <div class="diag-card">
            <span class="diag-label">ICE Connection State</span>
            <span class="diag-value">${(diag.iceConnectionState || 'idle').toUpperCase()}</span>
          </div>
          <div class="diag-card">
            <span class="diag-label">ICE Gathering State</span>
            <span class="diag-value">${(diag.iceGatheringState || 'idle').toUpperCase()}</span>
          </div>
          <div class="diag-card">
            <span class="diag-label">Selected Candidate Type</span>
            <span class="diag-value">${
              diag.selectedCandidateType === 'relay'
                ? 'Relay (TURN)'
                : diag.selectedCandidateType === 'srflx'
                ? 'Reflexive (STUN NAT)'
                : diag.selectedCandidateType === 'host'
                ? 'Host (Local LAN)'
                : diag.selectedCandidateType || 'Discovering'
            }</span>
          </div>
          <div class="diag-card">
            <span class="diag-label">Reconnection Retries</span>
            <span class="diag-value">${diag.reconnectAttempts || 0} / ${diag.maxReconnectAttempts || 3}</span>
          </div>
          <div class="diag-card">
            <span class="diag-label">Round-Trip Latency (RTT)</span>
            <span class="diag-value">${typeof diag.roundTripTimeMs === 'number' ? `${diag.roundTripTimeMs} ms` : 'N/A'}</span>
          </div>
          <div class="diag-card">
            <span class="diag-label">TURN Relay Configured</span>
            <span class="diag-value">${APP_CONFIG.iceConfig?.isTurnConfigured ? 'Yes (Credentials Loaded)' : 'No (STUN-only Mode)'}</span>
          </div>
          <div class="diag-card">
            <span class="diag-label">Relay Candidate Available</span>
            <span class="diag-value">${diag.hasRelayCandidate ? 'Yes (Relay Present)' : 'No (Direct / STUN Only)'}</span>
          </div>
          ${diag.candidatePairFailureReason ? `
          <div class="diag-card">
            <span class="diag-label">Pair Failure Reason</span>
            <span class="diag-value">${diag.candidatePairFailureReason}</span>
          </div>
          ` : ''}
          <div class="diag-card">
            <span class="diag-label">Candidate Types</span>
            <span class="diag-value">Local: [${(diag.localCandidateTypes || []).join(', ') || 'none'}] · Remote: [${(diag.remoteCandidateTypes || []).join(', ') || 'none'}]</span>
          </div>
          <div class="diag-card">
            <span class="diag-label">Privacy Shield</span>
            <span class="diag-value val-shielded">IP Addresses & Ports Masked</span>
          </div>
        </div>
      </details>
    </div>
  `;
}

/**
 * Update the live session container, workspace topbar status pill, and latency badge.
 *
 * @param {HTMLElement} root - Root application element
 * @param {object} [currentState=state] - Current application state
 */
export function updateSessionStatusUI(root, currentState = state) {
  if (!root) return;

  const container = root.querySelector('#live-session-container');
  if (container) {
    container.innerHTML = renderLiveSessionPanel(currentState);
  }

  const { statusDotClass, statusPillHtml, metaBadgeText } = computeSessionStatusInfo(currentState);

  const statusPill = root.querySelector('.workspace-topbar .peer-status-pill');
  if (statusPill) {
    statusPill.innerHTML = `
      <span class="status-indicator-dot ${statusDotClass}"></span>
      <span class="peer-label">${statusPillHtml}</span>
    `;
  }

  const latencyBadgeText = root.querySelector('.workspace-topbar .latency-badge span');
  if (latencyBadgeText) {
    latencyBadgeText.textContent = metaBadgeText;
  }

  const workspaceCode = root.querySelector('#workspace-room-code');
  if (workspaceCode) {
    workspaceCode.textContent = currentState.realRoomCode || 'Not Connected';
  }
}
