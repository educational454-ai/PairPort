import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInvitationUrl,
  parseInvitation,
  parseAndClearLocationInvitation,
  copyInvitationToClipboard,
  isInvitationFragment,
} from '../src/utils/invitation.js';
import { SignalingClient, SIGNALING_STATES } from '../src/services/signaling.js';
import { createInitialState, resetSessionState, state } from '../src/state/app-state.js';
import { initConnectionController } from '../src/features/connection/connection-controller.js';

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

describe('3. parseAndClearLocationInvitation & isInvitationFragment', () => {
  it('detects invitation fragment forms accurately via isInvitationFragment', () => {
    assert.equal(isInvitationFragment('#join?room=PORT-7K2M9X&token=123'), true);
    assert.equal(isInvitationFragment('#join'), true);
    assert.equal(isInvitationFragment('#token=abc12345'), true);
    assert.equal(isInvitationFragment('#invitation_token=xyz'), true);
    assert.equal(isInvitationFragment('#invite=port'), true);
    assert.equal(isInvitationFragment('#features'), false);
    assert.equal(isInvitationFragment('#how-it-works'), false);
    assert.equal(isInvitationFragment('#about'), false);
    assert.equal(isInvitationFragment(''), false);
    assert.equal(isInvitationFragment(null), false);
  });

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
    assert.equal(result.isValid, true);
    assert.equal(result.urlCleared, true);
    assert.equal(result.roomCode, 'PORT-7K2M9X');
    assert.equal(result.invitationToken, '0123456789abcdef0123456789abcdef');
    assert.equal(replacedUrl, '/pairport/', 'Sensitive fragment must be removed from URL bar');
  });

  it('clears malformed room/token invitation fragments via history.replaceState', () => {
    let replacedUrl = null;
    const fakeLocation = {
      hash: '#join?room=INVALID_TOO_LONG&token=short',
      pathname: '/app/',
      search: '',
    };
    const fakeHistory = {
      replaceState: (state, title, url) => {
        replacedUrl = url;
      },
    };

    const result = parseAndClearLocationInvitation(fakeLocation, fakeHistory);
    assert.ok(result);
    assert.equal(result.isValid, false);
    assert.equal(result.urlCleared, true, 'Malformed invitation fragment must still be cleared from address bar');
    assert.equal(replacedUrl, '/app/');
    assert.equal(result.invitationToken, null);
  });

  it('handles malformed percent-encoding safely without throwing and clears URL', () => {
    let replacedUrl = null;
    const fakeLocation = {
      hash: '#join?room=%E0%A4%A&token=%99',
      pathname: '/',
      search: '',
    };
    const fakeHistory = {
      replaceState: (state, title, url) => {
        replacedUrl = url;
      },
    };

    let result;
    assert.doesNotThrow(() => {
      result = parseAndClearLocationInvitation(fakeLocation, fakeHistory);
    });
    assert.ok(result);
    assert.equal(result.isValid, false);
    assert.equal(result.urlCleared, true);
    assert.equal(replacedUrl, '/');
  });

  it('leaves unrelated URL hashes intact and does not invoke replaceState', () => {
    let replacedUrl = null;
    const fakeLocation = {
      hash: '#features',
      pathname: '/',
      search: '',
    };
    const fakeHistory = {
      replaceState: (state, title, url) => {
        replacedUrl = url;
      },
    };

    const result = parseAndClearLocationInvitation(fakeLocation, fakeHistory);
    assert.equal(result, null, 'Non-invitation hashes must return null');
    assert.equal(replacedUrl, null, 'replaceState must NOT be invoked on regular navigation hashes');
  });

  it('handles replaceState failure gracefully without crashing and reports urlCleared: false', () => {
    const fakeLocation = {
      hash: '#join?room=PORT-7K2M9X&token=0123456789abcdef0123456789abcdef',
      pathname: '/pairport/',
      search: '',
    };
    const fakeHistory = {
      replaceState: () => {
        throw new Error('SecurityError: Sandbox origin restriction');
      },
    };

    let result;
    assert.doesNotThrow(() => {
      result = parseAndClearLocationInvitation(fakeLocation, fakeHistory);
    });
    assert.ok(result);
    assert.equal(result.isValid, true);
    assert.equal(result.roomCode, 'PORT-7K2M9X');
    assert.equal(result.urlCleared, false, 'Must accurately reflect residual limitation when replaceState fails');
  });

  it('returns null and does not invoke replaceState if hash is empty', () => {
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

  it('clears invitationToken, invitationRoomCode, and _pendingJoin on leaveRoom', () => {
    client.invitationToken = 'active-secret-token';
    client.invitationRoomCode = 'PORT-7K2M9X';
    client._pendingJoin = { roomCode: 'PORT-7K2M9X', token: 'active-secret-token', generation: 1 };
    client.leaveRoom();
    assert.equal(client.invitationToken, null);
    assert.equal(client.invitationRoomCode, null);
    assert.equal(client._pendingJoin, null);
  });

  it('binds room code to invitationRoomCode on roomCreated and joinRoom', () => {
    client._handleMessage(JSON.stringify({
      type: 'room-created',
      payload: {
        room_code: 'PORT-8M3K2W',
        role: 'host',
        invitation_token: 'auth-token-c0ffee-1234567890',
      },
    }));
    assert.equal(client.invitationToken, 'auth-token-c0ffee-1234567890');
    assert.equal(client.invitationRoomCode, 'PORT-8M3K2W');

    client.leaveRoom();
    assert.equal(client.invitationToken, null);
    assert.equal(client.invitationRoomCode, null);

    client.joinRoom('PORT-112233', 'valid-token-abcdef123456');
    assert.equal(client.invitationToken, 'valid-token-abcdef123456');
    assert.equal(client.invitationRoomCode, 'PORT-112233');
    assert.ok(client._pendingJoin);
    assert.equal(client._pendingJoin.roomCode, 'PORT-112233');
    assert.equal(client._pendingJoin.token, 'valid-token-abcdef123456');
  });
});

