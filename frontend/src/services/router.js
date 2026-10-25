/**
 * PairPort Client-Side Hash Router Foundation
 * Stage 1: Safe Hash Router Service
 *
 * Provides normalized route resolution, legacy anchor compatibility,
 * browser history synchronization (hashchange / popstate), and session-state
 * route guards without modifying active WebRTC connections or ephemeral credentials.
 *
 * Source of truth: The URL hash is the primary source of truth.
 */

import { state as appState } from '../state/app-state.js';
import { SIGNALING_STATES } from './signaling.js';
import { DATA_CHANNEL_STATES } from './peer-connection.js';
import { isInvitationFragment } from '../utils/invitation.js';

/**
 * Supported screen identifiers.
 */
export const SCREENS = Object.freeze({
  HOME: 'home',
  PAIRING: 'pairing',
  WORKSPACE: 'workspace',
});

/**
 * Canonical URL hash representations for each screen.
 */
export const CANONICAL_ROUTES = Object.freeze({
  [SCREENS.HOME]: '#/home',
  [SCREENS.PAIRING]: '#/pair',
  [SCREENS.WORKSPACE]: '#/workspace',
});

/**
 * Route aliases and legacy anchor mappings.
 */
const ROUTE_ALIASES = Object.freeze({
  '': SCREENS.HOME,
  '/': SCREENS.HOME,
  'home': SCREENS.HOME,
  '/home': SCREENS.HOME,
  'hero': SCREENS.HOME,
  '/hero': SCREENS.HOME,
  'features': SCREENS.HOME,
  '/features': SCREENS.HOME,
  'how-it-works': SCREENS.HOME,
  '/how-it-works': SCREENS.HOME,
  'pair': SCREENS.PAIRING,
  '/pair': SCREENS.PAIRING,
  'pairing': SCREENS.PAIRING,
  '/pairing': SCREENS.PAIRING,
  'workspace': SCREENS.WORKSPACE,
  '/workspace': SCREENS.WORKSPACE,
});

/**
 * Check whether a valid, active in-memory session currently exists.
 * Used by the workspace route guard to protect against orphaned or un-paired entry.
 *
 * @param {object} [currentState=appState] - Application state container
 * @returns {boolean} True if a room code and active signaling or DataChannels exist
 */
export function hasActiveSession(currentState = appState) {
  if (!currentState) return false;
  const hasRoom = Boolean(currentState.realRoomCode);
  const isSignalingActive =
    currentState.signalingState !== SIGNALING_STATES.IDLE &&
    currentState.signalingState !== SIGNALING_STATES.ERROR &&
    currentState.signalingState !== SIGNALING_STATES.DISCONNECTED;
  const isDataChannelActive =
    currentState.dataChannelState === DATA_CHANNEL_STATES.OPEN ||
    currentState.fileChannelState === DATA_CHANNEL_STATES.OPEN;
  const isRecovering = Boolean(
    currentState.isSignalingReconnecting ||
    currentState.isReconnecting ||
    currentState.isPeerDisconnected
  );

  return hasRoom && (isSignalingActive || isDataChannelActive || isRecovering);
}

/**
 * Resolve the canonical hash for a given screen and optional anchor.
 *
 * @param {string} screen - One of SCREENS ('home', 'pairing', 'workspace')
 * @param {string|null} [anchor=null] - Optional section anchor for the home screen
 * @returns {string} Normalized hash string
 */
export function getCanonicalHash(screen, anchor = null) {
  if (screen === SCREENS.HOME && anchor) {
    return `#${anchor}`;
  }
  return CANONICAL_ROUTES[screen] || CANONICAL_ROUTES[SCREENS.HOME];
}

/**
 * Parse an arbitrary raw URL hash into a normalized route descriptor.
 * Evaluates the route guard for protected screens (Workspace).
 *
 * @param {string|null} rawHash - The raw URL hash (e.g. window.location.hash)
 * @param {object} [options]
 * @param {object} [options.currentState=appState] - Application state container
 * @returns {{
 *   screen: string,
 *   hash: string,
 *   anchor: string | null,
 *   isInvitation: boolean,
 *   isFallback: boolean,
 *   redirectedFrom?: string,
 *   reason?: string
 * }}
 */
