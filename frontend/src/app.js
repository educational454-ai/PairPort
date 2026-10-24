/**
 * PairPort Main Application Component
 * Phase 4 — WebRTC Peer-to-Peer Connection & Real-Time Ephemeral Chat
 *
 * Vanilla JavaScript implementation featuring:
 * - Real WebSocket signaling relay for WebRTC offer/answer/ICE candidates
 * - Direct RTCPeerConnection and RTCDataChannel for real-time chat
 * - Zero chat messages routed through backend servers
 * - Strict XSS protection and input sanitization
 * - Separation of live P2P chat from sample demo preview
 */
import { APP_CONFIG } from './config/app-config.js';
import { icons } from './components/icons.js';
import { showToast } from './components/toast.js';
import { initModal, showConfirmDialog } from './components/modal.js';
import { signalingClient, SIGNALING_STATES } from './services/signaling.js';
import {
  peerConnectionService,
  PEER_CONNECTION_STATES,
  DATA_CHANNEL_STATES,
  TRANSFER_STATES,
} from './services/peer-connection.js';
import {
  validateRoomCode,
  formatFileSize,
  formatTime,
  escapeHtml,
  filterClearableFiles,
} from './utils/ui-helpers.js';

import { state, resetSessionState } from './state/app-state.js';
import {
  renderNavbar,
  initNavbar,
  renderHero,
  renderFeatures,
  renderHowItWorks,
  renderFooter,
} from './features/layout/index.js';

/** Render the complete Phase 4 UI and wire up interactions */
export function startApp(root = document.querySelector('#app')) {
  if (!root) {
    throw new Error('PairPort app root (#app) was not found.');
  }

  // Render complete HTML markup
  root.innerHTML = `
    <div class="site-wrapper">
      ${renderNavbar()}
      <main id="main-content">
        ${renderHero()}
        ${renderFeatures()}
        ${renderHowItWorks()}
        ${renderPairingSection()}
        ${renderWorkspaceSection()}
      </main>
      ${renderFooter()}
    </div>
  `;

  // Initialize navbar interactions (mobile menu toggle & roadmap trigger)
  initNavbar(root);

  // Initialize roadmap modal
  initModal();

  // Attach all DOM event listeners
  bindEvents(root);

  // Subscribe to real-time WebSocket signaling events
  bindSignalingEvents(root);

  // Subscribe to real-time WebRTC PeerConnection events
  bindWebRTCEvents(root);
}

// ==========================================
// RENDER HELPERS
// ==========================================

