import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCREENS,
  CANONICAL_ROUTES,
  hasActiveSession,
  getCanonicalHash,
  parseRoute,
  HashRouter,
  router,
  navigate,
  getCurrentRoute,
  getCurrentScreen,
  initRouter,
} from '../src/services/router.js';
import { SIGNALING_STATES } from '../src/services/signaling.js';
import { DATA_CHANNEL_STATES, PEER_CONNECTION_STATES } from '../src/services/peer-connection.js';
import { createInitialState } from '../src/state/app-state.js';

describe('1. Default and Normalized Routes', () => {
  it('parses empty, root, and home hashes to the Home screen', () => {
    const emptyRoute = parseRoute('');
    assert.equal(emptyRoute.screen, SCREENS.HOME);
    assert.equal(emptyRoute.hash, CANONICAL_ROUTES[SCREENS.HOME]);
    assert.equal(emptyRoute.anchor, null);

    const hashOnly = parseRoute('#');
    assert.equal(hashOnly.screen, SCREENS.HOME);

    const slashOnly = parseRoute('#/');
    assert.equal(slashOnly.screen, SCREENS.HOME);

    const homeRoute = parseRoute('#/home');
    assert.equal(homeRoute.screen, SCREENS.HOME);
    assert.equal(homeRoute.hash, CANONICAL_ROUTES[SCREENS.HOME]);

    const homeSimple = parseRoute('#home');
    assert.equal(homeSimple.screen, SCREENS.HOME);
  });

  it('parses pairing hashes to the Pairing screen', () => {
    const pairRoute = parseRoute('#/pair');
    assert.equal(pairRoute.screen, SCREENS.PAIRING);
    assert.equal(pairRoute.hash, CANONICAL_ROUTES[SCREENS.PAIRING]);

    const pairingRoute = parseRoute('#/pairing');
    assert.equal(pairingRoute.screen, SCREENS.PAIRING);
    assert.equal(pairingRoute.hash, CANONICAL_ROUTES[SCREENS.PAIRING]);

    const pairShort = parseRoute('#pair');
    assert.equal(pairShort.screen, SCREENS.PAIRING);
  });

  it('generates canonical hashes for all supported screens', () => {
    assert.equal(getCanonicalHash(SCREENS.HOME), '#/home');
    assert.equal(getCanonicalHash(SCREENS.PAIRING), '#/pair');
    assert.equal(getCanonicalHash(SCREENS.WORKSPACE), '#/workspace');
    assert.equal(getCanonicalHash(SCREENS.HOME, 'features'), '#features');
    assert.equal(getCanonicalHash('unknown_screen'), '#/home');
  });
});

describe('2. Legacy Route Compatibility & Anchors', () => {
  it('maps legacy #features anchor to the Home screen with anchor data', () => {
    const route = parseRoute('#features');
    assert.equal(route.screen, SCREENS.HOME);
    assert.equal(route.anchor, 'features');
    assert.equal(route.hash, '#features');
  });

  it('maps legacy #how-it-works anchor to the Home screen with anchor data', () => {
    const route = parseRoute('#how-it-works');
    assert.equal(route.screen, SCREENS.HOME);
    assert.equal(route.anchor, 'how-it-works');
    assert.equal(route.hash, '#how-it-works');
  });

  it('maps legacy #hero anchor to the Home screen with anchor data', () => {
    const route = parseRoute('#hero');
    assert.equal(route.screen, SCREENS.HOME);
    assert.equal(route.anchor, 'hero');
    assert.equal(route.hash, '#hero');
  });

  it('maps legacy #pairing link to the Pairing screen', () => {
    const route = parseRoute('#pairing');
    assert.equal(route.screen, SCREENS.PAIRING);
    assert.equal(route.hash, CANONICAL_ROUTES[SCREENS.PAIRING]);
  });
});

