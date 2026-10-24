/**
 * Central configuration for PairPort frontend.
 * Defines app metadata, current phase status, API/WebSocket endpoints, and demo datasets.
 */

const getHost = () => {
  if (typeof window !== 'undefined' && window.location.hostname) {
    return window.location.hostname;
  }
  return '127.0.0.1';
};

const isSecure = () => {
  if (typeof window !== 'undefined') {
    return window.location.protocol === 'https:';
  }
  return false;
};

const defaultHttpProto = isSecure() ? 'https:' : 'http:';
const defaultWsProto = isSecure() ? 'wss:' : 'ws:';
const defaultBackendPort = '8000';

const apiBaseUrl = import.meta.env?.VITE_API_BASE_URL || `${defaultHttpProto}//${getHost()}:${defaultBackendPort}`;
const wsBaseUrl = import.meta.env?.VITE_WS_BASE_URL || `${defaultWsProto}//${getHost()}:${defaultBackendPort}`;

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

export const APP_CONFIG = Object.freeze({
  name: 'PairPort',
  tagline: 'Connect directly. Share freely.',
  description: 'Fast, private peer-to-peer file sharing and ephemeral messaging directly between web browsers. No cloud intermediaries, no file size storage limits.',
  version: '0.8.1',
  currentPhase: 'Phase 6 · Reliable WebRTC & TURN Active',
  environment: import.meta.env?.MODE || 'development',

  // Network configuration
  apiBaseUrl,
  wsBaseUrl,
  wsEndpoint: `${wsBaseUrl}/ws`,
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
