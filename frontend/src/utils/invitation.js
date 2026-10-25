/**
 * PairPort Invitation Token & URL Helpers (Step 9F-2)
 *
 * Implements secure generation and parsing of guest invitation links.
 * Secrets are exclusively stored in the URL fragment (#) so they are
 * never transmitted over HTTP headers, proxy logs, referrers, or query strings.
 */

import { validateRoomCode } from './ui-helpers.js';

/**
 * Construct a shareable invitation URL with the secret token in the URL fragment.
 * Format: [origin][pathname]#join?room=[ROOM_CODE]&token=[INVITATION_TOKEN]
 *
 * @param {string} roomCode - Clean 6-character room code (e.g. PORT-7K2M9X)
 * @param {string} invitationToken - 128-bit CSPRNG url-safe invitation token
 * @param {string} [baseUrl] - Optional override for origin + pathname (default: window.location)
 * @returns {string} Formatted invitation link with secret in fragment
 */
export function createInvitationUrl(roomCode, invitationToken, baseUrl) {
  if (!roomCode || !invitationToken) return '';

  const cleanCode = String(roomCode).trim().toUpperCase();
  const cleanToken = String(invitationToken).trim();

  let base = baseUrl;
  if (!base && typeof window !== 'undefined' && window.location) {
    base = `${window.location.origin}${window.location.pathname}`;
  }
  base = base || '';

  // Strip any existing hash or query string from base
  const hashIdx = base.indexOf('#');
  if (hashIdx !== -1) base = base.slice(0, hashIdx);
  const qIdx = base.indexOf('?');
  if (qIdx !== -1) base = base.slice(0, qIdx);

  return `${base}#join?room=${encodeURIComponent(cleanCode)}&token=${encodeURIComponent(cleanToken)}`;
}

/**
 * Parse an invitation string (full URL, fragment, query, or room code).
 *
 * @param {string} input - Raw input string
 * @returns {{
 *   isValid: boolean,
 *   roomCode: string,
 *   invitationToken: string | null,
 *   error: string | null,
 *   message: string
 * }}
 */
export function parseInvitation(input) {
  if (!input || typeof input !== 'string') {
    return {
      isValid: false,
      roomCode: '',
      invitationToken: null,
      error: 'EMPTY_INPUT',
      message: 'Invitation input cannot be empty.',
    };
  }

  const raw = input.trim();
  let queryString = '';

  // Extract query string from fragment if present
  const hashIndex = raw.indexOf('#');
  if (hashIndex !== -1) {
    const fragment = raw.slice(hashIndex + 1);
    const qIndex = fragment.indexOf('?');
    queryString = qIndex !== -1 ? fragment.slice(qIndex + 1) : fragment;
  } else if (raw.includes('?')) {
    queryString = raw.slice(raw.indexOf('?') + 1);
  } else if (raw.includes('=')) {
    queryString = raw;
  }

  if (queryString) {
    try {
      const params = new URLSearchParams(queryString);
      let room = null;
      let token = null;
      try {
        room = params.get('room') || params.get('code') || params.get('room_code');
      } catch {
        room = null;
      }
      try {
        token = params.get('token') || params.get('invitation_token') || params.get('invite');
      } catch {
        token = null;
      }

      if (room && token) {
        room = room.trim().toUpperCase();
        token = token.trim();

        const roomValidation = validateRoomCode(room);
        if (!roomValidation.isValid) {
          return {
            isValid: false,
            roomCode: room,
            invitationToken: null,
            error: roomValidation.error,
            message: roomValidation.message,
          };
        }

        // Token must be at least 16 characters and contain only base64url characters
        if (token.length < 16 || !/^[A-Za-z0-9_-]+$/.test(token)) {
          return {
            isValid: false,
            roomCode: roomValidation.code,
            invitationToken: null,
            error: 'INVALID_TOKEN_FORMAT',
            message: 'Invitation token format is invalid.',
          };
        }

        return {
          isValid: true,
          roomCode: roomValidation.code,
          invitationToken: token,
          error: null,
          message: 'Valid invitation link.',
        };
      }

      if (room && !token) {
        const roomValidation = validateRoomCode(room.trim().toUpperCase());
        return {
          isValid: false,
          roomCode: roomValidation.isValid ? roomValidation.code : room,
          invitationToken: null,
          error: 'INVITATION_REQUIRED',
          message: 'An invitation token or valid invite link is required to join this room.',
        };
      }

      if (!room && token) {
        return {
          isValid: false,
          roomCode: '',
          invitationToken: null,
          error: 'MISSING_ROOM_CODE',
          message: 'Invitation link is missing a room code.',
        };
      }
    } catch {
      return {
        isValid: false,
        roomCode: '',
        invitationToken: null,
        error: 'MALFORMED_INVITATION',
        message: 'Malformed invitation link.',
      };
    }
  }

  // Plain room code without token
  const plainValidation = validateRoomCode(raw);
  if (plainValidation.isValid) {
    return {
      isValid: false,
      roomCode: plainValidation.code,
      invitationToken: null,
      error: 'INVITATION_REQUIRED',
      message: 'An invitation token or valid invite link is required to join this room.',
    };
  }

  return {
    isValid: false,
    roomCode: '',
    invitationToken: null,
    error: 'INVALID_INVITATION',
    message: 'Invalid invitation link or room code format.',
  };
}