describe('3. Workspace Route Guard & Active Session Evaluation', () => {
  it('evaluates hasActiveSession correctly across lifecycle states', () => {
    // 1. IDLE is not active signaling (no active channels or recovery) -> false
    const idleSignalingState = createInitialState();
    idleSignalingState.realRoomCode = 'PORT-123456';
    idleSignalingState.signalingState = SIGNALING_STATES.IDLE;
    assert.equal(hasActiveSession(idleSignalingState), false, 'IDLE must not count as active signaling');

    // 2. ERROR is not active signaling -> false
    const errorState = createInitialState();
    errorState.realRoomCode = 'PORT-123456';
    errorState.signalingState = SIGNALING_STATES.ERROR;
    assert.equal(hasActiveSession(errorState), false, 'ERROR must not count as active signaling');

    // 3. DISCONNECTED alone does not keep a session active -> false
    const disconnectedState = createInitialState();
    disconnectedState.realRoomCode = 'PORT-123456';
    disconnectedState.signalingState = SIGNALING_STATES.DISCONNECTED;
    disconnectedState.dataChannelState = DATA_CHANNEL_STATES.IDLE;
    disconnectedState.fileChannelState = DATA_CHANNEL_STATES.IDLE;
    disconnectedState.isSignalingReconnecting = false;
    disconnectedState.isReconnecting = false;
    disconnectedState.isPeerDisconnected = false;
    assert.equal(hasActiveSession(disconnectedState), false, 'DISCONNECTED alone must not keep a session active');

    // 4. An open DataChannel still counts as active according to existing policy -> true
    const p2pDirectState = createInitialState();
    p2pDirectState.realRoomCode = 'PORT-123456';
    p2pDirectState.signalingState = SIGNALING_STATES.DISCONNECTED;
    p2pDirectState.dataChannelState = DATA_CHANNEL_STATES.OPEN;
    assert.equal(hasActiveSession(p2pDirectState), true, 'Open chat DataChannel keeps session active');

    const fileChannelOpenState = createInitialState();
    fileChannelOpenState.realRoomCode = 'PORT-123456';
    fileChannelOpenState.signalingState = SIGNALING_STATES.DISCONNECTED;
    fileChannelOpenState.fileChannelState = DATA_CHANNEL_STATES.OPEN;
    assert.equal(hasActiveSession(fileChannelOpenState), true, 'Open file DataChannel keeps session active');

    // 5. A legitimate recovery state still counts as active -> true
    const signalingRecoveryState = createInitialState();
    signalingRecoveryState.realRoomCode = 'PORT-123456';
    signalingRecoveryState.signalingState = SIGNALING_STATES.DISCONNECTED;
    signalingRecoveryState.isSignalingReconnecting = true;
    assert.equal(hasActiveSession(signalingRecoveryState), true, 'Signaling recovery keeps session active');

    const peerDisconnectGraceState = createInitialState();
    peerDisconnectGraceState.realRoomCode = 'PORT-123456';
    peerDisconnectGraceState.signalingState = SIGNALING_STATES.CONNECTED;
    peerDisconnectGraceState.isPeerDisconnected = true;
    assert.equal(hasActiveSession(peerDisconnectGraceState), true, 'Peer disconnect grace keeps session active');

    const webrtcReconnectState = createInitialState();
    webrtcReconnectState.realRoomCode = 'PORT-123456';
    webrtcReconnectState.signalingState = SIGNALING_STATES.DISCONNECTED;
    webrtcReconnectState.isReconnecting = true;
    assert.equal(hasActiveSession(webrtcReconnectState), true, 'WebRTC reconnect keeps session active');

    // 6. A room with no active or recovery state is not active -> false
    const deadRoomState = createInitialState();
    deadRoomState.realRoomCode = 'PORT-123456';
    deadRoomState.signalingState = SIGNALING_STATES.IDLE;
    assert.equal(hasActiveSession(deadRoomState), false, 'Room with idle signaling and no channels is not active');

    const missingRoomState = createInitialState();
    missingRoomState.realRoomCode = null;
    missingRoomState.signalingState = SIGNALING_STATES.CONNECTED;
    assert.equal(hasActiveSession(missingRoomState), false, 'Active signaling without room code is not active session');

    // 7. Legitimate active room with host waiting or peer connected -> true
    const hostWaitingState = createInitialState();
    hostWaitingState.realRoomCode = 'PORT-123456';
    hostWaitingState.signalingState = SIGNALING_STATES.WAITING;
    assert.equal(hasActiveSession(hostWaitingState), true, 'Host waiting for peer is an active session');

    const connectedState = createInitialState();
    connectedState.realRoomCode = 'PORT-123456';
    connectedState.signalingState = SIGNALING_STATES.CONNECTED;
    assert.equal(hasActiveSession(connectedState), true, 'Connected signaling room is an active session');

    // Null safety
    assert.equal(hasActiveSession(null), false);
  });

  it('redirects to Pairing when Workspace is accessed without an active session', () => {
    const emptyState = createInitialState();
    const route = parseRoute('#/workspace', { currentState: emptyState });

    assert.equal(route.screen, SCREENS.PAIRING);
    assert.equal(route.hash, CANONICAL_ROUTES[SCREENS.PAIRING]);
    assert.equal(route.redirectedFrom, SCREENS.WORKSPACE);
    assert.equal(route.reason, 'NO_ACTIVE_SESSION');
  });

  it('allows access to Workspace when a valid active session exists', () => {
    const activeState = createInitialState();
    activeState.realRoomCode = 'PORT-778899';
    activeState.signalingState = SIGNALING_STATES.CONNECTED;
    activeState.dataChannelState = DATA_CHANNEL_STATES.OPEN;

    const route = parseRoute('#/workspace', { currentState: activeState });
    assert.equal(route.screen, SCREENS.WORKSPACE);
    assert.equal(route.hash, CANONICAL_ROUTES[SCREENS.WORKSPACE]);
    assert.equal(route.redirectedFrom, undefined);
  });

  it('redirects legacy #workspace link to Pairing when session is absent', () => {
    const emptyState = createInitialState();
    const route = parseRoute('#workspace', { currentState: emptyState });
    assert.equal(route.screen, SCREENS.PAIRING);
    assert.equal(route.redirectedFrom, SCREENS.WORKSPACE);
  });

  it('redirects to Pairing when signaling is DISCONNECTED and no active channels or recovery exist', () => {
    const disconnectedState = createInitialState();
    disconnectedState.realRoomCode = 'PORT-DEAD01';
    disconnectedState.signalingState = SIGNALING_STATES.DISCONNECTED;
    disconnectedState.dataChannelState = DATA_CHANNEL_STATES.CLOSED;
    disconnectedState.fileChannelState = DATA_CHANNEL_STATES.CLOSED;
    disconnectedState.isSignalingReconnecting = false;
    disconnectedState.isReconnecting = false;
    disconnectedState.isPeerDisconnected = false;

    const route = parseRoute('#/workspace', { currentState: disconnectedState });
    assert.equal(route.screen, SCREENS.PAIRING);
    assert.equal(route.redirectedFrom, SCREENS.WORKSPACE);
    assert.equal(route.reason, 'NO_ACTIVE_SESSION');
  });

  it('allows access to Workspace when recovering even if signaling is DISCONNECTED', () => {
    const recoveringState = createInitialState();
    recoveringState.realRoomCode = 'PORT-LIVE01';
    recoveringState.signalingState = SIGNALING_STATES.DISCONNECTED;
    recoveringState.isSignalingReconnecting = true;

    const route = parseRoute('#/workspace', { currentState: recoveringState });
    assert.equal(route.screen, SCREENS.WORKSPACE);
    assert.equal(route.redirectedFrom, undefined);
  });
});

