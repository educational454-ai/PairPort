/**
 * PairPort Pairing Feature Controller
 * Coordinates room creation, joining, input validation, code copying, and signaling triggers.
 */

import { APP_CONFIG } from '../../config/app-config.js';
import { signalingClient } from '../../services/signaling.js';
import { showToast } from '../../components/toast.js';
import { state } from '../../state/app-state.js';
import { validateRoomCode } from '../../utils/ui-helpers.js';
import { setFeedback } from './pairing-ui.js';

/**
 * Validate current room code input in real-time and render visual feedback.
 *
 * @param {HTMLInputElement} inputEl - Room code input element
 * @param {HTMLElement} feedbackEl - Target feedback container
 */
export function validateJoinInput(inputEl, feedbackEl) {
  if (!inputEl) return;
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

/**
 * Safely display feedback message on the join code feedback element.
 *
 * @param {HTMLElement} root - Root container element
 * @param {string} message - Message text
 * @param {'clear'|'error'|'warning'|'success'} [type='error'] - Feedback class
 */
export function setPairingFeedback(root, message, type = 'error') {
  if (!root) return;
  const feedbackEl = root.querySelector('#join-code-feedback');
  if (feedbackEl) {
    setFeedback(feedbackEl, message, type);
  }
}

/**
 * Initialize pairing section interactions and event listeners.
 * Prevents multiple registrations using dataset flag.
 *
 * @param {HTMLElement} root - Root element containing the pairing section
 * @param {object} [options]
 * @param {object} [options.signaling=signalingClient] - Signaling client service
 * @param {Function} [options.toast=showToast] - Toast notification function
 */
export function initPairing(root = document, { signaling = signalingClient, toast = showToast } = {}) {
  const pairingSection = root.querySelector('#pairing');
  if (!pairingSection || pairingSection.dataset.pairingInitialized === 'true') {
    return;
  }
  pairingSection.dataset.pairingInitialized = 'true';

  // 1. Real Room Creation Button (Phase 3 & 4)
  const createRoomBtn = pairingSection.querySelector('#create-room-btn');
  if (createRoomBtn) {
    createRoomBtn.addEventListener('click', () => {
      signaling.createRoom();
    });
  }

  // 2. Copy Code button on Create card
  const copyBtn = pairingSection.querySelector('#copy-code-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const codeToCopy = state.realRoomCode;
      if (!codeToCopy) return;

      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(codeToCopy);
        }
        toast(`Copied room code "${codeToCopy}" to clipboard!`, 'success', 3000);
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
        toast(`Room code: ${codeToCopy}`, 'info', 3000);
      }
    });
  }

  // 3. Join Room: Use sample code quick helper
  const pasteSampleBtn = pairingSection.querySelector('#paste-sample-code-btn');
  const roomCodeInput = pairingSection.querySelector('#room-code-input');
  const feedbackEl = pairingSection.querySelector('#join-code-feedback');
  if (pasteSampleBtn && roomCodeInput) {
    pasteSampleBtn.addEventListener('click', () => {
      roomCodeInput.value = state.realRoomCode || APP_CONFIG.demoData.roomCode;
      roomCodeInput.focus();
      validateJoinInput(roomCodeInput, feedbackEl);
    });
  }

  // 4. Join Room Form submission & uppercase auto-formatting
  const joinForm = pairingSection.querySelector('#join-room-form');
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
      signaling.joinRoom(result.code);
    });
  }
}
