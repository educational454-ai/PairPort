/**
 * Central configuration for PairPort frontend.
 * Defines app metadata, current phase status, API/WebSocket endpoints, and demo datasets.
 */

/**
 * Parse a raw URL string into a clean base path and optional query string.
 * Strips trailing slashes from the base path.
 */
function parseUrlComponents(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return { cleanBase: '', query: '' };
  const trimmed = rawUrl.trim();
  if (!trimmed) return { cleanBase: '', query: '' };

  const qIdx = trimmed.indexOf('?');
  const query = qIdx >= 0 ? trimmed.slice(qIdx) : '';
  const withoutQuery = qIdx >= 0 ? trimmed.slice(0, qIdx) : trimmed;
  const cleanBase = withoutQuery.replace(/\/+$/, '');
  return { cleanBase, query };
}

/**
 * Format a WebSocket endpoint from a clean base URL and optional query string.
 * Prevents duplicating '/ws' if cleanBase already ends with '/ws'.
 */
function buildWsEndpoint(cleanBase, query = '') {
  if (!cleanBase) return '';
  const endpointBase = cleanBase.toLowerCase().endsWith('/ws')
    ? cleanBase
    : `${cleanBase}/ws`;
  return `${endpointBase}${query}`;
}

/**
 * Extract the base WebSocket URL without the trailing '/ws' route.
 */
function extractWsBase(cleanBase) {
  if (!cleanBase) return '';
  return cleanBase.replace(/\/ws$/i, '');
}

/**
 * Resolve API and WebSocket base URLs from environment variables and browser location.
 *
 * Precedence & Rules:
 * 1. Explicitly configured VITE_API_BASE_URL and VITE_WS_BASE_URL take highest precedence.
 * 2. An explicit WebSocket URL ending in '/ws' is preserved as the endpoint without becoming '/ws/ws'.
 * 3. Trailing slashes and query strings are handled safely.
 * 4. If deriving a WebSocket URL from an API base URL ending in '/api', the backend's actual
 *    root '/ws' route is used instead of '/api/ws'.
 * 5. Fallback when neither explicit URL is provided:
 *    - In browser under HTTPS or same-origin production (e.g., standard ports 80/443 or reverse proxies),
 *      standard same-origin paths are used without forcing port 8000.
 *    - In local development (loopback addresses or typical frontend dev server ports like 5173/4173/3000),
 *      default to backend port 8000 as documented.
 *    - When location is absent (e.g. Node.js unit tests or SSR), default to http://127.0.0.1:8000 and ws://127.0.0.1:8000.
 *
 * @param {object} [env=import.meta.env] - Environment variables object
 * @param {Location|object|string|null} [loc=window.location] - Location object or URL string
 * @returns {{ apiBaseUrl: string, wsBaseUrl: string, wsEndpoint: string }}
 */
