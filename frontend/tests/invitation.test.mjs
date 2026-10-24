import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInvitationUrl,
  parseInvitation,
  parseAndClearLocationInvitation,
  copyInvitationToClipboard,
} from '../src/utils/invitation.js';
import { SignalingClient, SIGNALING_STATES } from '../src/services/signaling.js';
import { createInitialState, resetSessionState } from '../src/state/app-state.js';

describe('1. createInvitationUrl', () => {
  it('creates shareable URL containing room code and token in the URL fragment (#)', () => {
    const url = createInvitationUrl('PORT-7K2M9X', 'd41d8cd98f00b204e9800998ecf8427e', 'https://pairport.app/');
    assert.ok(url.startsWith('https://pairport.app/#join?'));
    assert.ok(url.includes('room=PORT-7K2M9X'));
    assert.ok(url.includes('token=d41d8cd98f00b204e9800998ecf8427e'));
    // Ensure token is NOT in the query string before the fragment
    const beforeHash = url.split('#')[0];
    assert.ok(!beforeHash.includes('token='));
  });

  it('normalizes room code to uppercase and strips existing hash/query from baseUrl', () => {
    const url = createInvitationUrl('port-abc123', 'secret_token_12345678', 'https://pairport.app/index.html?ref=test#oldhash');
    assert.ok(url.startsWith('https://pairport.app/index.html#join?'));
    assert.ok(url.includes('room=PORT-ABC123'));
    assert.ok(!url.includes('oldhash'));
    assert.ok(!url.includes('ref=test'));
  });

  it('returns empty string if roomCode or invitationToken is missing', () => {
    assert.equal(createInvitationUrl('', 'valid-token-12345678'), '');
    assert.equal(createInvitationUrl('PORT-ABC123', ''), '');
    assert.equal(createInvitationUrl(null, null), '');
  });
});

describe('2. parseInvitation', () => {
  it('parses valid invitation URL with fragment (#)', () => {
    const raw = 'https://pairport.app/#join?room=PORT-7K2M9X&token=0123456789abcdef0123456789abcdef';
    const parsed = parseInvitation(raw);
    assert.equal(parsed.isValid, true);
    assert.equal(parsed.roomCode, 'PORT-7K2M9X');
    assert.equal(parsed.invitationToken, '0123456789abcdef0123456789abcdef');
    assert.equal(parsed.error, null);
  });

  it('parses standalone fragment (#join?...)', () => {
    const raw = '#join?room=PORT-4M8P2Q&token=c2VjcmV0X3Rva2VuXzEyMzQ1Njc4';
    const parsed = parseInvitation(raw);
    assert.equal(parsed.isValid, true);
    assert.equal(parsed.roomCode, 'PORT-4M8P2Q');
    assert.equal(parsed.invitationToken, 'c2VjcmV0X3Rva2VuXzEyMzQ1Njc4');
    assert.equal(parsed.error, null);
  });

  it('rejects plain room code when token is missing with INVITATION_REQUIRED', () => {
    const raw = 'PORT-7K2M9X';
    const parsed = parseInvitation(raw);
    assert.equal(parsed.isValid, false);
    assert.equal(parsed.roomCode, 'PORT-7K2M9X');
    assert.equal(parsed.invitationToken, null);
    assert.equal(parsed.error, 'INVITATION_REQUIRED');
    assert.ok(parsed.message.includes('invitation token'));
  });

  it('rejects malformed token (too short or invalid chars) with INVALID_TOKEN_FORMAT', () => {
    const shortTokenUrl = 'https://pairport.app/#join?room=PORT-7K2M9X&token=short';
    const shortParsed = parseInvitation(shortTokenUrl);
    assert.equal(shortParsed.isValid, false);
    assert.equal(shortParsed.error, 'INVALID_TOKEN_FORMAT');

    const invalidCharsUrl = 'https://pairport.app/#join?room=PORT-7K2M9X&token=invalid@token$with*bad!chars';
    const charsParsed = parseInvitation(invalidCharsUrl);
    assert.equal(charsParsed.isValid, false);
    assert.equal(charsParsed.error, 'INVALID_TOKEN_FORMAT');
  });

  it('rejects invalid room code format inside invitation', () => {
    const badCodeUrl = 'https://pairport.app/#join?room=INVALID_CODE_TOO_LONG&token=0123456789abcdef0123456789abcdef';
    const parsed = parseInvitation(badCodeUrl);
    assert.equal(parsed.isValid, false);
    assert.equal(parsed.invitationToken, null);
    assert.ok(parsed.error);
  });

  it('rejects empty, whitespace, or non-string inputs safely', () => {
    assert.equal(parseInvitation('').isValid, false);
    assert.equal(parseInvitation('   ').isValid, false);
    assert.equal(parseInvitation(null).isValid, false);
    assert.equal(parseInvitation(undefined).isValid, false);
  });
});