describe('6. State & Token Lifecycle Security', () => {
  it('initializes invitationToken and invitationRoomCode to null and clears them on resetSessionState', () => {
    const s = createInitialState();
    assert.equal(s.invitationToken, null);
    assert.equal(s.invitationRoomCode, null);

    s.invitationToken = 'memory-only-secret-token';
    s.invitationRoomCode = 'PORT-7K2M9X';
    resetSessionState(s);
    assert.equal(s.invitationToken, null);
    assert.equal(s.invitationRoomCode, null);
  });

  it('verifies invitation tokens are not persisted to storage', () => {
    if (typeof localStorage !== 'undefined') {
      assert.equal(localStorage.getItem('invitation_token'), null);
      assert.equal(localStorage.getItem('token'), null);
      assert.equal(localStorage.getItem('invitationRoomCode'), null);
    }
    if (typeof sessionStorage !== 'undefined') {
      assert.equal(sessionStorage.getItem('invitation_token'), null);
      assert.equal(sessionStorage.getItem('token'), null);
      assert.equal(sessionStorage.getItem('invitationRoomCode'), null);
    }
  });
});

describe('7. Connection Controller Join Error Cleanup & Race Guards', () => {
  function createFakeRoot() {
    const el = {
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
      textContent: '',
      addEventListener: () => {},
      dataset: {},
      querySelector: () => el,
      querySelectorAll: () => [],
    };
    return el;
  }

  it('clears attempted token and room binding on invitation error and returns to idle state', () => {
    const testClient = new SignalingClient('ws://127.0.0.1:8000/ws');
    const fakeRoot = createFakeRoot();
    initConnectionController(fakeRoot, { signaling: testClient, toast: () => {} });

    // Simulate join attempt
    testClient.joinRoom('PORT-7K2M9X', 'failed-token-12345678');
    state.invitationToken = 'failed-token-12345678';
    state.invitationRoomCode = 'PORT-7K2M9X';

    // Simulate server returning INVITATION_EXPIRED
    testClient._handleMessage(JSON.stringify({
      type: 'error',
      payload: {
        code: 'INVITATION_EXPIRED',
        message: 'This invitation has expired.',
      },
    }));

    assert.equal(state.invitationToken, null, 'State invitation token must be cleared on expiration error');
    assert.equal(state.invitationRoomCode, null, 'State invitation room must be cleared on expiration error');
    assert.equal(testClient.invitationToken, null, 'Signaling invitation token must be cleared');
    assert.equal(testClient.invitationRoomCode, null, 'Signaling invitation room must be cleared');
    assert.equal(state.signalingState, SIGNALING_STATES.IDLE, 'UI must return to IDLE state so user can retry');
    assert.equal(testClient._pendingJoin, null);
  });

  it('does NOT clear a newly captured token if a delayed error arrives from an older attempt', () => {
    const testClient = new SignalingClient('ws://127.0.0.1:8000/ws');
    const fakeRoot = createFakeRoot();
    initConnectionController(fakeRoot, { signaling: testClient, toast: () => {} });

    // Attempt 1: user attempted Room A with Token A
    testClient.joinRoom('PORT-AAAAAA', 'token-attempt-1-11111');
    state.invitationToken = 'token-attempt-1-11111';
    state.invitationRoomCode = 'PORT-AAAAAA';

    // While attempt 1 is in-flight, user receives/pastes a brand new invitation for Room B
    const newerToken = 'token-attempt-2-22222';
    const newerRoom = 'PORT-BBBBBB';
    state.invitationToken = newerToken;
    state.invitationRoomCode = newerRoom;
    testClient.invitationToken = newerToken;
    testClient.invitationRoomCode = newerRoom;

    // Delayed error arrives for attempt 1
    testClient._handleMessage(JSON.stringify({
      type: 'error',
      payload: {
        code: 'INVALID_INVITATION',
        message: 'Invalid invitation token for room.',
      },
    }));

    // The newer token must NOT be erased by the delayed error from attempt 1
    assert.equal(state.invitationToken, newerToken, 'Newer token must be preserved');
    assert.equal(state.invitationRoomCode, newerRoom, 'Newer room binding must be preserved');
    assert.equal(testClient.invitationToken, newerToken, 'Signaling client newer token must be preserved');
    assert.equal(testClient.invitationRoomCode, newerRoom, 'Signaling client newer room must be preserved');
  });

  it('resets state and signaling completely on handleLeave', () => {
    const testClient = new SignalingClient('ws://127.0.0.1:8000/ws');
    const fakeRoot = createFakeRoot();
    const controller = initConnectionController(fakeRoot, { signaling: testClient, toast: () => {} });

    state.invitationToken = 'active-token-12345';
    state.invitationRoomCode = 'PORT-123456';
    testClient.invitationToken = 'active-token-12345';
    testClient.invitationRoomCode = 'PORT-123456';

    controller.handleLeave();

    assert.equal(state.invitationToken, null);
    assert.equal(state.invitationRoomCode, null);
    assert.equal(testClient.invitationToken, null);
    assert.equal(testClient.invitationRoomCode, null);
  });
});