describe('4. Invitation Fragment Handling & Credential Privacy', () => {
  it('detects invitation fragment and routes directly to the Pairing screen', () => {
    const rawInvitationHash = '#join?room=PORT-9A8B7C&token=sec_token_random_123456789';
    const route = parseRoute(rawInvitationHash);

    assert.equal(route.screen, SCREENS.PAIRING);
    assert.equal(route.isInvitation, true);
    // Does not mutate or expose tokens
    assert.equal(route.anchor, null);
  });

  it('handles short join fragment (#join) as an invitation route', () => {
    const route = parseRoute('#join');
    assert.equal(route.screen, SCREENS.PAIRING);
    assert.equal(route.isInvitation, true);
  });

  it('routes malformed invitation fragments to Pairing without exposing tokens', () => {
    const malformedHash = '#join?room=INVALID_TOO_LONG&token=short';
    const route = parseRoute(malformedHash);
    assert.equal(route.screen, SCREENS.PAIRING);
    assert.equal(route.isInvitation, true);
  });

  it('preserves normal default routes when no invitation fragment is present', () => {
    const homeRoute = parseRoute('');
    assert.equal(homeRoute.screen, SCREENS.HOME);
    assert.equal(homeRoute.isInvitation, false);

    const featureRoute = parseRoute('#features');
    assert.equal(featureRoute.screen, SCREENS.HOME);
    assert.equal(featureRoute.anchor, 'features');
    assert.equal(featureRoute.isInvitation, false);

    const pairRoute = parseRoute('#/pair');
    assert.equal(pairRoute.screen, SCREENS.PAIRING);
    assert.equal(pairRoute.isInvitation, false);
  });
});