describe('3. parseAndClearLocationInvitation', () => {
  it('extracts invitation and clears sensitive fragment from URL via history.replaceState', () => {
    let replacedUrl = null;
    const fakeLocation = {
      hash: '#join?room=PORT-7K2M9X&token=0123456789abcdef0123456789abcdef',
      pathname: '/pairport/',
      search: '',
    };
    const fakeHistory = {
      replaceState: (state, title, url) => {
        replacedUrl = url;
      },
    };

    const result = parseAndClearLocationInvitation(fakeLocation, fakeHistory);
    assert.ok(result);
    assert.equal(result.roomCode, 'PORT-7K2M9X');
    assert.equal(result.invitationToken, '0123456789abcdef0123456789abcdef');
    assert.equal(replacedUrl, '/pairport/', 'Sensitive fragment must be removed from URL bar');
  });

  it('returns null and does not invoke replaceState if hash is empty or not an invitation', () => {
    let replacedUrl = null;
    const fakeLocation = { hash: '', pathname: '/' };
    const fakeHistory = {
      replaceState: () => { replacedUrl = 'called'; },
    };

    const result = parseAndClearLocationInvitation(fakeLocation, fakeHistory);
    assert.equal(result, null);
    assert.equal(replacedUrl, null);
  });
});

describe('4. copyInvitationToClipboard and fallback handling', () => {
  it('copies URL to clipboard and invokes success toast when clipboard write succeeds', async () => {
    let writtenText = null;
    let toastedMessage = null;

    const originalClipboard = globalThis.navigator?.clipboard;
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: {
        writeText: async (text) => { writtenText = text; },
      },
      configurable: true,
      writable: true,
    });

    try {
      const success = await copyInvitationToClipboard('PORT-7K2M9X', 'test-token-0123456789abcdef', {
        toast: (msg) => { toastedMessage = msg; },
      });

      assert.equal(success, true);
      assert.ok(writtenText.includes('#join?room=PORT-7K2M9X'));
      assert.ok(toastedMessage.includes('Copied'));
    } finally {
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        value: originalClipboard,
        configurable: true,
        writable: true,
      });
    }
  });

  it('falls back to selectable input box when clipboard access is rejected', async () => {
    let fallbackBoxHidden = true;
    let fallbackInputValue = '';
    let selected = false;

    const originalClipboard = globalThis.navigator?.clipboard;
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: {
        writeText: async () => { throw new Error('Permission denied'); },
      },
      configurable: true,
      writable: true,
    });

    const fakeBox = {
      classList: {
        remove: (cls) => { if (cls === 'hidden') fallbackBoxHidden = false; },
        add: (cls) => { if (cls === 'hidden') fallbackBoxHidden = true; },
      },
    };
    const fakeInput = {
      set value(v) { fallbackInputValue = v; },
      get value() { return fallbackInputValue; },
      focus: () => {},
      select: () => { selected = true; },
    };

    try {
      const success = await copyInvitationToClipboard('PORT-7K2M9X', 'test-token-0123456789abcdef', {
        toast: () => {},
        fallbackBoxEl: fakeBox,
        fallbackInputEl: fakeInput,
      });

      assert.equal(success, false);
      assert.equal(fallbackBoxHidden, false, 'Fallback box should be unhidden');
      assert.ok(fallbackInputValue.includes('token=test-token-0123456789abcdef'));
      assert.equal(selected, true, 'Input text should be selected for manual copy');
    } finally {
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        value: originalClipboard,
        configurable: true,
        writable: true,
      });
    }
  });
});

