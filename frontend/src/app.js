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
import { router, hasActiveSession } from './services/router.js';

import {
  renderNavbar,
  initNavbar,
  updateNavbarActive,
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

  // Render complete HTML markup organized into 3 persistent screen containers
  root.innerHTML = `
    <div class="site-wrapper">
      ${renderNavbar()}
      <main id="main-content">
        <!-- Screen 1: Home -->
        <div id="screen-home" class="screen-view" role="region" aria-label="Home Screen">
          ${renderHero()}
          ${renderFeatures()}
          ${renderHowItWorks()}
          ${renderFooter()}
        </div>

        <!-- Screen 2: Pairing -->
        <div id="screen-pairing" class="screen-view hidden" role="region" aria-label="Room Pairing Screen">
          ${renderPairingSection({ liveSessionHtml: renderLiveSessionPanel() })}
        </div>

        <!-- Screen 3: Workspace -->
        <div id="screen-workspace" class="screen-view hidden" role="region" aria-label="P2P Workspace Screen">
          ${renderWorkspaceSection()}
        </div>
      </main>
    </div>
  `;

  // Initialize navbar interactions (mobile menu toggle & roadmap trigger)
  initNavbar(root);

  // Initialize pairing interactions (create room, join room, validation, copy code)
  // NOTE: This runs parseAndClearLocationInvitation()!
  const pairingResult = initPairing(root);

  // Helper function to switch screen container visibility without destroying DOM
  function syncScreen(routeInfo) {
    const screen = routeInfo?.screen || 'home';
    const anchor = routeInfo?.anchor || null;

    const screens = {
      home: root.querySelector('#screen-home'),
      pairing: root.querySelector('#screen-pairing'),
      workspace: root.querySelector('#screen-workspace'),
    };

    Object.entries(screens).forEach(([name, el]) => {
      if (!el) return;
      const isActive = name === screen;
      el.classList.toggle('screen-active', isActive);
      el.classList.toggle('hidden', !isActive);
      el.setAttribute('aria-hidden', String(!isActive));
    });

    updateNavbarActive(root, screen, hasActiveSession(state));

    if (screen === 'home' && anchor) {
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => {
          const targetEl = root.querySelector(`#${anchor}`);
          if (targetEl && typeof targetEl.scrollIntoView === 'function') {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        });
      }
    } else if (typeof window !== 'undefined' && screen !== 'home' && typeof window.scrollTo === 'function') {
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  }

  // Subscribe router changes to sync screen visibility
  router.subscribe((newRoute) => {
    syncScreen(newRoute);
  });

  // Track session pairing state for smooth workspace transition
  let wasPaired = false;

  // Initialize connection controller (signaling & WebRTC connection lifecycle)
  initConnectionController(root, {
    onSessionUIUpdate: () => {
      const current = router.getCurrentScreen();
      const hasSession = hasActiveSession(state);
      updateNavbarActive(root, current, hasSession);

      // Transition to workspace automatically when both data channels open
      const isPaired = state.dataChannelState === 'open' && state.fileChannelState === 'open';
      if (isPaired && !wasPaired) {
        wasPaired = true;
        if (current === 'pairing') {
          router.navigate('workspace');
        }
      } else if (!isPaired) {
        wasPaired = false;
      }

      // If user is on workspace and session is lost/left, guard routes back to pairing
      if (current === 'workspace' && !hasSession) {
        router.navigate('pairing');
      }
    },
    onChatUIUpdate: () => updateChatUI(root),
    onFilesUIUpdate: () => updateFilesUI(root),
  });

  // Initialize ephemeral chat interactions and WebRTC message listeners
  initChat(root);

  // Initialize file transfer interactions and WebRTC file streaming listeners
  initFiles(root);

  // Initialize roadmap modal
  initModal();

  // Wire up workspace leave button to trigger leave room confirmation
  const workspaceLeaveBtn = root.querySelector('#workspace-leave-btn');
  if (workspaceLeaveBtn) {
    workspaceLeaveBtn.addEventListener('click', () => {
      const leaveBtn = root.querySelector('#leave-room-btn');
      if (leaveBtn) {
        leaveBtn.click();
      }
    });
  }

  // If an invitation token or invitation fragment attempt was detected, route to pairing screen
  const hadInvitationAttempt = Boolean(state.invitationToken || pairingResult?.locationInvite);
  if (hadInvitationAttempt && router.getCurrentScreen() !== 'pairing') {
    router.navigate('pairing', { replace: true });
  }

  // Start the router and synchronize the initial screen
  const initialRoute = router.start();
  syncScreen(initialRoute);
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
              <button type="button" id="workspace-leave-btn" class="btn btn-outline-danger btn-xs" title="Leave room session">
                ${icons.x(14)}
                <span>Leave</span>
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