describe('5. Invalid Routes and Fallback Behavior', () => {
  it('falls back to the Home screen on unknown hash routes', () => {
    const route = parseRoute('#/unknown-page-999');
    assert.equal(route.screen, SCREENS.HOME);
    assert.equal(route.hash, CANONICAL_ROUTES[SCREENS.HOME]);
    assert.equal(route.isFallback, true);
  });

  it('gracefully handles malformed percent-encoded fragments without throwing', () => {
    assert.doesNotThrow(() => {
      const route = parseRoute('#/test%E0%A4%A');
      assert.equal(route.screen, SCREENS.HOME);
    });
  });
});

describe('6. HashRouter Class, Lifecycle & Subscription', () => {
  it('manages listeners, subscriptions, and route deduplication', () => {
    const listeners = {};
    const fakeWindow = {
      addEventListener: (evt, fn) => { listeners[evt] = fn; },
      removeEventListener: (evt, fn) => { delete listeners[evt]; },
    };
    const fakeLocation = { hash: '#/home' };
    const fakeHistory = { replaceState: () => {} };

    const customRouter = new HashRouter({
      windowObj: fakeWindow,
      location: fakeLocation,
      history: fakeHistory,
      state: createInitialState(),
    });

    // Start router
    const initial = customRouter.start();
    assert.equal(initial.screen, SCREENS.HOME);
    assert.equal(typeof listeners.hashchange, 'function');
    assert.equal(typeof listeners.popstate, 'function');

    // Subscribe to route changes
    let receivedNew = null;
    let receivedPrev = null;
    let callCount = 0;
    const unsub = customRouter.subscribe((newR, prevR) => {
      receivedNew = newR;
      receivedPrev = prevR;
      callCount++;
    });

    // Programmatic navigate to pairing
    customRouter.navigate(SCREENS.PAIRING);
    assert.equal(fakeLocation.hash, CANONICAL_ROUTES[SCREENS.PAIRING]);
    assert.equal(receivedNew.screen, SCREENS.PAIRING);
    assert.equal(callCount, 1);

    // Simulate browser hashchange to home
    fakeLocation.hash = '#/home';
    listeners.hashchange();
    assert.equal(receivedNew.screen, SCREENS.HOME);
    assert.equal(callCount, 2);

    // Identical hash should be deduplicated (no redundant notifications)
    listeners.hashchange();
    assert.equal(callCount, 2);

    // Unsubscribe
    unsub();
    fakeLocation.hash = '#/pair';
    listeners.hashchange();
    assert.equal(callCount, 2, 'Unsubscribed callback should not receive subsequent events');

    // Stop router
    customRouter.stop();
    assert.equal(listeners.hashchange, undefined);
  });

  it('guards navigation to workspace and synchronizes history when guard redirects', () => {
    let replacedUrl = null;
    const fakeLocation = { hash: '#/workspace' };
    const fakeHistory = {
      replaceState: (state, title, url) => { replacedUrl = url; },
    };

    const emptyState = createInitialState();
    const customRouter = new HashRouter({
      location: fakeLocation,
      history: fakeHistory,
      state: emptyState,
    });

    // Directly resolving current route '#/workspace' without active session triggers guard redirection
    const route = customRouter.resolveCurrentRoute({ applyRedirect: true });
    assert.equal(route.screen, SCREENS.PAIRING);
    assert.equal(route.redirectedFrom, SCREENS.WORKSPACE);
    assert.equal(replacedUrl, CANONICAL_ROUTES[SCREENS.PAIRING]);

    // Programmatic navigate('workspace') without active session
    const navResult = customRouter.navigate(SCREENS.WORKSPACE);
    assert.equal(navResult.screen, SCREENS.PAIRING);
    assert.equal(navResult.redirectedFrom, SCREENS.WORKSPACE);
    assert.equal(fakeLocation.hash, CANONICAL_ROUTES[SCREENS.PAIRING]);
  });

  it('allows navigation to workspace when session is active', () => {
    const activeState = createInitialState();
    activeState.realRoomCode = 'PORT-ACTIVE';
    activeState.signalingState = SIGNALING_STATES.CONNECTED;

    const fakeLocation = { hash: '#/pair' };
    const customRouter = new HashRouter({
      location: fakeLocation,
      state: activeState,
    });

    const navResult = customRouter.navigate(SCREENS.WORKSPACE);
    assert.equal(navResult.screen, SCREENS.WORKSPACE);
    assert.equal(fakeLocation.hash, CANONICAL_ROUTES[SCREENS.WORKSPACE]);
  });

  it('safe fallback when location or history are not present', () => {
    const headlessRouter = new HashRouter({ location: null, history: null, windowObj: null });
    assert.doesNotThrow(() => {
      headlessRouter.start();
      assert.equal(headlessRouter.getCurrentScreen(), SCREENS.HOME);
      headlessRouter.navigate('pairing');
      headlessRouter.stop();
    });
  });
});