function renderPairingSection() {
  return `
    <section id="pairing" class="pairing-section" aria-labelledby="pairing-heading">
      <div class="section-container">
        <div class="section-header">
          <span class="section-eyebrow">ROOM PAIRING & WEBRTC HANDSHAKE</span>
          <h2 id="pairing-heading" class="section-title">Pair with a peer</h2>
          <p class="section-subtitle">
            Create a room or enter a code to establish a direct WebRTC data connection.
          </p>
        </div>

        <!-- Quick Start Onboarding Guide (Step 2) -->
        <div class="quick-start-guide" role="region" aria-label="First-time quick start guide">
          <div class="quick-start-header">
            <span class="quick-start-title">
              ${icons.sparkles(16)}
              <span>How to connect with a peer</span>
            </span>
            <span class="quick-start-badge">Direct WebRTC · Zero Server Storage</span>
          </div>
          <div class="quick-start-steps">
            <div class="guide-step">
              <span class="guide-step-num">1</span>
              <div class="guide-step-body">
                <strong>Host or Join</strong>
                <p>Click "Create Room" to generate a code, or enter your peer's room code to join.</p>
              </div>
            </div>
            <div class="guide-step">
              <span class="guide-step-num">2</span>
              <div class="guide-step-body">
                <strong>Share Room Code</strong>
                <p>Send the 6-character code to your peer. WebRTC pairing negotiates automatically.</p>
              </div>
            </div>
            <div class="guide-step">
              <span class="guide-step-num">3</span>
              <div class="guide-step-body">
                <strong>Direct P2P Session</strong>
                <p>Once paired, stream files directly up to 100 MB and chat with zero server logging.</p>
              </div>
            </div>
          </div>
        </div>

        <!-- Live Session Container (dynamic based on signaling & peer connection state) -->
        <div id="live-session-container">
          ${renderLiveSessionPanel()}
        </div>

        <!-- Create & Join Cards Grid -->
        <div id="pairing-cards-grid" class="pairing-grid ${state.signalingState !== SIGNALING_STATES.IDLE ? 'collapsed' : ''}">
          <!-- Create Room Card -->
          <div class="pairing-card create-card">
            <div class="card-header">
              <div class="card-icon-box">
                ${icons.sparkles(22)}
              </div>
              <div class="card-title-group">
                <h3 class="card-title">Create a room</h3>
                <p class="card-subtext">Host a session and share the server-generated code with your peer.</p>
              </div>
            </div>

            <div class="code-generator-box">
              <span class="code-label">Room Code (Host Mode)</span>
              <div class="code-display-row">
                <code id="display-room-code" class="room-code-tag">${state.realRoomCode || 'PORT-????'}</code>
                <button type="button" id="copy-code-btn" class="btn btn-secondary btn-copy" aria-label="Copy room code" ${!state.realRoomCode ? 'disabled' : ''}>
                  <span class="copy-icon-wrap">${icons.copy(18)}</span>
                  <span class="copy-btn-text">Copy code</span>
                </button>
              </div>
              <p class="code-helper-text">
                Creates a session on the signaling server and waits for one peer to establish the WebRTC handshake.
              </p>
            </div>

            <div class="card-actions">
              <button type="button" id="create-room-btn" class="btn btn-primary btn-full">
                ${icons.refresh(18)}
                <span id="create-room-btn-text">Create Room (Host Session)</span>
              </button>
            </div>
          </div>

          <!-- Join Room Card -->
          <div class="pairing-card join-card">
            <div class="card-header">
              <div class="card-icon-box">
                ${icons.user(22)}
              </div>
              <div class="card-title-group">
                <h3 class="card-title">Join a room</h3>
                <p class="card-subtext">Enter the room code provided by your peer.</p>
              </div>
            </div>

            <form id="join-room-form" class="join-form" novalidate>
              <div class="form-field">
                <label for="room-code-input" class="form-label">Room Code</label>
                <div class="input-wrapper">
                  <input
                    type="text"
                    id="room-code-input"
                    class="form-input code-input"
                    placeholder="e.g. PORT-7K2M"
                    maxlength="16"
                    autocomplete="off"
                    spellcheck="false"
                    aria-describedby="join-code-feedback"
                  />
                  <button type="button" id="paste-sample-code-btn" class="input-inline-btn" title="Paste demo code">
                    Use Sample
                  </button>
                </div>
                <div id="join-code-feedback" class="form-feedback" aria-live="polite"></div>
                <p class="input-helper">Codes are formatted like <code>PORT-XXXX</code> or 6 letters/digits.</p>
              </div>

              <div class="card-actions">
                <button type="submit" id="join-room-btn" class="btn btn-primary btn-full">
                  <span id="join-room-btn-text">Join Room</span>
                  ${icons.arrowRight(16)}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderLiveSessionPanel() {
  if (state.signalingState === SIGNALING_STATES.IDLE) {
    return '';
  }

  const isSignalingConnected = state.signalingState === SIGNALING_STATES.CONNECTED;
  const isWaiting = state.signalingState === SIGNALING_STATES.WAITING;
  const isCreating = state.signalingState === SIGNALING_STATES.CREATING;
  const isJoining = state.signalingState === SIGNALING_STATES.JOINING;
  const isSignalingError = state.signalingState === SIGNALING_STATES.ERROR;

  const isPeerConnected = state.peerConnectionState === PEER_CONNECTION_STATES.CONNECTED;
  const isPeerConnecting = state.peerConnectionState === PEER_CONNECTION_STATES.CONNECTING;
  const isPeerFailed = state.peerConnectionState === PEER_CONNECTION_STATES.FAILED;
  const isReconnecting = state.isReconnecting;
  const isDataChannelOpen = state.dataChannelState === DATA_CHANNEL_STATES.OPEN;
  const isFileChannelOpen = state.fileChannelState === DATA_CHANNEL_STATES.OPEN || peerConnectionService.isFileChannelReady();
  const isRelayActive = state.connectionDiagnostics.isRelay;

  let overallStatusClass = 'waiting';
  let overallStatusText = 'Connecting...';

  if (isReconnecting) {
    overallStatusClass = 'reconnecting';
    overallStatusText = `Reconnecting WebRTC link (Attempt ${state.reconnectAttempt || 1}/3)...`;
  } else if (isPeerFailed) {
    overallStatusClass = 'error';
    overallStatusText = 'WebRTC Connection Failed (Retries exhausted. TURN relay recommended)';
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
    overallStatusText = `Signaling Error: ${escapeHtml(state.signalingError || 'Failed')}`;
  }

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

      ${state.realRoomCode ? `
        <div class="live-code-row">
          <div class="live-code-display">
            <span class="live-code-label">Active Room Code</span>
            <span class="live-code-val" id="active-live-code">${escapeHtml(state.realRoomCode)}</span>
          </div>
          <button type="button" id="copy-live-code-btn" class="btn btn-secondary btn-copy" aria-label="Copy active room code">
            ${icons.copy(18)}
            <span class="copy-live-text">Copy code</span>
          </button>
        </div>
      ` : ''}

      <div class="live-session-details">
        <div class="detail-item">
          <span class="detail-label">Your Role</span>
          <span class="detail-val">${state.realRole ? (state.realRole === 'host' ? 'Host (Creator)' : 'Guest (Participant)') : 'Assigning...'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Signaling Status</span>
          <span class="detail-val">${isSignalingConnected ? 'Connected (2 Peers)' : isWaiting ? 'Waiting for Peer (1/2)' : 'Connecting...'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">WebRTC Peer Connection</span>
          <span class="detail-val ${isPeerConnected ? 'status-completed' : isPeerFailed ? 'status-failed' : ''}">
            ${isReconnecting ? `RECONNECTING (${state.reconnectAttempt || 1}/3)` : isPeerConnected ? (isRelayActive ? 'Connected (TURN Relay)' : 'Connected (Direct P2P)') : state.peerConnectionState.toUpperCase()}
          </span>
        </div>
        <div class="detail-item">
          <span class="detail-label">DataChannel (Chat)</span>
          <span class="detail-val ${isDataChannelOpen ? 'status-completed' : ''}">${isDataChannelOpen ? 'OPEN (P2P Live)' : state.dataChannelState.toUpperCase()}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">DataChannel (Files)</span>
          <span class="detail-val ${isFileChannelOpen ? 'status-completed' : ''}">${isFileChannelOpen ? 'OPEN (P2P Streaming)' : state.fileChannelState.toUpperCase()}</span>
        </div>
      </div>

      <!-- Phase 6: Accessible WebRTC Diagnostics & ICE Telemetry Drawer -->
      <details class="diagnostics-details" id="webrtc-diagnostics-drawer" ${state.isDiagnosticsOpen ? 'open' : ''}>
        <summary class="diagnostics-summary" aria-label="Toggle WebRTC network diagnostics">
          <span class="diagnostics-summary-left">
            ${icons.activity(14)}
            <span>Connection Diagnostics & ICE Telemetry</span>
          </span>
          <span class="diagnostics-mode-badge ${
            isReconnecting
              ? 'badge-reconnecting'
              : state.connectionDiagnostics.isRelay
              ? 'badge-relay'
              : isPeerConnected
              ? 'badge-direct'
              : 'badge-neutral'
          }">
            ${
              isReconnecting
                ? `Reconnecting (${state.reconnectAttempt || 1}/3)`
                : state.connectionDiagnostics.isRelay
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
            <span class="diag-value ${state.connectionDiagnostics.isRelay ? 'val-relay' : isPeerConnected ? 'val-direct' : ''}">
              ${
                state.connectionDiagnostics.isRelay
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
            <span class="diag-value">${(state.connectionDiagnostics.iceConnectionState || 'idle').toUpperCase()}</span>
          </div>
          <div class="diag-card">
            <span class="diag-label">ICE Gathering State</span>
            <span class="diag-value">${(state.connectionDiagnostics.iceGatheringState || 'idle').toUpperCase()}</span>
          </div>
          <div class="diag-card">
            <span class="diag-label">Selected Candidate Type</span>
            <span class="diag-value">${
              state.connectionDiagnostics.selectedCandidateType === 'relay'
                ? 'Relay (TURN)'
                : state.connectionDiagnostics.selectedCandidateType === 'srflx'
                ? 'Reflexive (STUN NAT)'
                : state.connectionDiagnostics.selectedCandidateType === 'host'
                ? 'Host (Local LAN)'
                : state.connectionDiagnostics.selectedCandidateType || 'Discovering'
            }</span>
          </div>
          <div class="diag-card">
            <span class="diag-label">Reconnection Retries</span>
            <span class="diag-value">${state.connectionDiagnostics.reconnectAttempts || 0} / ${state.connectionDiagnostics.maxReconnectAttempts || 3}</span>
          </div>
          <div class="diag-card">
            <span class="diag-label">Round-Trip Latency (RTT)</span>
            <span class="diag-value">${typeof state.connectionDiagnostics.roundTripTimeMs === 'number' ? `${state.connectionDiagnostics.roundTripTimeMs} ms` : 'N/A'}</span>
          </div>
          <div class="diag-card">
            <span class="diag-label">TURN Relay Configured</span>
            <span class="diag-value">${APP_CONFIG.iceConfig?.isTurnConfigured ? 'Yes (Credentials Loaded)' : 'No (STUN-only Mode)'}</span>
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

function renderWorkspaceSection() {
  const isDataChannelOpen = state.dataChannelState === DATA_CHANNEL_STATES.OPEN;
  const isFileChannelOpen = state.fileChannelState === DATA_CHANNEL_STATES.OPEN || peerConnectionService.isFileChannelReady();
  const isSessionActive = state.signalingState !== SIGNALING_STATES.IDLE;
  const isReconnecting = state.isReconnecting;
  const isPeerFailed = state.peerConnectionState === PEER_CONNECTION_STATES.FAILED;
  const isRelayActive = state.connectionDiagnostics.isRelay;

  let statusDotClass = 'waiting';
  let statusPillHtml = `Status: <strong>Idle</strong> (Pair above to connect)`;
  let metaBadgeText = 'P2P Ready';

  if (isReconnecting) {
    statusDotClass = 'reconnecting';
    statusPillHtml = `Reconnecting: <strong>Attempt ${state.reconnectAttempt || 1}/3</strong> (Recovering link...)`;
    metaBadgeText = 'Reconnecting WebRTC...';
  } else if (isPeerFailed) {
    statusDotClass = 'error';
    statusPillHtml = `Connection: <strong>Failed</strong> (Retries exhausted)`;
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
    statusPillHtml = `Signaling: <strong>${state.signalingState.toUpperCase()}</strong>`;
    metaBadgeText = 'Negotiating WebRTC...';
  }

  return `
    <section id="workspace" class="workspace-section" aria-labelledby="workspace-heading">
      <div class="section-container">
        <div class="section-header">
          <div class="demo-badge-banner ${isDataChannelOpen || isFileChannelOpen ? 'active-banner' : ''}">
            <span class="status-indicator-dot ${statusDotClass}"></span>
            <span>${
              isReconnecting
                ? 'RECONNECTING WEBRTC LINK · IN-FLIGHT TRANSFERS PAUSED'
                : isDataChannelOpen && isFileChannelOpen
                ? (isRelayActive ? 'WEBRTC ACTIVE · TURN RELAY DATACHANNELS (CHAT & FILES)' : 'WEBRTC P2P ACTIVE · DIRECT SCTP DATACHANNELS (CHAT & FILES)')
                : isDataChannelOpen
                ? 'WEBRTC P2P CHAT ACTIVE · DIRECT SCTP DATACHANNEL'
                : 'SHARING WORKSPACE & CHAT'
            }</span>
          </div>
          <h2 id="workspace-heading" class="section-title">Direct P2P Workspace</h2>
          <p class="section-subtitle">
            ${isDataChannelOpen || isFileChannelOpen
              ? (isRelayActive
                  ? 'Real-time peer-to-peer text chat and chunked binary file transfers stream via encrypted TURN relay. End-to-end data remains private.'
                  : 'Real-time peer-to-peer text chat and chunked binary file transfers stream directly between browsers. Zero bytes route through the server.')
              : 'Pair with a peer above to establish direct WebRTC DataChannels for live ephemeral chat and chunked peer-to-peer file transfers up to 100 MB.'}
          </p>
        </div>

        <div class="workspace-card">
          <!-- Workspace Session Top Bar -->
          <div class="workspace-topbar">
            <div class="topbar-session-info">
              <div class="room-chip">
                <span class="chip-label">Room:</span>
                <strong id="workspace-room-code">${escapeHtml(state.realRoomCode || 'Not Connected')}</strong>
              </div>

              <div class="peer-status-pill">
                <span class="status-indicator-dot ${statusDotClass}"></span>
                <span class="peer-label">
                  ${statusPillHtml}
                </span>
              </div>
            </div>

            <div class="topbar-meta">
              <span class="latency-badge" title="Connection Mode">
                ${icons.wifi(14)}
                <span>${metaBadgeText}</span>
              </span>
              <button type="button" id="clear-chat-btn" class="btn btn-ghost btn-xs" title="Clear chat messages">
                ${icons.refresh(14)}
                <span>Clear Chat</span>
              </button>
            </div>
          </div>

          <!-- Workspace Split Grid -->
          <div class="workspace-grid">
            <!-- Left Column: Real-Time WebRTC File Sharing -->
            <div class="workspace-column file-hub-column">
              <div class="column-header">
                <div class="column-title-group">
                  <span class="col-icon">${icons.upload(18)}</span>
                  <h3 class="column-title">P2P File Transfer</h3>
                </div>
                <span id="file-channel-badge" class="badge ${isFileChannelOpen ? 'badge-success' : 'badge-subtle'}">
                  ${isFileChannelOpen ? 'P2P FileChannel Open' : 'Waiting for Peer'}
                </span>
              </div>

              <!-- Drag & Drop Zone -->
              <div id="file-drop-zone" class="drop-zone ${!isFileChannelOpen ? 'drop-zone-disabled' : ''}" tabindex="0" role="region" aria-label="File drop zone">
                <input type="file" id="file-browse-input" multiple class="sr-only" aria-label="Upload files" ${!isFileChannelOpen ? 'disabled' : ''} />
                <div class="drop-zone-icon">
                  ${icons.upload(36)}
                </div>
                <p class="drop-zone-title">${isFileChannelOpen ? 'Drop files here to share directly' : 'Connect to a peer to enable file transfers'}</p>
                <p class="drop-zone-sub">or <button type="button" id="browse-files-btn" class="btn-link" ${!isFileChannelOpen ? 'disabled' : ''}>browse from your computer</button></p>
                <div class="drop-zone-footer">
                  <span>${icons.shield(14)} Direct P2P chunked streaming · Max 100 MB · Zero cloud storage</span>
                </div>
              </div>

              <!-- Active Transfer Panel Container -->
              <div id="active-transfer-container">
                ${renderActiveTransferPanel()}
              </div>

              <!-- Session Files List -->
              <div class="files-list-section">
                <div class="files-list-header">
                  <h4 class="list-heading">Session Files (Live)</h4>
                  <div class="files-header-actions">
                    <span id="files-count-badge" class="badge badge-neutral">${state.realFiles.length} items</span>
                    <button type="button" id="clear-files-btn" class="btn-clear-history" title="Clear transfer records from session" ${state.realFiles.length === 0 ? 'disabled' : ''}>
                      ${icons.trash(14)}
                      <span>Clear History</span>
                    </button>
                  </div>
                </div>

                <ul id="files-list" class="files-list" role="list">
                  ${renderFilesList(state.realFiles)}
                </ul>
              </div>
            </div>

            <!-- Right Column: Real-time WebRTC Ephemeral Chat -->
            <div class="workspace-column chat-column">
              <div class="column-header">
                <div class="column-title-group">
                  <span class="col-icon">${icons.chat(18)}</span>
                  <h3 class="column-title">Real-Time P2P Chat</h3>
                </div>
                <div class="chat-header-actions">
                  <span id="chat-channel-badge" class="badge ${isDataChannelOpen ? 'badge-success' : 'badge-subtle'}">
                    ${isDataChannelOpen ? 'P2P DataChannel Open' : 'Waiting for P2P'}
                  </span>
                  <button type="button" id="chat-col-clear-btn" class="btn-clear-history" title="Clear chat messages" ${state.realChatMessages.length === 0 ? 'disabled' : ''}>
                    ${icons.trash(14)}
                    <span>Clear Chat</span>
                  </button>
                </div>
              </div>

              <div class="chat-notice">
                ${icons.lock(14)}
                <span id="chat-notice-text">
                  ${isDataChannelOpen
                    ? 'Direct WebRTC DataChannel active. Messages stream directly browser-to-browser with zero server logging.'
                    : 'Messages will stream directly over WebRTC DataChannel. Connect with a peer above to activate live chat.'}
                </span>
              </div>

              <!-- Chat messages scroll container -->
              <div id="chat-messages-container" class="chat-messages" role="log" aria-live="polite" aria-label="Session chat messages">
                ${renderChatMessages()}
              </div>

              <!-- Message input form -->
              <form id="chat-form" class="chat-input-form" novalidate>
                <div class="chat-input-row">
                  <input
                    type="text"
                    id="chat-input"
                    class="form-input chat-input"
                    placeholder="${isDataChannelOpen ? 'Type a real-time message to peer (P2P)...' : 'Connect to a peer above to enable live P2P chat...'}"
                    maxlength="1000"
                    autocomplete="off"
                    aria-label="Type a message"
                    ${!isDataChannelOpen ? 'disabled' : ''}
                  />
                  <button
                    type="submit"
                    id="chat-send-btn"
                    class="btn btn-primary btn-send"
                    aria-label="Send message"
                    ${!isDataChannelOpen ? 'disabled' : ''}
                  >
                    ${icons.send(18)}
                  </button>
                </div>
                <div class="chat-form-footer">
                  <span class="input-hint">
                    ${isDataChannelOpen ? 'Press Enter to send directly via WebRTC DataChannel' : 'Direct WebRTC connection required to send messages'}
                  </span>
                  <span id="char-counter" class="char-counter">1000</span>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderActiveTransferPanel() {
  const active = state.activeTransfer;
  const isReady = peerConnectionService.isFileChannelReady();

  if (!active) {
    return `
      <div id="active-transfer-panel" class="active-transfer-panel standby">
        <div class="transfer-panel-header">
          <span class="panel-eyebrow">CHUNKED STREAMING STATION</span>
          <span class="speed-indicator ${isReady ? 'status-completed' : ''}">${isReady ? 'P2P Ready (Standby)' : 'Awaiting Peer'}</span>
        </div>
        <div class="standby-transfer-notice">
          <span class="standby-icon">${icons.upload(20)}</span>
          <p class="standby-text">
            ${isReady
              ? 'Ready to stream files directly to your peer. Drop or browse files above (up to 100 MB).'
              : 'Direct WebRTC data channels will activate here once paired with a room peer.'}
          </p>
        </div>
      </div>
    `;
  }

  const isOutgoing = active.direction === 'outgoing';
  const transferredStr = formatFileSize(active.transferredBytes || 0);
  const totalStr = formatFileSize(active.totalBytes || active.size || 0);
  const percent = active.progress || 0;
  const statusLabel = active.status ? active.status.toUpperCase() : 'TRANSFERRING';
  const safeActiveName = typeof active.name === 'string' ? active.name : 'unnamed_file';
  const isZip = safeActiveName.endsWith('.zip');

  return `
    <div id="active-transfer-panel" class="active-transfer-panel active">
      <div class="transfer-panel-header">
        <span class="panel-eyebrow">${isOutgoing ? 'STREAMING DIRECTLY TO PEER (SCTP)' : 'RECEIVING DIRECTLY FROM PEER'}</span>
        <span class="speed-indicator">${statusLabel} · ${percent}%</span>
      </div>

      <div class="transfer-item sample-active">
        <div class="transfer-info-row">
          <div class="file-badge">
            ${isZip ? icons.fileZip(18) : icons.file(18)}
          </div>
          <div class="file-meta">
            <span class="file-name" title="${escapeHtml(safeActiveName)}">${escapeHtml(safeActiveName)}</span>
            <span class="file-status-sub">
              ${isOutgoing ? 'Chunked upload' : 'Chunked download'} · ${transferredStr} of ${totalStr}
            </span>
          </div>
          <button type="button" class="btn btn-ghost btn-xs cancel-active-transfer-btn" data-id="${active.id}" title="Cancel this transfer">
            ${icons.x(14)}
            <span>Cancel</span>
          </button>
        </div>

        <div class="progress-bar-container" role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100">
          <div class="progress-bar-fill animated" style="width: ${percent}%"></div>
        </div>

        <div class="transfer-stats-row">
          <span>${transferredStr} / ${totalStr} (${active.totalChunks || 1} chunks)</span>
          <span class="p2p-direct-tag">${icons.shield(12)} Zero server relay</span>
        </div>
      </div>
    </div>
  `;
}

function renderFilesList(files) {
  if (!files || files.length === 0) {
    return `
      <li class="empty-files-item">
        <div class="empty-state-box">
          <div class="empty-state-icon">
            ${icons.upload(24)}
          </div>
          <p class="empty-state-title">No files transferred yet</p>
          <p class="empty-state-desc">Files transferred between you and your peer in this session will appear here. Zero bytes are saved on any server.</p>
        </div>
      </li>
    `;
  }

  return files.map((file) => {
    const isCompleted = file.status === 'completed';
    const isSending = file.status === 'sending';
    const isReceiving = file.status === 'receiving';
    const isFailed = file.status === 'failed';
    const isCancelled = file.status === 'cancelled';
    const isOutgoing = file.direction === 'outgoing';
    const directionLabel = isOutgoing ? 'Sent' : 'Received';
    const formattedSize = typeof file.size === 'number' ? formatFileSize(file.size) : file.size;
    const safeFileName = typeof file.name === 'string' ? file.name : 'unnamed_file';
    const isZip = safeFileName.endsWith('.zip');

    const directionBadge = isOutgoing
      ? `<span class="file-direction-badge sent">${icons.arrowUp(12)} Sent</span>`
      : `<span class="file-direction-badge received">${icons.arrowDown(12)} Received</span>`;

    let statusBadgeHtml = '';
    let actionBtnHtml = '';

    // Enforce blob: scheme strictly for download URLs
    const safeBlobUrl = (typeof file.blobUrl === 'string' && file.blobUrl.startsWith('blob:')) ? file.blobUrl : null;

    if (isCompleted) {
      if (!isOutgoing && safeBlobUrl) {
        statusBadgeHtml = `<span class="status-completed">${icons.check(12)} Received (100%)</span>`;
        actionBtnHtml = `
          <a href="${safeBlobUrl}" download="${escapeHtml(safeFileName)}" class="btn btn-primary btn-xs file-action-btn" title="Save file to computer">
            ${icons.download(14)}
            <span>Save</span>
          </a>
        `;
      } else {
        statusBadgeHtml = `<span class="status-completed">${icons.check(12)} Delivered (100%)</span>`;
        actionBtnHtml = `
          <span class="badge badge-success" title="Delivered directly to peer">
            ${icons.check(12)} Delivered
          </span>
        `;
      }
    } else if (isSending || isReceiving) {
      statusBadgeHtml = `<span class="status-transferring">${directionLabel} (${file.progress || 0}%)</span>`;
      actionBtnHtml = `
        <button type="button" class="btn btn-ghost btn-xs file-action-btn" data-action="cancel" data-id="${file.id}" title="Cancel transfer">
          ${icons.x(14)}
          <span>Cancel</span>
        </button>
      `;
    } else if (isFailed) {
      statusBadgeHtml = `<span class="status-failed">${icons.x(12)} Failed</span>`;
      actionBtnHtml = `
        <span class="badge badge-error" title="${escapeHtml(file.error || 'Transfer failed')}">
          Failed
        </span>
      `;
    } else if (isCancelled) {
      statusBadgeHtml = `<span class="status-cancelled">Cancelled</span>`;
      actionBtnHtml = `
        <span class="badge badge-warning">Cancelled</span>
      `;
    } else {
      statusBadgeHtml = `<span class="status-waiting">Waiting...</span>`;
      actionBtnHtml = `<span class="badge badge-subtle">Queued</span>`;
    }

    return `
      <li class="file-item ${isOutgoing ? 'sent' : 'received'}" data-id="${file.id}">
        <div class="file-item-icon">
          ${isZip ? icons.fileZip(20) : icons.file(20)}
        </div>
        <div class="file-item-info">
          <div class="file-item-name" title="${escapeHtml(safeFileName)}">${escapeHtml(safeFileName)}</div>
          <div class="file-item-meta">
            ${directionBadge}
            <span class="dot-separator">·</span>
            <span>${formattedSize}</span>
            <span class="dot-separator">·</span>
            ${statusBadgeHtml}
            <span class="p2p-direct-tag">[P2P]</span>
          </div>
        </div>
        <div class="file-item-action">
          ${actionBtnHtml}
        </div>
      </li>
    `;
  }).join('');
}

/** Render chat messages safely avoiding XSS through escapeHtml */
function renderChatMessages() {
  const isDataChannelOpen = state.dataChannelState === DATA_CHANNEL_STATES.OPEN;

  // Real ephemeral session chat
  if (state.realChatMessages.length === 0) {
    return `
      <div class="empty-chat-item">
        <div class="empty-state-box">
          <div class="empty-state-icon">
            ${icons.chat(24)}
          </div>
          <p class="empty-state-title">Ephemeral P2P Chat</p>
          <p class="empty-state-desc">
            ${isDataChannelOpen
              ? 'WebRTC DataChannel is active! Start chatting directly with your peer. Messages are never saved on any server.'
              : 'Connect to a peer above to activate live encrypted peer-to-peer chat.'}
          </p>
        </div>
      </div>
    `;
  }

  return state.realChatMessages.map((msg) => {
    if (msg.sender === 'system') {
      return `
        <div class="chat-system-message">
          <span class="system-icon">${icons.info(12)}</span>
          <span class="system-text">${escapeHtml(msg.text)}</span>
          <span class="message-time">${escapeHtml(msg.timestamp || '')}</span>
        </div>
      `;
    }

    const isYou = msg.sender === 'user';
    const bubbleClass = isYou ? 'msg-you' : 'msg-peer';

    return `
      <div class="chat-message-row ${bubbleClass}">
        <div class="chat-bubble ${bubbleClass}">
          <div class="chat-bubble-header">
            <span class="chat-sender-name">${escapeHtml(msg.senderName || (isYou ? 'You' : 'Peer'))}</span>
            <span class="message-time">${escapeHtml(msg.timestamp || '')}</span>
          </div>
          <p class="chat-text">${escapeHtml(msg.text)}</p>
          <span class="chat-demo-badge p2p-tag">P2P Direct</span>
        </div>
      </div>
    `;
  }).join('');
}



// ==========================================
// REAL-TIME SIGNALING & WEBRTC WIRING
// ==========================================

function bindSignalingEvents(root) {
  const updateSessionUI = () => {
    const container = root.querySelector('#live-session-container');
    if (container) {
      container.innerHTML = renderLiveSessionPanel();
      bindLivePanelEvents(root);
    }

    const displayCode = root.querySelector('#display-room-code');
    if (displayCode) {
      displayCode.textContent = state.realRoomCode || 'PORT-????';
    }

    const copyBtn = root.querySelector('#copy-code-btn');
    if (copyBtn) {
      copyBtn.disabled = !state.realRoomCode;
    }

    const workspaceCode = root.querySelector('#workspace-room-code');
    if (workspaceCode) {
      workspaceCode.textContent = state.realRoomCode || 'Not Connected';
    }

    // Toggle button loading states
    const createBtn = root.querySelector('#create-room-btn');
    const createBtnText = root.querySelector('#create-room-btn-text');
    if (createBtn && createBtnText) {
      if (state.signalingState === SIGNALING_STATES.CREATING) {
        createBtn.classList.add('loading');
        createBtnText.textContent = 'Connecting to signaling...';
      } else {
        createBtn.classList.remove('loading');
        createBtnText.textContent = 'Create Room (Host Session)';
      }
    }

    const joinBtn = root.querySelector('#join-room-btn');
    const joinBtnText = root.querySelector('#join-room-btn-text');
    if (joinBtn && joinBtnText) {
      if (state.signalingState === SIGNALING_STATES.JOINING) {
        joinBtn.classList.add('loading');
        joinBtnText.textContent = 'Connecting to room...';
      } else {
        joinBtn.classList.remove('loading');
        joinBtnText.textContent = 'Join Room';
      }
    }
  };

  signalingClient.on('stateChange', (newState, detail) => {
    state.signalingState = newState;
    state.realRoomCode = detail.roomCode || state.realRoomCode;
    state.realSessionId = detail.sessionId || state.realSessionId;
    state.realRole = detail.role || state.realRole;
    state.peerSessionId = detail.peerSessionId;

    if (newState === SIGNALING_STATES.ERROR) {
      state.signalingError = detail.message || 'Signaling error occurred.';
    } else {
      state.signalingError = null;
    }

    updateSessionUI();
  });

  signalingClient.on('roomCreated', (payload) => {
    state.realRoomCode = payload.room_code;
    state.realSessionId = payload.session_id;
    state.realRole = payload.role;
    showToast(`Real room "${payload.room_code}" created on server!`, 'success');
  });

  signalingClient.on('waiting', () => {
    showToast(`Waiting for peer to join room ${state.realRoomCode || ''}`, 'info', 3000);
  });

  signalingClient.on('peerJoined', async (payload) => {
    state.realRoomCode = payload.room_code;
    state.peerSessionId = payload.peer_session_id;
    showToast(`Peer connected to signaling room ${payload.room_code}. Initializing WebRTC...`, 'info', 3000);

    // Both peers present: initiate WebRTC peer connection
    try {
      await peerConnectionService.startPeerConnection(state.realRole);
    } catch (err) {
      console.error('WebRTC start error:', err);
      showToast('Failed to start WebRTC peer connection.', 'warning');
    }
  });

  signalingClient.on('peerLeft', () => {
    state.peerSessionId = null;
    peerConnectionService.close();

    state.realFiles = [];
    state.activeTransfer = null;
    state.fileChannelState = DATA_CHANNEL_STATES.IDLE;

    state.realChatMessages.push({
      id: `sys-${Date.now()}`,
      sender: 'system',
      text: 'Peer left the session. WebRTC DataChannels closed. Waiting for a new peer...',
      timestamp: formatTime(new Date()),
      isReal: true,
    });

    updateChatUI(root);
    updateFilesUI(root);
    showToast('Peer left the room.', 'warning', 4000);
  });

  signalingClient.on('error', (payload) => {
    const feedbackEl = root.querySelector('#join-code-feedback');
    if (feedbackEl) {
      setFeedback(feedbackEl, payload.message || 'Failed to connect to room.', 'error');
    }
    showToast(`Error: ${payload.message || 'Operation failed.'}`, 'warning', 4000);
  });
}

function bindWebRTCEvents(root) {
  peerConnectionService.on('connectionStateChange', (newState) => {
    state.peerConnectionState = newState;
    state.connectionDiagnostics.connectionState = newState;

    if (newState === 'connected') {
      state.isReconnecting = false;
      state.reconnectAttempt = 0;
      peerConnectionService.emitDiagnosticsUpdate();
      showToast('WebRTC peer connection established directly!', 'success', 3000);
    } else if (newState === 'failed') {
      state.isReconnecting = false;
      showToast('WebRTC connection failed. A TURN relay server may be required on restricted networks.', 'warning', 5000);
    }
    updateSessionUI(root);
    updateChatUI(root);
    updateFilesUI(root);
  });

  peerConnectionService.on('iceConnectionStateChange', (iceState) => {
    state.connectionDiagnostics.iceConnectionState = iceState;
    if (iceState === 'connected' || iceState === 'completed') {
      state.isReconnecting = false;
      state.reconnectAttempt = 0;
      peerConnectionService.emitDiagnosticsUpdate();
    }
    updateSessionUI(root);
  });

  peerConnectionService.on('iceGatheringStateChange', (gatheringState) => {
    state.connectionDiagnostics.iceGatheringState = gatheringState;
    updateSessionUI(root);
  });

  peerConnectionService.on('reconnecting', (info) => {
    state.isReconnecting = true;
    state.reconnectAttempt = info.attempt;
    state.connectionDiagnostics.reconnectAttempts = info.attempt;
    updateSessionUI(root);
    updateChatUI(root);
    updateFilesUI(root);
    showToast(`Reconnecting WebRTC link (attempt ${info.attempt}/${info.maxAttempts})... In-flight transfers paused.`, 'warning', 3500);
  });

  peerConnectionService.on('terminalFailure', (info) => {
    state.isReconnecting = false;
    state.peerConnectionState = PEER_CONNECTION_STATES.FAILED;
    state.dataChannelState = DATA_CHANNEL_STATES.CLOSED;
    state.fileChannelState = DATA_CHANNEL_STATES.CLOSED;
    updateSessionUI(root);
    updateChatUI(root);
    updateFilesUI(root);
    showToast('WebRTC connection failed: Reconnection attempts exhausted. Check firewall or configure TURN relay.', 'error', 6000);
  });

  peerConnectionService.on('diagnosticsUpdate', (diag) => {
    state.connectionDiagnostics = { ...state.connectionDiagnostics, ...diag };
    updateSessionUI(root);
  });

  peerConnectionService.on('dataChannelStateChange', (newState) => {
    state.dataChannelState = newState;
    updateChatUI(root);
    updateSessionUI(root);

    if (newState === 'open') {
      state.realChatMessages.push({
        id: `sys-open-${Date.now()}`,
        sender: 'system',
        text: 'Direct WebRTC DataChannel open! Messages stream peer-to-peer.',
        timestamp: formatTime(new Date()),
        isReal: true,
      });
      updateChatUI(root);
      showToast('WebRTC DataChannel is open! Real-time chat is ready.', 'success', 4000);
    }
  });

  peerConnectionService.on('fileChannelStateChange', (newState) => {
    state.fileChannelState = newState;
    updateFilesUI(root);
    updateSessionUI(root);
  });

  peerConnectionService.on('fileChannelOpen', () => {
    state.fileChannelState = DATA_CHANNEL_STATES.OPEN;
    updateFilesUI(root);
    updateSessionUI(root);
    showToast('WebRTC file streaming data channel ready!', 'success', 3000);
  });

  peerConnectionService.on('fileChannelClose', () => {
    state.fileChannelState = DATA_CHANNEL_STATES.CLOSED;
    updateFilesUI(root);
    updateSessionUI(root);
  });

  peerConnectionService.on('chatMessage', (msg) => {
    state.realChatMessages.push(msg);
    updateChatUI(root);
    showToast(`New message from peer: "${msg.text.slice(0, 30)}..."`, 'info', 2500);
  });

  // File Transfer Events (Phase 5)
  peerConnectionService.on('fileTransferStart', (transfer) => {
    const existingIndex = state.realFiles.findIndex((f) => f.id === transfer.id);
    if (existingIndex >= 0) {
      state.realFiles[existingIndex] = transfer;
    } else {
      state.realFiles.unshift(transfer);
    }
    if (transfer.status === 'sending' || transfer.status === 'receiving') {
      state.activeTransfer = transfer;
    }
    updateFilesUI(root);
    if (transfer.direction === 'incoming') {
      showToast(`Receiving "${transfer.name}" (${formatFileSize(transfer.size)}) from peer...`, 'info', 3000);
    }
  });

  peerConnectionService.on('fileTransferProgress', (transfer) => {
    const existingIndex = state.realFiles.findIndex((f) => f.id === transfer.id);
    if (existingIndex >= 0) {
      state.realFiles[existingIndex] = transfer;
    }
    if (state.activeTransfer && state.activeTransfer.id === transfer.id) {
      state.activeTransfer = transfer;
    } else if (transfer.status === 'sending' || transfer.status === 'receiving') {
      state.activeTransfer = transfer;
    }
    updateFilesUI(root);
  });

  peerConnectionService.on('fileTransferComplete', (transfer) => {
    const existingIndex = state.realFiles.findIndex((f) => f.id === transfer.id);
    if (existingIndex >= 0) {
      state.realFiles[existingIndex] = transfer;
    }
    if (state.activeTransfer && state.activeTransfer.id === transfer.id) {
      state.activeTransfer = null;
    }
    updateFilesUI(root);
    if (transfer.direction === 'incoming') {
      showToast(`Received "${transfer.name}"! Click Save to download.`, 'success', 5000);
    } else {
      showToast(`Sent "${transfer.name}" successfully to peer!`, 'success', 4000);
    }
  });

  peerConnectionService.on('fileTransferFailed', (transfer) => {
    const existingIndex = state.realFiles.findIndex((f) => f.id === transfer.id);
    if (existingIndex >= 0) {
      state.realFiles[existingIndex] = transfer;
    }
    if (state.activeTransfer && state.activeTransfer.id === transfer.id) {
      state.activeTransfer = null;
    }
    updateFilesUI(root);
    showToast(`Transfer failed for "${transfer.name}": ${transfer.error || 'Connection error'}`, 'warning', 4500);
  });

  peerConnectionService.on('fileTransferCancelled', (transfer) => {
    const existingIndex = state.realFiles.findIndex((f) => f.id === transfer.id);
    if (existingIndex >= 0) {
      state.realFiles[existingIndex] = transfer;
    }
    if (state.activeTransfer && state.activeTransfer.id === transfer.id) {
      state.activeTransfer = null;
    }
    updateFilesUI(root);
    showToast(`Transfer cancelled for "${transfer.name}"`, 'warning', 3000);
  });

  peerConnectionService.on('error', (err) => {
    console.warn('WebRTC error event:', err);
    if (err.message) {
      showToast(`WebRTC notice: ${err.message}`, 'warning', 4000);
    }
  });
}

function updateSessionUI(root) {
  const container = root.querySelector('#live-session-container');
  if (container) {
    container.innerHTML = renderLiveSessionPanel();
    bindLivePanelEvents(root);
  }

  // Synchronize workspace topbar peer status pill & latency badge
  const statusPill = root.querySelector('.workspace-topbar .peer-status-pill');
  if (statusPill) {
    const isDataChannelOpen = state.dataChannelState === DATA_CHANNEL_STATES.OPEN;
    const isFileChannelOpen = state.fileChannelState === DATA_CHANNEL_STATES.OPEN || peerConnectionService.isFileChannelReady();
    const isSessionActive = state.signalingState !== SIGNALING_STATES.IDLE;
    const isReconnecting = state.isReconnecting;
    const isPeerFailed = state.peerConnectionState === PEER_CONNECTION_STATES.FAILED;
    const isRelayActive = state.connectionDiagnostics.isRelay;

    let statusDotClass = 'waiting';
    let statusPillHtml = `Status: <strong>Idle</strong> (Pair above to connect)`;
    let metaBadgeText = 'P2P Ready';

    if (isReconnecting) {
      statusDotClass = 'reconnecting';
      statusPillHtml = `Reconnecting: <strong>Attempt ${state.reconnectAttempt || 1}/3</strong> (Recovering link...)`;
      metaBadgeText = 'Reconnecting WebRTC...';
    } else if (isPeerFailed) {
      statusDotClass = 'error';
      statusPillHtml = `Connection: <strong>Failed</strong> (Retries exhausted)`;
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
      statusPillHtml = `Signaling: <strong>${state.signalingState.toUpperCase()}</strong>`;
      metaBadgeText = 'Negotiating WebRTC...';
    }

    statusPill.innerHTML = `
      <span class="status-indicator-dot ${statusDotClass}"></span>
      <span class="peer-label">${statusPillHtml}</span>
    `;

    const latencyBadgeText = root.querySelector('.workspace-topbar .latency-badge span');
    if (latencyBadgeText) {
      latencyBadgeText.textContent = metaBadgeText;
    }
  }
}

function updateFilesUI(root) {
  const isFileChannelOpen = state.fileChannelState === DATA_CHANNEL_STATES.OPEN || peerConnectionService.isFileChannelReady();

  // Update file channel badge
  const badge = root.querySelector('#file-channel-badge');
  if (badge) {
    badge.className = `badge ${isFileChannelOpen ? 'badge-success' : 'badge-subtle'}`;
    badge.textContent = isFileChannelOpen ? 'P2P FileChannel Open' : 'Waiting for Peer';
  }

  // Update dropzone styling and accessibility
  const dropZone = root.querySelector('#file-drop-zone');
  const fileBrowseInput = root.querySelector('#file-browse-input');
  const browseBtn = root.querySelector('#browse-files-btn');
  if (dropZone) {
    dropZone.classList.toggle('drop-zone-disabled', !isFileChannelOpen);
    const titleEl = dropZone.querySelector('.drop-zone-title');
    if (titleEl) {
      titleEl.textContent = isFileChannelOpen ? 'Drop files here to share directly' : 'Connect to a peer to enable file transfers';
    }
  }
  if (fileBrowseInput) {
    fileBrowseInput.disabled = !isFileChannelOpen;
  }
  if (browseBtn) {
    browseBtn.disabled = !isFileChannelOpen;
  }

  // Update active transfer panel
  const activeContainer = root.querySelector('#active-transfer-container');
  if (activeContainer) {
    activeContainer.innerHTML = renderActiveTransferPanel();
  }

  // Update files list
  const filesListEl = root.querySelector('#files-list');
  if (filesListEl) {
    filesListEl.innerHTML = renderFilesList(state.realFiles);
  }

  // Update count badge
  const countBadge = root.querySelector('#files-count-badge');
  if (countBadge) {
    countBadge.textContent = `${state.realFiles.length} items`;
  }
}

function updateChatUI(root) {
  const isDataChannelOpen = state.dataChannelState === DATA_CHANNEL_STATES.OPEN;

  // Update chat badge
  const badge = root.querySelector('#chat-channel-badge');
  if (badge) {
    badge.className = `badge ${isDataChannelOpen ? 'badge-success' : 'badge-subtle'}`;
    badge.textContent = isDataChannelOpen ? 'P2P DataChannel Open' : 'Waiting for P2P';
  }

  // Update chat notice
  const noticeText = root.querySelector('#chat-notice-text');
  if (noticeText) {
    noticeText.textContent = isDataChannelOpen
      ? 'Direct WebRTC DataChannel active. Messages stream directly browser-to-browser with zero server logging.'
      : 'Messages will stream directly over WebRTC DataChannel. Connect with a peer above to activate live chat.';
  }

  // Update input and button state
  const chatInput = root.querySelector('#chat-input');
  const chatSendBtn = root.querySelector('#chat-send-btn');
  if (chatInput && chatSendBtn) {
    const isChatAllowed =
      isDataChannelOpen &&
      !state.isReconnecting &&
      state.peerConnectionState === PEER_CONNECTION_STATES.CONNECTED;

    chatInput.disabled = !isChatAllowed;
    chatSendBtn.disabled = !isChatAllowed;

    if (state.isReconnecting) {
      chatInput.placeholder = `Reconnecting to peer (Attempt ${state.reconnectAttempt || 1}/3)... In-flight chat paused.`;
    } else if (state.peerConnectionState === PEER_CONNECTION_STATES.FAILED) {
      chatInput.placeholder = 'Connection failed. Re-pair above or check TURN configuration.';
    } else if (isDataChannelOpen) {
      chatInput.placeholder = 'Type a real-time message to peer (P2P)...';
    } else {
      chatInput.placeholder = 'Connect to a peer above to enable live P2P chat...';
    }
  }

  // Update messages container
  const messagesContainer = root.querySelector('#chat-messages-container');
  if (messagesContainer) {
    messagesContainer.innerHTML = renderChatMessages();
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

function bindLivePanelEvents(root) {
  // Bind diagnostics drawer toggle to remember open/closed state across updates
  const drawer = root.querySelector('#webrtc-diagnostics-drawer');
  if (drawer) {
    drawer.addEventListener('toggle', () => {
      state.isDiagnosticsOpen = drawer.open;
    });
  }

  const leaveBtn = root.querySelector('#leave-room-btn');
  if (leaveBtn) {
    leaveBtn.addEventListener('click', () => {
      showConfirmDialog({
        title: 'Leave Current Room?',
        message: `Disconnect from room "${state.realRoomCode || ''}"? WebRTC data channels will close and your direct peer connection will end.`,
        confirmText: 'Leave Room',
        cancelText: 'Stay in Room',
        isDestructive: true,
        onConfirm: () => {
          // Revoke Blob URLs
          state.realFiles.forEach((f) => {
            if (f.blobUrl) {
              try { URL.revokeObjectURL(f.blobUrl); } catch {}
              f.blobUrl = null;
            }
          });

          peerConnectionService.close();
          signalingClient.leaveRoom();

          resetSessionState(state);

          updateSessionUI(root);
          updateChatUI(root);
          updateFilesUI(root);
          showToast('Left room session. Returned to pairing view.', 'info', 3000);
        },
      });
    });
  }

  const copyLiveBtn = root.querySelector('#copy-live-code-btn');
  if (copyLiveBtn && state.realRoomCode) {
    copyLiveBtn.addEventListener('click', async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(state.realRoomCode);
        }
        showToast(`Copied room code "${state.realRoomCode}"!`, 'success', 3000);
        const textSpan = copyLiveBtn.querySelector('.copy-live-text');
        if (textSpan) {
          const orig = textSpan.textContent;
          textSpan.textContent = 'Copied! ✓';
          copyLiveBtn.classList.add('copied');
          setTimeout(() => {
            textSpan.textContent = orig;
            copyLiveBtn.classList.remove('copied');
          }, 2000);
        }
      } catch {
        showToast(`Room code: ${state.realRoomCode}`, 'info', 3000);
      }
    });
  }
}

