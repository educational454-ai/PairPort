/**
 * PairPort Ephemeral Chat UI Component
 * Layout and markup for the real-time P2P chat column and message list.
 */

import { icons } from '../../components/icons.js';
import { state } from '../../state/app-state.js';
import {
  PEER_CONNECTION_STATES,
  DATA_CHANNEL_STATES,
} from '../../services/peer-connection.js';
import { escapeHtml } from '../../utils/ui-helpers.js';

/**
 * Render individual chat messages safely avoiding XSS through escapeHtml.
 *
 * @param {object} [currentState=state] - Current application state
 * @returns {string} HTML string
 */
export function renderChatMessages(currentState = state) {
  const isDataChannelOpen = currentState.dataChannelState === DATA_CHANNEL_STATES.OPEN;

  // Real ephemeral session chat
  if (!currentState.realChatMessages || currentState.realChatMessages.length === 0) {
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

  return currentState.realChatMessages.map((msg) => {
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

/**
 * Render the complete chat column markup inside the workspace grid.
 *
 * @param {object} [currentState=state] - Current application state
 * @returns {string} HTML string
 */
export function renderChatColumn(currentState = state) {
  const isDataChannelOpen = currentState.dataChannelState === DATA_CHANNEL_STATES.OPEN;
  const messagesCount = currentState.realChatMessages ? currentState.realChatMessages.length : 0;

  return `
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
          <button type="button" id="chat-col-clear-btn" class="btn-clear-history" title="Clear chat messages" ${messagesCount === 0 ? 'disabled' : ''}>
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
        ${renderChatMessages(currentState)}
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
  `;
}

/**
 * Update dynamic chat badges, notices, input state, messages container, and clear buttons.
 *
 * @param {HTMLElement} root - Root container element
 * @param {object} [currentState=state] - Current application state
 */
export function updateChatUI(root, currentState = state) {
  if (!root) return;

  const isDataChannelOpen = currentState.dataChannelState === DATA_CHANNEL_STATES.OPEN;

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
      !currentState.isReconnecting &&
      !currentState.isSignalingReconnecting &&
      !currentState.isPeerDisconnected &&
      currentState.peerConnectionState === PEER_CONNECTION_STATES.CONNECTED;

    chatInput.disabled = !isChatAllowed;
    chatSendBtn.disabled = !isChatAllowed;

    if (currentState.isPeerDisconnected) {
      chatInput.placeholder = 'Peer disconnected temporarily. Waiting for peer reconnect...';
    } else if (currentState.isSignalingReconnecting) {
      chatInput.placeholder = 'Signaling disconnected. Reconnecting...';
    } else if (currentState.isReconnecting) {
      chatInput.placeholder = `Reconnecting to peer (Attempt ${currentState.reconnectAttempt || 1}/3)... In-flight chat paused.`;
    } else if (currentState.peerConnectionState === PEER_CONNECTION_STATES.FAILED) {
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
    messagesContainer.innerHTML = renderChatMessages(currentState);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // Update clear chat buttons disabled state
  const clearChatButtons = root.querySelectorAll('#clear-chat-btn, #chat-col-clear-btn');
  const hasMessages = currentState.realChatMessages && currentState.realChatMessages.length > 0;
  clearChatButtons.forEach((btn) => {
    btn.disabled = !hasMessages;
  });
}