export function parseRoute(rawHash, { currentState = appState } = {}) {
  // 1. Check for invitation link fragments (#join?room=...&token=...)
  // Never log or expose raw tokens; route directly to the pairing screen
  if (isInvitationFragment(rawHash)) {
    return {
      screen: SCREENS.PAIRING,
      hash: rawHash,
      anchor: null,
      isInvitation: true,
      isFallback: false,
    };
  }

  // 2. Normalize raw hash
  let clean = '';
  try {
    clean = typeof rawHash === 'string' ? decodeURI(rawHash.trim()) : '';
  } catch {
    // Malformed URI encoding fallback
    clean = typeof rawHash === 'string' ? rawHash.trim() : '';
  }

  if (clean.startsWith('#')) {
    clean = clean.slice(1);
  }

  // Strip query parameters for standard routing (invitations already handled above)
  const queryIndex = clean.indexOf('?');
  const pathPart = queryIndex !== -1 ? clean.slice(0, queryIndex) : clean;
  const normalizedPath = pathPart.toLowerCase().trim();

  // 3. Extract sub-anchor if present (e.g. #/home#features or #features)
  let anchor = null;
  if (normalizedPath === 'features' || normalizedPath === '/features') {
    anchor = 'features';
  } else if (normalizedPath === 'how-it-works' || normalizedPath === '/how-it-works') {
    anchor = 'how-it-works';
  } else if (normalizedPath === 'hero' || normalizedPath === '/hero') {
    anchor = 'hero';
  } else if (clean.includes('#')) {
    anchor = clean.split('#')[1] || null;
  }

  // 4. Match against known route aliases
  let matchedScreen = ROUTE_ALIASES[normalizedPath];
  let isFallback = false;

  if (!matchedScreen) {
    // Unrecognized or invalid route -> default to Home screen
    matchedScreen = SCREENS.HOME;
    isFallback = true;
  }

  // 5. Evaluate Route Guard for Workspace
  // If user requests Workspace without an active session, redirect to Pairing
  if (matchedScreen === SCREENS.WORKSPACE) {
    if (!hasActiveSession(currentState)) {
      return {
        screen: SCREENS.PAIRING,
        hash: CANONICAL_ROUTES[SCREENS.PAIRING],
        anchor: null,
        isInvitation: false,
        isFallback: false,
        redirectedFrom: SCREENS.WORKSPACE,
        reason: 'NO_ACTIVE_SESSION',
      };
    }
  }

  return {
    screen: matchedScreen,
    hash: anchor ? `#${anchor}` : (CANONICAL_ROUTES[matchedScreen] || CANONICAL_ROUTES[SCREENS.HOME]),
    anchor,
    isInvitation: false,
    isFallback,
  };
}

/**
 * HashRouter Class
 * Manages hashchange and popstate events, route parsing, navigation guards,
 * and subscriber notifications.
 */
export class HashRouter {
  /**
   * @param {object} [options]
   * @param {Location} [options.location] - Location instance (defaults to window.location)
   * @param {History} [options.history] - History instance (defaults to window.history)
   * @param {Window} [options.windowObj] - Window instance (defaults to window)
   * @param {object} [options.state] - State container (defaults to appState)
   */
  constructor({
    location = typeof window !== 'undefined' ? window.location : null,
    history = typeof window !== 'undefined' ? window.history : null,
    windowObj = typeof window !== 'undefined' ? window : null,
    state = appState,
  } = {}) {
    this.location = location;
    this.history = history;
    this.windowObj = windowObj;
    this.state = state;
    this.listeners = new Set();
    this._boundHandler = null;
    this._currentRoute = null;
    this.isStarted = false;
  }

  /**
   * Start listening for hash and history changes.
   * Resolves the initial route immediately.
   *
   * @returns {object} Initial route descriptor
   */
  start() {
    if (this.isStarted) {
      return this.getCurrentRoute();
    }
    this.isStarted = true;

    this._boundHandler = () => this.handleHashChange();

    if (this.windowObj && typeof this.windowObj.addEventListener === 'function') {
      this.windowObj.addEventListener('hashchange', this._boundHandler);
      this.windowObj.addEventListener('popstate', this._boundHandler);
    }

    // Resolve initial route and enforce guard redirection if needed
    const initialRoute = this.resolveCurrentRoute({ applyRedirect: true });
    return initialRoute;
  }

  /**
   * Stop listening for hash and history changes.
   */
  stop() {
    if (!this.isStarted) return;
    this.isStarted = false;

    if (this.windowObj && typeof this.windowObj.removeEventListener === 'function' && this._boundHandler) {
      this.windowObj.removeEventListener('hashchange', this._boundHandler);
      this.windowObj.removeEventListener('popstate', this._boundHandler);
    }
    this._boundHandler = null;
  }