// ==========================================
// DOM EVENT HANDLING & ACCESSIBILITY
// ==========================================

function bindEvents(root) {
  // 1. Real Room Creation Button (Phase 3 & 4)
  const createRoomBtn = root.querySelector('#create-room-btn');
  if (createRoomBtn) {
    createRoomBtn.addEventListener('click', () => {
      signalingClient.createRoom();
    });
  }

  // 4. Copy Code button on Create card
  const copyBtn = root.querySelector('#copy-code-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const codeToCopy = state.realRoomCode;
      if (!codeToCopy) return;

      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(codeToCopy);
        }
        showToast(`Copied room code "${codeToCopy}" to clipboard!`, 'success', 3000);
        const textSpan = copyBtn.querySelector('.copy-btn-text');
        if (textSpan) {
          const original = textSpan.textContent;
          textSpan.textContent = 'Copied! ✓';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            textSpan.textContent = original;
            copyBtn.classList.remove('copied');
          }, 2000);
        }
      } catch {
        showToast(`Room code: ${codeToCopy}`, 'info', 3000);
      }
    });
  }

  // 5. Join Room: Use sample code quick helper
  const pasteSampleBtn = root.querySelector('#paste-sample-code-btn');
  const roomCodeInput = root.querySelector('#room-code-input');
  const feedbackEl = root.querySelector('#join-code-feedback');
  if (pasteSampleBtn && roomCodeInput) {
    pasteSampleBtn.addEventListener('click', () => {
      roomCodeInput.value = state.realRoomCode || APP_CONFIG.demoData.roomCode;
      roomCodeInput.focus();
      validateJoinInput(roomCodeInput, feedbackEl);
    });
  }

  // 6. Join Room Form submission
  const joinForm = root.querySelector('#join-room-form');
  if (joinForm && roomCodeInput && feedbackEl) {
    roomCodeInput.addEventListener('input', () => {
      roomCodeInput.value = roomCodeInput.value.toUpperCase();
      validateJoinInput(roomCodeInput, feedbackEl);
    });

    joinForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = roomCodeInput.value.trim();
      const result = validateRoomCode(code);

      if (!result.isValid) {
        setFeedback(feedbackEl, result.message, 'error');
        roomCodeInput.focus();
        return;
      }

      setFeedback(feedbackEl, `Attempting to join room "${result.code}"...`, 'warning');
      signalingClient.joinRoom(result.code);
    });
  }

  // 7. Ephemeral Chat Form interaction (Phase 4: Real WebRTC Chat)
  const chatForm = root.querySelector('#chat-form');
  const chatInput = root.querySelector('#chat-input');
  const charCounter = root.querySelector('#char-counter');
  const messagesContainer = root.querySelector('#chat-messages-container');

  if (chatInput && charCounter) {
    chatInput.addEventListener('input', () => {
      const remaining = 1000 - chatInput.value.length;
      charCounter.textContent = String(remaining);
    });

    // Enter key submits chat; Shift+Enter allows newline if multiline
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        chatForm.requestSubmit();
      }
    });
  }

  if (chatForm && chatInput) {
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = chatInput.value;
      if (!text || !text.trim()) return;

      if (!peerConnectionService.isChatReady()) {
        showToast('WebRTC DataChannel is not open. Connect with a peer first.', 'warning', 3500);
        return;
      }

      try {
        const localMessage = peerConnectionService.sendChatMessage(text);
        state.realChatMessages.push(localMessage);

        chatInput.value = '';
        if (charCounter) charCounter.textContent = '1000';

        if (messagesContainer) {
          messagesContainer.innerHTML = renderChatMessages();
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        // Update clear button disabled state
        const clearChatButtons = root.querySelectorAll('#clear-chat-btn, #chat-col-clear-btn');
        clearChatButtons.forEach((btn) => { btn.disabled = false; });
      } catch (err) {
        showToast(`Failed to send message: ${err.message}`, 'warning', 4000);
      }
    });
  }

  // Clear chat buttons with confirmation dialog
  const clearChatButtons = root.querySelectorAll('#clear-chat-btn, #chat-col-clear-btn');
  clearChatButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.realChatMessages.length === 0) return;

      showConfirmDialog({
        title: 'Clear Chat Messages?',
        message: 'Clear chat messages from your screen for this session? Your room connection and active file transfers will not be affected.',
        confirmText: 'Clear Chat',
        cancelText: 'Cancel',
        isDestructive: true,
        onConfirm: () => {
          state.realChatMessages = [];
          updateChatUI(root);
          showToast('Chat history cleared from session memory.', 'info', 3000);
        },
      });
    });
  });

  // Clear file transfer history button with confirmation dialog
  const clearFilesBtn = root.querySelector('#clear-files-btn');
  if (clearFilesBtn) {
    clearFilesBtn.addEventListener('click', () => {
      if (state.realFiles.length === 0) return;

      showConfirmDialog({
        title: 'Clear Transfer History?',
        message: 'Remove finished and cancelled transfer records from this session? Any downloaded files on your computer will remain safe, and in-memory download links will be released.',
        confirmText: 'Clear Records',
        cancelText: 'Cancel',
        isDestructive: true,
        onConfirm: () => {
          const { filesToKeep, filesToClear } = filterClearableFiles(state.realFiles, state.activeTransfer?.id);

          filesToClear.forEach((f) => {
            if (f.blobUrl) {
              try { URL.revokeObjectURL(f.blobUrl); } catch {}
              f.blobUrl = null;
            }
          });

          state.realFiles = filesToKeep;
          updateFilesUI(root);
          showToast('Transfer history cleared.', 'info', 3000);
        },
      });
    });
  }

  // 8. Real WebRTC File Streaming interactions (Phase 5)
  const dropZone = root.querySelector('#file-drop-zone');
  const fileBrowseInput = root.querySelector('#file-browse-input');
  const browseBtn = root.querySelector('#browse-files-btn');
  const filesListEl = root.querySelector('#files-list');

  const handleSelectedFiles = async (fileList) => {
    if (!fileList || fileList.length === 0) return;

    if (!peerConnectionService.isFileChannelReady()) {
      showToast('Pair with a peer above to activate direct file streaming.', 'warning', 4000);
      return;
    }

    const files = Array.from(fileList);
    for (const file of files) {
      if (file.size > APP_CONFIG.fileTransfer.maxFileSizeBytes) {
        const maxMb = Math.round(APP_CONFIG.fileTransfer.maxFileSizeBytes / (1024 * 1024));
        showToast(`File "${file.name}" exceeds maximum allowed limit of ${maxMb} MB.`, 'warning', 5000);
        continue;
      }

      try {
        await peerConnectionService.sendFile(file);
      } catch (err) {
        showToast(`Failed to send "${file.name}": ${err.message}`, 'error', 4500);
      }
    }
  };

  if (browseBtn && fileBrowseInput) {
    browseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!peerConnectionService.isFileChannelReady()) {
        showToast('Pair with a peer above to activate direct file streaming.', 'warning', 3500);
        return;
      }
      fileBrowseInput.click();
    });
  }

  if (fileBrowseInput) {
    fileBrowseInput.addEventListener('change', () => {
      if (fileBrowseInput.files && fileBrowseInput.files.length > 0) {
        handleSelectedFiles(fileBrowseInput.files);
        fileBrowseInput.value = '';
      }
    });
  }

  if (filesListEl) {
    filesListEl.addEventListener('click', (e) => {
      const cancelBtn = e.target.closest('[data-action="cancel"]');
      if (cancelBtn) {
        const transferId = cancelBtn.getAttribute('data-id');
        if (transferId) {
          peerConnectionService.cancelTransfer(transferId, 'Cancelled by user');
        }
      }
    });
  }

  const activeTransferContainer = root.querySelector('#active-transfer-container');
  if (activeTransferContainer) {
    activeTransferContainer.addEventListener('click', (e) => {
      const cancelBtn = e.target.closest('.cancel-active-transfer-btn');
      if (cancelBtn) {
        const transferId = cancelBtn.getAttribute('data-id');
        if (transferId) {
          peerConnectionService.cancelTransfer(transferId, 'Cancelled by user');
        }
      }
    });
  }

  if (dropZone) {
    dropZone.addEventListener('click', () => {
      if (!peerConnectionService.isFileChannelReady()) {
        showToast('Pair with a peer above to activate direct file streaming.', 'warning', 3500);
        return;
      }
      if (fileBrowseInput) fileBrowseInput.click();
    });

    ['dragenter', 'dragover'].forEach((eventName) => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (peerConnectionService.isFileChannelReady()) {
          dropZone.classList.add('drag-active');
        }
      });
    });

    ['dragleave', 'dragend'].forEach((eventName) => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-active');
      });
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drag-active');

      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleSelectedFiles(e.dataTransfer.files);
      }
    });

    dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (fileBrowseInput && peerConnectionService.isFileChannelReady()) {
          fileBrowseInput.click();
        }
      }
    });
  }
}

// ==========================================
// UTILITY HELPERS
// ==========================================

function validateJoinInput(inputEl, feedbackEl) {
  const val = inputEl.value.trim();
  if (!val) {
    setFeedback(feedbackEl, '', 'clear');
    return;
  }
  const result = validateRoomCode(val);
  if (!result.isValid) {
    setFeedback(feedbackEl, result.message, 'warning');
  } else {
    setFeedback(feedbackEl, 'Format looks valid. Click Join to connect.', 'success');
  }
}

function setFeedback(el, message, type) {
  if (!el) return;
  el.textContent = message;
  el.className = `form-feedback feedback-${type}`;
}