describe('5. SignalingClient Invitation Flow & Authorization Protocol', () => {
  let client;

  beforeEach(() => {
    client = new SignalingClient('ws://127.0.0.1:8000/ws');
  });

  it('captures invitation_token from room-created payload in memory', () => {
    assert.equal(client.invitationToken, null);

    let roomCreatedPayload = null;
    client.on('roomCreated', (payload) => {
      roomCreatedPayload = payload;
    });

    // Simulate backend room-created event with invitation_token via stringified JSON
    client._handleMessage(JSON.stringify({
      type: 'room-created',
      payload: {
        room_code: 'PORT-7K2M9X',
        role: 'host',
        invitation_token: 'auth-token-c0ffee-1234567890',
      },
    }));

    assert.equal(client.invitationToken, 'auth-token-c0ffee-1234567890');
    assert.equal(roomCreatedPayload.invitation_token, 'auth-token-c0ffee-1234567890');
    assert.equal(client.state, SIGNALING_STATES.IDLE);
  });

  it('refuses to join without an invitation token (no room-code-only fallback)', () => {
    let errorEvent = null;
    client.on('error', (err) => {
      errorEvent = err;
    });

    client.joinRoom('PORT-7K2M9X', null);

    assert.equal(client.state, SIGNALING_STATES.ERROR);
    assert.ok(errorEvent);
    assert.equal(errorEvent.code, 'INVITATION_REQUIRED');
    assert.equal(client.ws, null, 'Must NOT open WebSocket connection without token');
  });

  it('sends invitation_token in join payload and never in WS query params', async () => {
    let sentMessage = null;
    let targetWsUrl = null;

    class MockWebSocket {
      constructor(url) {
        targetWsUrl = url;
        this.readyState = 1;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        queueMicrotask(() => {
          if (typeof this.onopen === 'function') {
            this.onopen();
          }
        });
      }
      send(msg) {
        sentMessage = JSON.parse(msg);
      }
      close() {}
    }
    MockWebSocket.OPEN = 1;

    const originalWs = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket;

    try {
      client.joinRoom('PORT-7K2M9X', 'valid-invitation-token-12345');
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.ok(targetWsUrl.endsWith('/ws'), 'WS URL must NOT contain token in query params');
      assert.ok(!targetWsUrl.includes('token='), 'WS URL must be clean');
      assert.ok(sentMessage);
      assert.equal(sentMessage.type, 'join');
      assert.equal(sentMessage.payload.room_code, 'PORT-7K2M9X');
      assert.equal(sentMessage.payload.invitation_token, 'valid-invitation-token-12345');
    } finally {
      globalThis.WebSocket = originalWs;
    }
  });

  it('clears invitationToken from memory on leaveRoom', () => {
    client.invitationToken = 'active-secret-token';
    client.leaveRoom();
    assert.equal(client.invitationToken, null);
  });
});

describe('6. State & Token Lifecycle Security', () => {
  it('initializes invitationToken to null and clears it on resetSessionState', () => {
    const s = createInitialState();
    assert.equal(s.invitationToken, null);

    s.invitationToken = 'memory-only-secret-token';
    resetSessionState(s);
    assert.equal(s.invitationToken, null);
  });

  it('verifies invitation tokens are not persisted to storage', () => {
    if (typeof localStorage !== 'undefined') {
      assert.equal(localStorage.getItem('invitation_token'), null);
      assert.equal(localStorage.getItem('token'), null);
    }
    if (typeof sessionStorage !== 'undefined') {
      assert.equal(sessionStorage.getItem('invitation_token'), null);
      assert.equal(sessionStorage.getItem('token'), null);
    }
  });
});
