/**
 * PairPort Main Application Component
 * Phase 4 & 5 — WebRTC Peer-to-Peer Connection, Real-Time Ephemeral Chat & Chunked File Transfer
 *
 * Coordinates feature initialization and master page composition:
 * - Layout (Navbar, Hero, Features, How It Works, Footer)
 * - Room Pairing (Creation, Joining, Code validation)
 * - Connection & Diagnostics (Signaling, WebRTC lifecycle, ICE resilience)
 * - Ephemeral Chat (Real-time P2P DataChannel messaging)
 * - P2P File Transfer (Chunked streaming, drag-and-drop, backpressure)
 */

import { icons } from './components/icons.js';
import { initModal } from './components/modal.js';
import { escapeHtml } from './utils/ui-helpers.js';
import { state } from './state/app-state.js';

import {
  renderNavbar,
  initNavbar,
  renderHero,
  renderFeatures,
  renderHowItWorks,
  renderFooter,
} from './features/layout/index.js';
import {
  renderPairingSection,
  initPairing,
} from './features/pairing/index.js';
import {
  renderLiveSessionPanel,
  computeSessionStatusInfo,
  initConnectionController,
} from './features/connection/index.js';
import {
  renderChatColumn,
  updateChatUI,
  initChat,
} from './features/chat/index.js';
import {
  renderFileHubColumn,
  updateFilesUI,
  initFiles,
} from './features/files/index.js';

/** Render the complete PairPort UI and wire up interactions */
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
        ${renderPairingSection({ liveSessionHtml: renderLiveSessionPanel() })}
        ${renderWorkspaceSection()}
      </main>
      ${renderFooter()}
    </div>
  `;

  // Initialize navbar interactions (mobile menu toggle & roadmap trigger)
  initNavbar(root);

  // Initialize pairing interactions (create room, join room, validation, copy code)
  initPairing(root);

  // Initialize connection controller (signaling & WebRTC connection lifecycle)
  initConnectionController(root, {
    onChatUIUpdate: () => updateChatUI(root),
    onFilesUIUpdate: () => updateFilesUI(root),
  });

  // Initialize ephemeral chat interactions and WebRTC message listeners
  initChat(root);

  // Initialize file transfer interactions and WebRTC file streaming listeners
  initFiles(root);

  // Initialize roadmap modal
  initModal();
}

// ==========================================
// RENDER HELPERS
// ==========================================

function renderWorkspaceSection() {
  const {
    statusDotClass,
    statusPillHtml,
    metaBadgeText,
    isDataChannelOpen,
    isFileChannelOpen,
    isReconnecting,
    isRelayActive,
  } = computeSessionStatusInfo(state);

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
            ${renderFileHubColumn(state)}

            <!-- Right Column: Real-time WebRTC Ephemeral Chat -->
            ${renderChatColumn(state)}
          </div>
        </div>
      </div>
    </section>
  `;
}
