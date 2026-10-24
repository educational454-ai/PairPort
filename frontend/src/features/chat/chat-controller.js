/**
 * PairPort Ephemeral Chat Feature Controller
 * Handles user input, Enter-key submission, P2P message sending, incoming message events, and clear-chat confirmation.
 */

import { showToast } from '../../components/toast.js';
import { showConfirmDialog } from '../../components/modal.js';
import { peerConnectionService } from '../../services/peer-connection.js';
import { state } from '../../state/app-state.js';
import { updateChatUI, renderChatMessages } from './chat-ui.js';

/**
 * Initialize ephemeral chat event listeners and P2P data channel handlers.
 * Idempotently attaches to the given root DOM node.
 *
 * @param {HTMLElement} root - Root application container
 * @param {object} [options]
 * @param {object} [options.peerConnection=peerConnectionService] - WebRTC peer connection service
 * @param {Function} [options.toast=showToast] - Toast notification function
 * @param {Function} [options.confirm=showConfirmDialog] - Confirmation modal function
 * @returns {object} Controller API methods
 */
export function initChat(root = document, {
  peerConnection = peerConnectionService,
  toast = showToast,
  confirm = showConfirmDialog,
} = {}) {
  // Prevent duplicate registration on same root
  const rootTarget = root && root.nodeType === 9 ? root.documentElement : root;
  if (rootTarget && rootTarget.dataset) {
    if (rootTarget.dataset.chatInitialized === 'true') {
      return { updateChatUI: () => updateChatUI(root, state) };
    }
    rootTarget.dataset.chatInitialized = 'true';
  } else if (root && root._chatInitialized) {
    return { updateChatUI: () => updateChatUI(root, state) };
  } else if (root) {
    root._chatInitialized = true;
  }

  // 1. Subscribe to incoming WebRTC chatMessage events
  peerConnection.on('chatMessage', (msg) => {
    state.realChatMessages.push(msg);
    updateChatUI(root, state);
    if (msg.text) {
      toast(`New message from peer: "${msg.text.slice(0, 30)}..."`, 'info', 2500);
    }
  });

  // 2. Chat input character counting and Enter key submission
  const chatForm = root.querySelector('#chat-form');
  const chatInput = root.querySelector('#chat-input');
  const charCounter = root.querySelector('#char-counter');
  const messagesContainer = root.querySelector('#chat-messages-container');

  if (chatInput && charCounter) {
    chatInput.addEventListener('input', () => {
      const remaining = 1000 - chatInput.value.length;
      charCounter.textContent = String(remaining);
    });

    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (chatForm) {
          if (typeof chatForm.requestSubmit === 'function') {
            chatForm.requestSubmit();
          } else {
            chatForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
          }
        }
      }
    });
  }

  // 3. Chat form submission and P2P dispatch
  if (chatForm && chatInput) {
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = chatInput.value;
      if (!text || !text.trim()) return;

      if (!peerConnection.isChatReady() || state.isPeerDisconnected || state.isSignalingReconnecting) {
        toast('WebRTC DataChannel is not open. Connect with a peer first.', 'warning', 3500);
        return;
      }

      try {
        const localMessage = peerConnection.sendChatMessage(text);
        state.realChatMessages.push(localMessage);

        chatInput.value = '';
        if (charCounter) charCounter.textContent = '1000';

        if (messagesContainer) {
          messagesContainer.innerHTML = renderChatMessages(state);
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        const clearChatButtons = root.querySelectorAll('#clear-chat-btn, #chat-col-clear-btn');
        clearChatButtons.forEach((btn) => { btn.disabled = false; });
      } catch (err) {
        toast(`Failed to send message: ${err.message}`, 'warning', 4000);
      }
    });
  }

  // 4. Clear chat buttons with confirmation dialog
  const clearChatButtons = root.querySelectorAll('#clear-chat-btn, #chat-col-clear-btn');
  clearChatButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.realChatMessages || state.realChatMessages.length === 0) return;

      confirm({
        title: 'Clear Chat Messages?',
        message: 'Clear chat messages from your screen for this session? Your room connection and active file transfers will not be affected.',
        confirmText: 'Clear Chat',
        cancelText: 'Cancel',
        isDestructive: true,
        onConfirm: () => {
          state.realChatMessages = [];
          updateChatUI(root, state);
          toast('Chat history cleared from session memory.', 'info', 3000);
        },
      });
    });
  });

  return {
    updateChatUI: () => updateChatUI(root, state),
  };
}
