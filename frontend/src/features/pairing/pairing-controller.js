/**
 * PairPort Pairing Feature Controller
 * Coordinates room creation, joining, input validation, code copying, and signaling triggers.
 */

import { APP_CONFIG } from '../../config/app-config.js';
import { signalingClient } from '../../services/signaling.js';
import { showToast } from '../../components/toast.js';
import { state } from '../../state/app-state.js';
import { validateRoomCode } from '../../utils/ui-helpers.js';
import {
  parseInvitation,
  parseAndClearLocationInvitation,
  copyInvitationToClipboard,
} from '../../utils/invitation.js';
import { setFeedback } from './pairing-ui.js';

/**
 * Validate current room code or invitation input in real-time and render visual feedback.
 *
 * @param {HTMLInputElement} inputEl - Room code input element
 * @param {HTMLElement} feedbackEl - Target feedback container
 * @param {object} [signaling=signalingClient] - Signaling client instance
 */
export function validateJoinInput(inputEl, feedbackEl, signaling = signalingClient) {
  if (!inputEl) return;
  const sig = signaling || signalingClient;
  const val = inputEl.value.trim();
  if (!val) {
    // Input is empty: invalidate bound token in app state and signaling client
    state.invitationToken = null;
    state.invitationRoomCode = null;
    sig.invitationToken = null;
    sig.invitationRoomCode = null;
    setFeedback(feedbackEl, '', 'clear');
    return;
  }

  // Check if user input is an invitation URL, fragment, or query
  if (val.includes('#') || val.includes('?') || val.includes('token=') || val.length > 16) {
    const invite = parseInvitation(val);
    if (invite.isValid && invite.invitationToken) {
      state.invitationToken = invite.invitationToken;
      state.invitationRoomCode = invite.roomCode;
      sig.invitationToken = invite.invitationToken;
      sig.invitationRoomCode = invite.roomCode;
      inputEl.value = invite.roomCode;
      setFeedback(feedbackEl, `Secure invitation verified for room ${invite.roomCode}. Click Join to connect.`, 'success');
      return;
    } else if (invite.error === 'INVALID_TOKEN_FORMAT') {
      state.invitationToken = null;
      state.invitationRoomCode = null;
      sig.invitationToken = null;
      sig.invitationRoomCode = null;
      setFeedback(feedbackEl, 'Invitation token format is invalid.', 'error');
      return;
    } else if (val.includes('token=') || val.includes('#join')) {
      state.invitationToken = null;
      state.invitationRoomCode = null;
      sig.invitationToken = null;
      sig.invitationRoomCode = null;
      setFeedback(feedbackEl, invite.message || 'Invalid invitation link or room code format.', 'error');
      return;
    }
  }

  const result = validateRoomCode(val);
  if (!result.isValid) {
    // Incomplete or invalid room code: invalidate previously bound token
    if (state.invitationRoomCode) {
      state.invitationToken = null;
      state.invitationRoomCode = null;
      sig.invitationToken = null;
      sig.invitationRoomCode = null;
    }
    setFeedback(feedbackEl, result.message, 'warning');
  } else {
    // Valid format. Check if this matches the bound invitation room
    if (state.invitationRoomCode) {
      if (state.invitationRoomCode === result.code && state.invitationToken) {
        // Harmless normalization (e.g. lowercase or whitespace): keep token valid!
        setFeedback(feedbackEl, `Secure invitation verified for room ${result.code}. Click Join to connect.`, 'success');
      } else {
        // Code changed to a DIFFERENT room: invalidate bound token
        state.invitationToken = null;
        state.invitationRoomCode = null;
        sig.invitationToken = null;
        sig.invitationRoomCode = null;
        setFeedback(feedbackEl, 'Format looks valid. Click Join to connect.', 'success');
      }
    } else {
      setFeedback(feedbackEl, 'Format looks valid. Click Join to connect.', 'success');
    }
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
 * @param {Location} [options.location] - Optional location override for testing
 * @param {History} [options.history] - Optional history override for testing
 */
export function initPairing(
  root = document,
  {
    signaling = signalingClient,
    toast = showToast,
    location,
    history,
  } = {},
) {
  const pairingSection = root.querySelector('#pairing');
  if (!pairingSection || pairingSection.dataset.pairingInitialized === 'true') {
    return { locationInvite: null };
  }
  pairingSection.dataset.pairingInitialized = 'true';

  const roomCodeInput = pairingSection.querySelector('#room-code-input');
  const feedbackEl = pairingSection.querySelector('#join-code-feedback');

  // 0. Auto-detect invitation in URL fragment (#join?room=...&token=...)
  const locationInvite = parseAndClearLocationInvitation(location, history);
  if (locationInvite) {
    if (locationInvite.isValid && locationInvite.invitationToken) {
      state.invitationToken = locationInvite.invitationToken;
      state.invitationRoomCode = locationInvite.roomCode;
      signaling.invitationToken = locationInvite.invitationToken;
      signaling.invitationRoomCode = locationInvite.roomCode;
      if (roomCodeInput) {
        roomCodeInput.value = locationInvite.roomCode;
      }
      if (feedbackEl) {
        setFeedback(
          feedbackEl,
          `Secure invitation loaded for room ${locationInvite.roomCode}. Click Join to connect.`,
          'success',
        );
      }
      toast(`Loaded invitation for room ${locationInvite.roomCode}`, 'info', 3000);
    } else {
      state.invitationToken = null;
      state.invitationRoomCode = null;
      signaling.invitationToken = null;
      signaling.invitationRoomCode = null;
      if (feedbackEl) {
        setFeedback(
          feedbackEl,
          locationInvite.message || 'Invalid or malformed invitation link.',
          'error',
        );
      }
      toast(locationInvite.message || 'Invalid invitation link in URL.', 'warning', 4000);
    }
  }

  // 1. Real Room Creation Button
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

  // 2b. Copy Invite Link button on Create card
  const copyInviteBtn = pairingSection.querySelector('#copy-invite-btn');
  const fallbackBoxEl = pairingSection.querySelector('#invitation-fallback-box');
  const fallbackInputEl = pairingSection.querySelector('#fallback-invite-input');
  if (copyInviteBtn) {
    copyInviteBtn.addEventListener('click', async () => {
      const code = state.realRoomCode;
      const token = state.invitationToken;
      if (!code || !token) {
        toast('Create a room first to generate an invitation link.', 'info', 3000);
        return;
      }
      await copyInvitationToClipboard(code, token, {
        toast,
        fallbackBoxEl,
        fallbackInputEl,
        buttonEl: copyInviteBtn,
      });
    });
  }
  if (fallbackInputEl) {
    fallbackInputEl.addEventListener('click', () => {
      fallbackInputEl.select();
    });
  }

  // 3. Join Room: Use sample code quick helper
  const pasteSampleBtn = pairingSection.querySelector('#paste-sample-code-btn');
  if (pasteSampleBtn && roomCodeInput) {
    pasteSampleBtn.addEventListener('click', () => {
      roomCodeInput.value = state.realRoomCode || APP_CONFIG.demoData.roomCode;
      roomCodeInput.focus();
      validateJoinInput(roomCodeInput, feedbackEl, signaling);
    });
  }

  // 4. Join Room Form submission & input handling
  const joinForm = pairingSection.querySelector('#join-room-form');
  if (joinForm && roomCodeInput && feedbackEl) {
    roomCodeInput.addEventListener('input', () => {
      const val = roomCodeInput.value.trim();
      // Only auto-uppercase if not a full URL or query string with case-sensitive token
      if (!val.includes('#') && !val.includes('?') && !val.includes('http') && !val.includes('token=')) {
        roomCodeInput.value = roomCodeInput.value.toUpperCase();
      }
      validateJoinInput(roomCodeInput, feedbackEl, signaling);
    });

    joinForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const rawVal = roomCodeInput.value.trim();

      // Check if user submitted full invitation URL or fragment
      if (rawVal.includes('#') || rawVal.includes('?') || rawVal.includes('token=')) {
        const invite = parseInvitation(rawVal);
        if (invite.isValid && invite.invitationToken) {
          state.invitationToken = invite.invitationToken;
          state.invitationRoomCode = invite.roomCode;
          signaling.invitationToken = invite.invitationToken;
          signaling.invitationRoomCode = invite.roomCode;
          roomCodeInput.value = invite.roomCode;
        }
      }

      const codeVal = roomCodeInput.value.trim();
      const result = validateRoomCode(codeVal);

      if (!result.isValid) {
        setFeedback(feedbackEl, result.message, 'error');
        roomCodeInput.focus();
        return;
      }

      // If user has a verified invitation token for THIS room, send it.
      // Otherwise, join with the room code alone.
      const token = (state.invitationToken && state.invitationRoomCode === result.code)
        ? state.invitationToken
        : null;

      setFeedback(feedbackEl, `Attempting to join room "${result.code}"...`, 'warning');
      signaling.joinRoom(result.code, token);
    });
  }

  return { locationInvite };
}