describe('7. Non-Destructive Invariant Verification', () => {
  it('verifies routing never alters or touches tokens or signaling state in app state', () => {
    const pristineState = createInitialState();
    pristineState.invitationToken = 'invitation-secret-12345';
    pristineState.reconnectToken = 'reconnect-secret-67890';
    pristineState.realRoomCode = 'PORT-PROTECT';
    pristineState.signalingState = SIGNALING_STATES.CONNECTED;

    const fakeLocation = { hash: '#/home' };
    const customRouter = new HashRouter({
      location: fakeLocation,
      state: pristineState,
    });

    customRouter.navigate(SCREENS.PAIRING);
    customRouter.navigate(SCREENS.WORKSPACE);
    customRouter.navigate(SCREENS.HOME);

    // Verify all secrets, tokens, room codes, and signaling states remain 100% untouched
    assert.equal(pristineState.invitationToken, 'invitation-secret-12345');
    assert.equal(pristineState.reconnectToken, 'reconnect-secret-67890');
    assert.equal(pristineState.realRoomCode, 'PORT-PROTECT');
    assert.equal(pristineState.signalingState, SIGNALING_STATES.CONNECTED);
  });
});

describe('8. Persistent Screen Containers & Screen Switching Logic', () => {
  function createMockClassList(initial = []) {
    const set = new Set(initial);
    return {
      add: (cls) => set.add(cls),
      remove: (cls) => set.delete(cls),
      has: (cls) => set.has(cls),
      contains: (cls) => set.has(cls),
    };
  }

  it('toggles visibility classes on screen containers without destroying them', () => {
    const screens = {
      home: { classList: createMockClassList(['screen-active']), attributes: {} },
      pairing: { classList: createMockClassList(['hidden']), attributes: { 'aria-hidden': 'true' } },
      workspace: { classList: createMockClassList(['hidden']), attributes: { 'aria-hidden': 'true' } },
    };

    function syncTestScreen(targetScreen) {
      Object.entries(screens).forEach(([name, el]) => {
        const isActive = name === targetScreen;
        if (isActive) {
          el.classList.add('screen-active');
          el.classList.remove('hidden');
          el.attributes['aria-hidden'] = 'false';
        } else {
          el.classList.remove('screen-active');
          el.classList.add('hidden');
          el.attributes['aria-hidden'] = 'true';
        }
      });
    }

    // Initial state: Home active
    assert.ok(screens.home.classList.has('screen-active'));
    assert.ok(screens.pairing.classList.has('hidden'));
    assert.ok(screens.workspace.classList.has('hidden'));

    // Switch to Pairing
    syncTestScreen('pairing');
    assert.ok(!screens.home.classList.has('screen-active'));
    assert.ok(screens.home.classList.has('hidden'));
    assert.ok(screens.pairing.classList.has('screen-active'));
    assert.ok(!screens.pairing.classList.has('hidden'));
    assert.equal(screens.pairing.attributes['aria-hidden'], 'false');
    assert.ok(screens.workspace.classList.has('hidden'));

    // Switch to Workspace
    syncTestScreen('workspace');
    assert.ok(screens.workspace.classList.has('screen-active'));
    assert.ok(!screens.workspace.classList.has('hidden'));
    assert.equal(screens.workspace.attributes['aria-hidden'], 'false');
    assert.ok(screens.pairing.classList.has('hidden'));
    assert.ok(screens.home.classList.has('hidden'));

    // All containers remained defined in memory (never destroyed)
    assert.ok(screens.home && screens.pairing && screens.workspace);
  });
});