/**
 * Detect whether a URL hash/fragment is an invitation-related fragment.
 * Matches:
 *  - Fragments starting with #join or join (e.g., '#join?room=...', '#join')
 *  - Fragments containing 'token=' or 'invitation_token=' or 'invite='
 *
 * @param {string} hash
 * @returns {boolean}
 */
export function isInvitationFragment(hash) {
  if (!hash || typeof hash !== 'string') return false;
  const clean = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!clean) return false;

  if (clean === 'join' || clean.startsWith('join?') || clean.startsWith('join&') || clean.startsWith('join/')) {
    return true;
  }
  if (/(?:^|[?&#])(?:token|invitation_token|invite)=/i.test(clean)) {
    return true;
  }
  return false;
}

/**
 * Check window.location.hash for an invitation fragment, sanitize the URL bar
 * using history.replaceState (even if the invitation is invalid or malformed),
 * and return the safe parsed invitation result.
 *
 * Leaves unrelated hashes (e.g. #features, #how-it-works) untouched.
 *
 * @param {Location} [loc] - Location object (default: window.location)
 * @param {History} [hist] - History object (default: window.history)
 * @returns {{
 *   isValid: boolean,
 *   roomCode: string,
 *   invitationToken: string | null,
 *   error: string | null,
 *   message: string,
 *   urlCleared: boolean,
 *   replaceStateError?: string | null,
 * } | null}
 */
export function parseAndClearLocationInvitation(
  loc = typeof window !== 'undefined' ? window.location : null,
  hist = typeof window !== 'undefined' ? window.history : null,
) {
  if (!loc || !loc.hash) return null;

  // 1. Only process invitation-related fragments; leave unrelated hashes intact
  if (!isInvitationFragment(loc.hash)) {
    return null;
  }

  // 2. Always attempt history.replaceState to sanitize the address bar regardless of token validity
  let urlCleared = false;
  let replaceStateError = null;

  if (hist && typeof hist.replaceState === 'function') {
    try {
      const cleanUrl = (loc.pathname || '/') + (loc.search || '');
      hist.replaceState(null, '', cleanUrl);
      urlCleared = true;
    } catch (err) {
      urlCleared = false;
      replaceStateError = err ? err.message : 'replaceState failed';
    }
  }

  // 3. Defensively parse the fragment without throwing on malformed percent-encoding
  let parsed = null;
  try {
    parsed = parseInvitation(loc.hash);
  } catch {
    parsed = {
      isValid: false,
      roomCode: '',
      invitationToken: null,
      error: 'MALFORMED_INVITATION',
      message: 'Invitation link could not be parsed.',
    };
  }

  // 4. Return safe, non-secret-bearing result
  if (parsed && parsed.isValid && parsed.invitationToken) {
    return {
      isValid: true,
      hasFragment: true,
      roomCode: parsed.roomCode,
      invitationToken: parsed.invitationToken,
      error: null,
      message: parsed.message,
      urlCleared,
      replaceStateError,
    };
  }

  return {
    isValid: false,
    hasFragment: true,
    roomCode: (parsed && parsed.roomCode) || '',
    invitationToken: null,
    error: (parsed && parsed.error) || 'INVALID_INVITATION',
    message: (parsed && parsed.message) || 'Invalid invitation link format.',
    urlCleared,
    replaceStateError,
  };
}

/**
 * Copy invitation URL to clipboard with selectable fallback handling.
 *
 * @param {string} roomCode - Room code
 * @param {string} invitationToken - Invitation token
 * @param {object} [options]
 * @param {Function} [options.toast] - Toast notification function
 * @param {HTMLElement} [options.fallbackBoxEl] - Fallback container element
 * @param {HTMLInputElement} [options.fallbackInputEl] - Fallback input element
 * @param {HTMLElement} [options.buttonEl] - Triggering button element
 * @returns {Promise<boolean>} True if clipboard write succeeded, false if fallback triggered
 */
export async function copyInvitationToClipboard(
  roomCode,
  invitationToken,
  {
    toast,
    fallbackBoxEl = null,
    fallbackInputEl = null,
    buttonEl = null,
  } = {},
) {
  const url = createInvitationUrl(roomCode, invitationToken);
  if (!url) return false;

  let copied = false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(url);
      copied = true;
    }
  } catch {
    copied = false;
  }

  if (copied) {
    if (typeof toast === 'function') {
      toast('Copied secure invitation link to clipboard!', 'success', 3000);
    }
    if (buttonEl) {
      const textSpan = buttonEl.querySelector('.copy-invite-btn-text, .copy-live-invite-text') || buttonEl;
      const originalText = textSpan.textContent;
      textSpan.textContent = 'Copied Link! ✓';
      buttonEl.classList.add('copied');
      setTimeout(() => {
        textSpan.textContent = originalText;
        buttonEl.classList.remove('copied');
      }, 2000);
    }
    if (fallbackBoxEl) {
      fallbackBoxEl.classList.add('hidden');
    }
    return true;
  }

  // Clipboard failed or unavailable: trigger accessible fallback
  if (typeof toast === 'function') {
    toast('Clipboard access unavailable. Select and copy the invite link below.', 'info', 4000);
  }
  if (fallbackBoxEl && fallbackInputEl) {
    fallbackBoxEl.classList.remove('hidden');
    fallbackInputEl.value = url;
    fallbackInputEl.focus();
    fallbackInputEl.select();
  }
  return false;
}