export function resolveBackendUrls(
  env = (typeof import.meta !== 'undefined' ? import.meta.env : {}),
  loc = (typeof window !== 'undefined' ? window.location : null)
) {
  const { cleanBase: apiBase, query: apiQuery } = parseUrlComponents(env?.VITE_API_BASE_URL);
  const { cleanBase: wsBase, query: wsQuery } = parseUrlComponents(env?.VITE_WS_BASE_URL);

  const explicitApi = apiBase ? `${apiBase}${apiQuery}` : '';

  // 1. Both URLs explicitly configured
  if (explicitApi && wsBase) {
    return {
      apiBaseUrl: explicitApi,
      wsBaseUrl: extractWsBase(wsBase),
      wsEndpoint: buildWsEndpoint(wsBase, wsQuery),
    };
  }

  // 2. Only API URL explicitly configured -> derive WS URL
  if (explicitApi && !wsBase) {
    // If the API URL ends with '/api', use the backend's actual root '/ws' route
    const baseForWs = apiBase.replace(/\/api$/i, '');
    const derivedWsBase = baseForWs
      .replace(/^https:\/\//i, 'wss://')
      .replace(/^http:\/\//i, 'ws://');
    return {
      apiBaseUrl: explicitApi,
      wsBaseUrl: derivedWsBase,
      wsEndpoint: buildWsEndpoint(derivedWsBase),
    };
  }

  // 3. Only WS URL explicitly configured -> derive API URL
  if (!explicitApi && wsBase) {
    const baseForApi = extractWsBase(wsBase);
    const derivedApi = baseForApi
      .replace(/^wss:\/\//i, 'https://')
      .replace(/^ws:\/\//i, 'http://');
    return {
      apiBaseUrl: derivedApi,
      wsBaseUrl: baseForApi,
      wsEndpoint: buildWsEndpoint(wsBase, wsQuery),
    };
  }

  // 4. Fallback resolution when neither URL is explicitly specified
  let locationObj = loc;
  if (typeof loc === 'string') {
    try {
      locationObj = new URL(loc);
    } catch {
      locationObj = null;
    }
  }

  const defaultBackendPort = '8000';

  if (!locationObj) {
    // Node.js test or SSR fallback
    const apiBaseUrl = `http://127.0.0.1:${defaultBackendPort}`;
    const wsBaseUrl = `ws://127.0.0.1:${defaultBackendPort}`;
    return {
      apiBaseUrl,
      wsBaseUrl,
      wsEndpoint: `${wsBaseUrl}/ws`,
    };
  }

  const rawProtocol = (locationObj.protocol || 'http:').toLowerCase();
  const isHttps = rawProtocol === 'https:';
  const httpProto = isHttps ? 'https:' : 'http:';
  const wsProto = isHttps ? 'wss:' : 'ws:';
  const hostname = locationObj.hostname || '127.0.0.1';
  const rawPort = locationObj.port != null ? String(locationObj.port).trim() : '';

  // Classify local development environment:
  // - Localhost / loopback hostnames
  // - Or frontend dev/preview server ports (5173, 4173, 3000)
  // - Only when not running under HTTPS
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '[::1]';
  const isDevServerPort = rawPort === '5173' || rawPort === '4173' || rawPort === '3000';
  const isLocalDevSetup = !isHttps && (isDevServerPort || (isLoopback && env?.MODE === 'development'));

  let hostWithPort = '';
  if (isLocalDevSetup) {
    // Local dev setup: connect to backend on port 8000
    hostWithPort = `${hostname}:${defaultBackendPort}`;
  } else if (rawPort && rawPort !== '80' && rawPort !== '443') {
    // Reverse proxy or custom port setup (e.g. https://domain.com:8443 or http://intranet:8080)
    hostWithPort = `${hostname}:${rawPort}`;
  } else {
    // Standard port (80 or 443) same-origin production deployment
    hostWithPort = hostname;
  }

  const apiBaseUrl = `${httpProto}//${hostWithPort}`;
  const wsBaseUrl = `${wsProto}//${hostWithPort}`;

  return {
    apiBaseUrl,
    wsBaseUrl,
    wsEndpoint: `${wsBaseUrl}/ws`,
  };
}

export const DEFAULT_STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
];

/**
 * Build and validate RTCIceServer configuration from environment variables.
 * Supports:
 * - STUN servers (VITE_STUN_URLS)
 * - Optional TURN/TURNS servers (VITE_TURN_URLS)
 * - Optional TURN credentials (VITE_TURN_USERNAME, VITE_TURN_CREDENTIAL)
 *
 * Emits clear warnings if TURN is incompletely or invalidly configured.
 */
export function buildIceServersConfig(env = import.meta.env || {}) {
  const warnings = [];
  const iceServers = [];

  // 1. Process STUN configuration
  let stunUrls = [];
  if (env.VITE_STUN_URLS && typeof env.VITE_STUN_URLS === 'string') {
    const parsed = env.VITE_STUN_URLS.split(',')
      .map((u) => u.trim())
      .filter(Boolean);

    const validStun = parsed.filter((u) => {
      const isValid = u.startsWith('stun:') || u.startsWith('stuns:');
      if (!isValid) {
        warnings.push(`Ignored invalid STUN URL '${u}'. Must start with 'stun:' or 'stuns:'.`);
      }
      return isValid;
    });

    if (validStun.length > 0) {
      stunUrls = validStun;
    } else {
      warnings.push('VITE_STUN_URLS contained no valid STUN URLs. Falling back to default public STUN.');
      stunUrls = [...DEFAULT_STUN_SERVERS];
    }
  } else {
    stunUrls = [...DEFAULT_STUN_SERVERS];
  }

  iceServers.push({ urls: stunUrls });

  // 2. Process optional TURN configuration
  let isTurnConfigured = false;
  if (env.VITE_TURN_URLS && typeof env.VITE_TURN_URLS === 'string') {
    const rawTurnUrls = env.VITE_TURN_URLS.split(',')
      .map((u) => u.trim())
      .filter(Boolean);

    const validTurnUrls = rawTurnUrls.filter((u) => {
      const isValid = u.startsWith('turn:') || u.startsWith('turns:');
      if (!isValid) {
        warnings.push(`Ignored invalid TURN URL '${u}'. Must start with 'turn:' or 'turns:'.`);
      }
      return isValid;
    });

    const username = env.VITE_TURN_USERNAME ? String(env.VITE_TURN_USERNAME).trim() : '';
    const credential = env.VITE_TURN_CREDENTIAL ? String(env.VITE_TURN_CREDENTIAL).trim() : '';

    if (validTurnUrls.length > 0) {
      if (!username || !credential) {
        warnings.push(
          'TURN URLs provided in VITE_TURN_URLS, but VITE_TURN_USERNAME or VITE_TURN_CREDENTIAL is missing. TURN server entry will be omitted to prevent connection stalls.'
        );
      } else {
        iceServers.push({
          urls: validTurnUrls,
          username,
          credential,
        });
        isTurnConfigured = true;
      }
    }
  }

  // Display useful warnings to developer console
  if (warnings.length > 0) {
    warnings.forEach((w) => console.warn(`[PairPort ICE Config] ${w}`));
  }

  return {
    iceServers,
    warnings,
    isTurnConfigured,
  };
}

const computedIceConfig = buildIceServersConfig();

const defaultUrls = resolveBackendUrls();

export const APP_CONFIG = Object.freeze({
  name: 'PairPort',
  tagline: 'Connect directly. Share freely.',
  description: 'Fast, private peer-to-peer file sharing and ephemeral messaging directly between web browsers. No cloud intermediaries, no file size storage limits.',
  version: '0.9.0',
  currentPhase: 'Phase 9 · Security Hardening & Production Readiness',
  environment: import.meta.env?.MODE || 'development',

  // Network configuration
  apiBaseUrl: defaultUrls.apiBaseUrl,
  wsBaseUrl: defaultUrls.wsBaseUrl,
  wsEndpoint: defaultUrls.wsEndpoint,
  iceServers: computedIceConfig.iceServers,
  iceConfig: computedIceConfig,

  // File Transfer configuration (Phase 5)
  fileTransfer: {
    maxFileSizeBytes: 100 * 1024 * 1024, // 100 MiB maximum file size
    chunkSizeBytes: 16 * 1024,           // 16 KiB chunks
    bufferedAmountLowThreshold: 64 * 1024, // 64 KiB threshold for backpressure resumption
    bufferedAmountHighWatermark: 512 * 1024, // 512 KiB buffer pause threshold
  },

  demoData: {
    roomCode: 'PORT-8492',
    peer: {
      id: 'peer-delta9',
      name: 'Delta-9',
      device: 'MacBook Pro · Chrome 130',
      status: 'Connected (P2P DataChannel)',
      latency: '18 ms',
      transferSpeed: '18.4 MB/s',
    },
    sampleMessages: [
      {
        id: 'msg-1',
        sender: 'peer',
        senderName: 'Delta-9',
        text: 'Hey! Connected directly to your browser. Ready to send over the project archive.',
        timestamp: '11:42 AM',
        isDemo: true,
      },
      {
        id: 'msg-2',
        sender: 'system',
        text: 'File transfer initialized: system-architecture-v2.fig (48.6 MB)',
        timestamp: '11:43 AM',
        isDemo: true,
      },
      {
        id: 'msg-3',
        sender: 'user',
        senderName: 'You',
        text: 'Got it. Direct connection latency is around 18ms — stream is looking fast.',
        timestamp: '11:43 AM',
        isDemo: true,
      },
    ],
    sampleFiles: [
      {
        id: 'file-1',
        name: 'system-architecture-v2.fig',
        size: '48.6 MB',
        bytes: 51000000,
        type: 'figma',
        direction: 'incoming',
        progress: 74,
        speed: '18.4 MB/s',
        eta: '2s remaining',
        status: 'transferring',
        isDemo: true,
      },
      {
        id: 'file-2',
        name: 'pairport-brand-kit-v2.zip',
        size: '124.8 MB',
        bytes: 130800000,
        type: 'zip',
        direction: 'incoming',
        progress: 100,
        status: 'completed',
        isDemo: true,
      },
      {
        id: 'file-3',
        name: 'client-recording-oct2026.mp4',
        size: '412.0 MB',
        bytes: 432000000,
        type: 'video',
        direction: 'outgoing',
        progress: 100,
        status: 'completed',
        isDemo: true,
      },
    ],
  },
});
