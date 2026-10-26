/**
 * PairPort Pairing UI Component
 * Layout & markup for the pairing section (onboarding guide, live session slot, host & join cards).
 */

import { icons } from '../../components/icons.js';
import { state } from '../../state/app-state.js';
import { SIGNALING_STATES } from '../../services/signaling.js';

/**
 * Set feedback message and style class on a form feedback element.
 *
 * @param {HTMLElement|null} el - Feedback container element
 * @param {string} message - Feedback text to display
 * @param {'clear'|'error'|'warning'|'success'} type - Severity class suffix
 */
export function setFeedback(el, message, type) {
  if (!el) return;
  el.textContent = message;
  el.className = `form-feedback feedback-${type}`;
}

/**
 * Render the complete pairing section markup.
 *
 * @param {object} [options]
 * @param {string} [options.liveSessionHtml=''] - Pre-rendered live session panel markup if active
 * @returns {string} HTML string
 */
export function renderPairingSection({ liveSessionHtml = '' } = {}) {
  const isCollapsed = state.signalingState !== SIGNALING_STATES.IDLE ? 'collapsed' : '';
  const displayCode = state.realRoomCode || 'PORT-????';

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

        <!-- Quick Start Onboarding Guide -->
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
          ${liveSessionHtml}
        </div>

        <!-- Create & Join Cards Grid -->
        <div id="pairing-cards-grid" class="pairing-grid ${isCollapsed}">
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
                <code id="display-room-code" class="room-code-tag">${displayCode}</code>
                <div class="code-actions-group">
                  <button type="button" id="copy-code-btn" class="btn btn-secondary btn-copy" aria-label="Copy room code" ${!state.realRoomCode ? 'disabled' : ''}>
                    <span class="copy-icon-wrap">${icons.copy(18)}</span>
                    <span class="copy-btn-text">Copy code</span>
                  </button>
                  <button type="button" id="copy-invite-btn" class="btn btn-secondary btn-copy btn-copy-invite" aria-label="Copy invitation link" ${!(state.realRoomCode && state.invitationToken) ? 'disabled' : ''}>
                    <span class="copy-icon-wrap">${icons.sparkles(16)}</span>
                    <span class="copy-invite-btn-text">Copy invite link</span>
                  </button>
                </div>
              </div>
              <div id="invitation-fallback-box" class="invitation-fallback-box hidden" aria-live="polite">
                <label for="fallback-invite-input" class="fallback-label">Select and copy invitation URL:</label>
                <input type="text" id="fallback-invite-input" class="form-input fallback-input" readonly spellcheck="false" />
              </div>
              <p class="code-helper-text">
                Creates a session on the signaling server and generates a secure guest invitation link.
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
                <p class="card-subtext">Enter the room code or invite link provided by your peer.</p>
              </div>
            </div>

            <form id="join-room-form" class="join-form" novalidate>
              <div class="form-field">
                <label for="room-code-input" class="form-label">Room Code or Invite Link</label>
                <div class="input-wrapper">
                  <input
                    type="text"
                    id="room-code-input"
                    class="form-input code-input"
                    placeholder="e.g. PORT-7K2M9X or paste invite link"
                    maxlength="256"
                    autocomplete="off"
                    spellcheck="false"
                    aria-describedby="join-code-feedback"
                  />
                  <button type="button" id="paste-sample-code-btn" class="input-inline-btn" title="Paste demo code">
                    Use Sample
                  </button>
                </div>
                <div id="join-code-feedback" class="form-feedback" aria-live="polite"></div>
                <p class="input-helper">Enter the 6-character room code or paste an invitation link.</p>
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

/**
 * Update dynamic values and loading states in the pairing cards.
 *
 * @param {HTMLElement} root - Root container element
 * @param {object} [currentState=state] - Application state
 */
export function updatePairingCardsUI(root, currentState = state) {
  if (!root) return;

  const displayCode = root.querySelector('#display-room-code');
  if (displayCode) {
    displayCode.textContent = currentState.realRoomCode || 'PORT-????';
  }

  const copyBtn = root.querySelector('#copy-code-btn');
  if (copyBtn) {
    copyBtn.disabled = !currentState.realRoomCode;
  }

  const copyInviteBtn = root.querySelector('#copy-invite-btn');
  if (copyInviteBtn) {
    copyInviteBtn.disabled = !(currentState.realRoomCode && currentState.invitationToken);
  }

  const cardsGrid = root.querySelector('#pairing-cards-grid');
  if (cardsGrid) {
    cardsGrid.classList.toggle('collapsed', currentState.signalingState !== SIGNALING_STATES.IDLE);
  }

  const createBtn = root.querySelector('#create-room-btn');
  const createBtnText = root.querySelector('#create-room-btn-text');
  if (createBtn && createBtnText) {
    if (currentState.signalingState === SIGNALING_STATES.CREATING) {
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
    if (currentState.signalingState === SIGNALING_STATES.JOINING) {
      joinBtn.classList.add('loading');
      joinBtnText.textContent = 'Connecting to room...';
    } else {
      joinBtn.classList.remove('loading');
      joinBtnText.textContent = 'Join Room';
    }
  }
}