  /**
   * Subscribe to route change events.
   *
   * @param {Function} callback - (newRoute, prevRoute) => void
   * @returns {Function} Unsubscribe function
   */
  subscribe(callback) {
    if (typeof callback !== 'function') return () => {};
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Get the current route descriptor.
   * Reads directly from window.location.hash as the source of truth.
   *
   * @returns {object} Route descriptor
   */
  getCurrentRoute() {
    const rawHash = this.location?.hash || '';
    return parseRoute(rawHash, { currentState: this.state });
  }

  /**
   * Get the current active screen identifier ('home', 'pairing', 'workspace').
   *
   * @returns {string} Screen identifier
   */
  getCurrentScreen() {
    return this.getCurrentRoute().screen;
  }

  /**
   * Internal handler called on hashchange or popstate.
   */
  handleHashChange() {
    const prevRoute = this._currentRoute;
    const newRoute = this.resolveCurrentRoute({ applyRedirect: true });

    // Deduplicate identical route dispatches
    if (
      prevRoute &&
      prevRoute.screen === newRoute.screen &&
      prevRoute.hash === newRoute.hash &&
      prevRoute.anchor === newRoute.anchor
    ) {
      return;
    }

    this._currentRoute = newRoute;
    this.listeners.forEach((callback) => {
      try {
        callback(newRoute, prevRoute);
      } catch (err) {
        console.error('Router subscriber error:', err);
      }
    });
  }

  /**
   * Resolve current route from location, applying address-bar synchronization
   * if a guard redirected the route.
   *
   * @param {object} [options]
   * @param {boolean} [options.applyRedirect=false]
   * @returns {object} Route descriptor
   */
  resolveCurrentRoute({ applyRedirect = false } = {}) {
    const rawHash = this.location?.hash || '';
    const parsed = parseRoute(rawHash, { currentState: this.state });

    // If redirected by guard, synchronize the address bar without creating extra history entries
    if (applyRedirect && parsed.redirectedFrom && this.location) {
      if (this.history && typeof this.history.replaceState === 'function') {
        try {
          this.history.replaceState(null, '', parsed.hash);
        } catch {
          this.location.hash = parsed.hash;
        }
      } else {
        this.location.hash = parsed.hash;
      }
    }

    this._currentRoute = parsed;
    return parsed;
  }

  /**
   * Programmatically navigate to a screen or hash.
   *
   * @param {string} target - Screen identifier ('home', 'pairing', 'workspace') or hash string ('#/pair')
   * @param {object} [options]
   * @param {boolean} [options.replace=false] - Whether to replace current history entry instead of pushing
   * @returns {object} Resulting route descriptor
   */
  navigate(target, { replace = false } = {}) {
    let targetHash = '';

    // Check if target is a known screen name
    if (Object.values(SCREENS).includes(target)) {
      targetHash = CANONICAL_ROUTES[target];
    } else if (typeof target === 'string') {
      targetHash = target.startsWith('#') ? target : `#${target}`;
    } else {
      targetHash = CANONICAL_ROUTES[SCREENS.HOME];
    }

    // Evaluate route guard for target
    const targetRoute = parseRoute(targetHash, { currentState: this.state });
    const finalHash = targetRoute.hash;

    if (this.location) {
      if (replace && this.history && typeof this.history.replaceState === 'function') {
        try {
          this.history.replaceState(null, '', finalHash);
        } catch {
          this.location.hash = finalHash;
        }
      } else {
        this.location.hash = finalHash;
      }
    }

    const prevRoute = this._currentRoute;
    this._currentRoute = targetRoute;

    this.listeners.forEach((callback) => {
      try {
        callback(targetRoute, prevRoute);
      } catch (err) {
        console.error('Router subscriber error:', err);
      }
    });

    return targetRoute;
  }
}

/**
 * Singleton router instance.
 */
export const router = new HashRouter();

/**
 * Convenience helper to initialize and start the router.
 *
 * @param {object} [options]
 * @returns {HashRouter}
 */
export function initRouter(options) {
  if (options) {
    return new HashRouter(options);
  }
  router.start();
  return router;
}

/**
 * Convenience helper to navigate.
 *
 * @param {string} target - Screen identifier or hash
 * @param {object} [options]
 * @returns {object} Resulting route descriptor
 */
export function navigate(target, options) {
  return router.navigate(target, options);
}

/**
 * Convenience helper to get the current route descriptor.
 *
 * @returns {object}
 */
export function getCurrentRoute() {
  return router.getCurrentRoute();
}

/**
 * Convenience helper to get the current screen identifier.
 *
 * @returns {string}
 */
export function getCurrentScreen() {
  return router.getCurrentScreen();
}
