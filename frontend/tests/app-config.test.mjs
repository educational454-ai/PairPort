/**
 * PairPort Stage 4.1 — Unit Tests for Backend URL Resolution & Configuration
 * Covers:
 *  - Explicit VITE_API_BASE_URL and VITE_WS_BASE_URL precedence
 *  - Derivation when only one explicit URL is specified (http <-> ws)
 *  - Local development defaults (Node.js/SSR and browser on dev ports 5173/4173/3000)
 *  - HTTPS same-origin production fallback (standard port 443 and custom reverse proxy ports)
 *  - HTTP same-origin production fallback (standard port 80 and custom reverse proxy ports)
 *  - Correct ws: and wss: protocol selection
 *  - Trailing slash stripping
 *  - Aligned APP_CONFIG version and phase metadata
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveBackendUrls,
  APP_CONFIG,
} from '../src/config/app-config.js';

describe('1. Explicit Backend URLs & Precedence', () => {
  it('respects explicitly configured API and WebSocket URLs directly', () => {
    const env = {
      VITE_API_BASE_URL: 'https://api.pairport.com',
      VITE_WS_BASE_URL: 'wss://api.pairport.com',
    };
    const result = resolveBackendUrls(env, 'https://client.pairport.com');
    assert.equal(result.apiBaseUrl, 'https://api.pairport.com');
    assert.equal(result.wsBaseUrl, 'wss://api.pairport.com');
    assert.equal(result.wsEndpoint, 'wss://api.pairport.com/ws');
  });

  it('preserves explicitly configured URLs with custom ports', () => {
    const env = {
      VITE_API_BASE_URL: 'http://custom-server:9090',
      VITE_WS_BASE_URL: 'ws://custom-server:9090',
    };
    const result = resolveBackendUrls(env, 'http://localhost:5173');
    assert.equal(result.apiBaseUrl, 'http://custom-server:9090');
    assert.equal(result.wsBaseUrl, 'ws://custom-server:9090');
    assert.equal(result.wsEndpoint, 'ws://custom-server:9090/ws');
  });

  it('strips trailing slashes from explicit URLs to avoid malformed endpoint paths', () => {
    const env = {
      VITE_API_BASE_URL: 'https://api.pairport.com///',
      VITE_WS_BASE_URL: 'wss://api.pairport.com///',
    };
    const result = resolveBackendUrls(env);
    assert.equal(result.apiBaseUrl, 'https://api.pairport.com');
    assert.equal(result.wsBaseUrl, 'wss://api.pairport.com');
    assert.equal(result.wsEndpoint, 'wss://api.pairport.com/ws');
  });

  it('derives WS URL when only VITE_API_BASE_URL is explicitly configured (https -> wss)', () => {
    const env = {
      VITE_API_BASE_URL: 'https://backend.example.com',
    };
    const result = resolveBackendUrls(env);
    assert.equal(result.apiBaseUrl, 'https://backend.example.com');
    assert.equal(result.wsBaseUrl, 'wss://backend.example.com');
    assert.equal(result.wsEndpoint, 'wss://backend.example.com/ws');
  });

  it('derives WS URL with custom port when only VITE_API_BASE_URL is configured (http -> ws)', () => {
    const env = {
      VITE_API_BASE_URL: 'http://backend.example.com:8000',
    };
    const result = resolveBackendUrls(env);
    assert.equal(result.apiBaseUrl, 'http://backend.example.com:8000');
    assert.equal(result.wsBaseUrl, 'ws://backend.example.com:8000');
    assert.equal(result.wsEndpoint, 'ws://backend.example.com:8000/ws');
  });

  it('derives API URL when only VITE_WS_BASE_URL is explicitly configured (wss -> https)', () => {
    const env = {
      VITE_WS_BASE_URL: 'wss://backend.example.com',
    };
    const result = resolveBackendUrls(env);
    assert.equal(result.apiBaseUrl, 'https://backend.example.com');
    assert.equal(result.wsBaseUrl, 'wss://backend.example.com');
    assert.equal(result.wsEndpoint, 'wss://backend.example.com/ws');
  });

  it('derives API URL when only VITE_WS_BASE_URL is configured (ws -> http)', () => {
    const env = {
      VITE_WS_BASE_URL: 'ws://backend.example.com:8000',
    };
    const result = resolveBackendUrls(env);
    assert.equal(result.apiBaseUrl, 'http://backend.example.com:8000');
    assert.equal(result.wsBaseUrl, 'ws://backend.example.com:8000');
    assert.equal(result.wsEndpoint, 'ws://backend.example.com:8000/ws');
  });
});

describe('2. Local Development Defaults', () => {
  it('falls back to 127.0.0.1:8000 when location is not available (Node.js / SSR / tests)', () => {
    const result = resolveBackendUrls({}, null);
    assert.equal(result.apiBaseUrl, 'http://127.0.0.1:8000');
    assert.equal(result.wsBaseUrl, 'ws://127.0.0.1:8000');
    assert.equal(result.wsEndpoint, 'ws://127.0.0.1:8000/ws');
  });

  it('connects to localhost:8000 when running on Vite dev server (http://localhost:5173)', () => {
    const loc = {
      protocol: 'http:',
      hostname: 'localhost',
      port: '5173',
      host: 'localhost:5173',
    };
    const result = resolveBackendUrls({}, loc);
    assert.equal(result.apiBaseUrl, 'http://localhost:8000');
    assert.equal(result.wsBaseUrl, 'ws://localhost:8000');
    assert.equal(result.wsEndpoint, 'ws://localhost:8000/ws');
  });

  it('connects to 127.0.0.1:8000 when running on Vite dev server (http://127.0.0.1:5173)', () => {
    const loc = {
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: '5173',
      host: '127.0.0.1:5173',
    };
    const result = resolveBackendUrls({}, loc);
    assert.equal(result.apiBaseUrl, 'http://127.0.0.1:8000');
    assert.equal(result.wsBaseUrl, 'ws://127.0.0.1:8000');
    assert.equal(result.wsEndpoint, 'ws://127.0.0.1:8000/ws');
  });

  it('connects to loopback:8000 when running on Vite preview server (port 4173)', () => {
    const loc = {
      protocol: 'http:',
      hostname: 'localhost',
      port: '4173',
      host: 'localhost:4173',
    };
    const result = resolveBackendUrls({}, loc);
    assert.equal(result.apiBaseUrl, 'http://localhost:8000');
    assert.equal(result.wsBaseUrl, 'ws://localhost:8000');
  });

  it('connects to LAN IP on port 8000 when testing mobile device on Vite dev server (192.168.1.15:5173)', () => {
    const loc = {
      protocol: 'http:',
      hostname: '192.168.1.15',
      port: '5173',
      host: '192.168.1.15:5173',
    };
    const result = resolveBackendUrls({}, loc);
    assert.equal(result.apiBaseUrl, 'http://192.168.1.15:8000');
    assert.equal(result.wsBaseUrl, 'ws://192.168.1.15:8000');
    assert.equal(result.wsEndpoint, 'ws://192.168.1.15:8000/ws');
  });
});

describe('3. HTTPS Same-Origin Production Fallback', () => {
  it('does NOT force port 8000 under standard HTTPS same-origin deployment', () => {
    const loc = {
      protocol: 'https:',
      hostname: 'pairport.app',
      port: '',
      host: 'pairport.app',
    };
    const result = resolveBackendUrls({}, loc);
    assert.equal(result.apiBaseUrl, 'https://pairport.app');
    assert.equal(result.wsBaseUrl, 'wss://pairport.app');
    assert.equal(result.wsEndpoint, 'wss://pairport.app/ws');
  });

  it('correctly maps https: to wss: protocol on production domain', () => {
    const result = resolveBackendUrls({}, 'https://share.company.org');
    assert.equal(result.apiBaseUrl, 'https://share.company.org');
    assert.equal(result.wsBaseUrl, 'wss://share.company.org');
    assert.equal(result.wsEndpoint, 'wss://share.company.org/ws');
  });

  it('preserves explicitly configured non-standard HTTPS port on reverse proxy (e.g. 8443)', () => {
    const loc = {
      protocol: 'https:',
      hostname: 'pairport.app',
      port: '8443',
      host: 'pairport.app:8443',
    };
    const result = resolveBackendUrls({}, loc);
    assert.equal(result.apiBaseUrl, 'https://pairport.app:8443');
    assert.equal(result.wsBaseUrl, 'wss://pairport.app:8443');
    assert.equal(result.wsEndpoint, 'wss://pairport.app:8443/ws');
  });

  it('ignores standard 443 port in host formatting under HTTPS', () => {
    const loc = {
      protocol: 'https:',
      hostname: 'pairport.app',
      port: '443',
      host: 'pairport.app:443',
    };
    const result = resolveBackendUrls({}, loc);
    assert.equal(result.apiBaseUrl, 'https://pairport.app');
    assert.equal(result.wsBaseUrl, 'wss://pairport.app');
  });
});

describe('4. HTTP Same-Origin Production Fallback', () => {
  it('does NOT force port 8000 for standard HTTP production reverse proxy on port 80', () => {
    const loc = {
      protocol: 'http:',
      hostname: 'pairport.internal',
      port: '',
      host: 'pairport.internal',
    };
    const result = resolveBackendUrls({}, loc);
    assert.equal(result.apiBaseUrl, 'http://pairport.internal');
    assert.equal(result.wsBaseUrl, 'ws://pairport.internal');
    assert.equal(result.wsEndpoint, 'ws://pairport.internal/ws');
  });

  it('preserves custom HTTP reverse proxy port (e.g. 8080)', () => {
    const loc = {
      protocol: 'http:',
      hostname: 'pairport.internal',
      port: '8080',
      host: 'pairport.internal:8080',
    };
    const result = resolveBackendUrls({}, loc);
    assert.equal(result.apiBaseUrl, 'http://pairport.internal:8080');
    assert.equal(result.wsBaseUrl, 'ws://pairport.internal:8080');
    assert.equal(result.wsEndpoint, 'ws://pairport.internal:8080/ws');
  });

  it('ignores standard 80 port in host formatting under HTTP', () => {
    const loc = {
      protocol: 'http:',
      hostname: 'pairport.internal',
      port: '80',
      host: 'pairport.internal:80',
    };
    const result = resolveBackendUrls({}, loc);
    assert.equal(result.apiBaseUrl, 'http://pairport.internal');
    assert.equal(result.wsBaseUrl, 'ws://pairport.internal');
  });
});

describe('5. APP_CONFIG Metadata & Integration', () => {
  it('exposes aligned release version 0.9.0', () => {
    assert.equal(APP_CONFIG.version, '0.9.0');
  });

  it('exposes aligned phase metadata', () => {
    assert.equal(APP_CONFIG.currentPhase, 'Phase 9 · Security Hardening & Production Readiness');
  });

  it('exposes valid apiBaseUrl, wsBaseUrl, and wsEndpoint on default APP_CONFIG', () => {
    assert.ok(typeof APP_CONFIG.apiBaseUrl === 'string' && APP_CONFIG.apiBaseUrl.length > 0);
    assert.ok(typeof APP_CONFIG.wsBaseUrl === 'string' && APP_CONFIG.wsBaseUrl.length > 0);
    assert.ok(typeof APP_CONFIG.wsEndpoint === 'string' && APP_CONFIG.wsEndpoint.endsWith('/ws'));
  });
});

describe('6. Edge Cases, Path Suffixes & Query Strings', () => {
  it('does NOT duplicate /ws when VITE_WS_BASE_URL explicitly ends with /ws', () => {
    const env = {
      VITE_API_BASE_URL: 'https://pairport-api.onrender.com',
      VITE_WS_BASE_URL: 'wss://pairport-api.onrender.com/ws',
    };
    const result = resolveBackendUrls(env);
    assert.equal(result.apiBaseUrl, 'https://pairport-api.onrender.com');
    assert.equal(result.wsBaseUrl, 'wss://pairport-api.onrender.com');
    assert.equal(result.wsEndpoint, 'wss://pairport-api.onrender.com/ws');
  });

  it('handles trailing slash on explicit WS URL ending in /ws/', () => {
    const env = {
      VITE_WS_BASE_URL: 'wss://pairport-api.onrender.com/ws///',
    };
    const result = resolveBackendUrls(env);
    assert.equal(result.wsBaseUrl, 'wss://pairport-api.onrender.com');
    assert.equal(result.wsEndpoint, 'wss://pairport-api.onrender.com/ws');
  });

  it('preserves query strings on explicit WS URL without duplicating /ws', () => {
    const env = {
      VITE_WS_BASE_URL: 'wss://pairport-api.onrender.com/ws?token=test123',
    };
    const result = resolveBackendUrls(env);
    assert.equal(result.wsBaseUrl, 'wss://pairport-api.onrender.com');
    assert.equal(result.wsEndpoint, 'wss://pairport-api.onrender.com/ws?token=test123');
  });

  it('preserves query strings on base WS URL when appending /ws', () => {
    const env = {
      VITE_WS_BASE_URL: 'wss://pairport-api.onrender.com?client=web',
    };
    const result = resolveBackendUrls(env);
    assert.equal(result.wsBaseUrl, 'wss://pairport-api.onrender.com');
    assert.equal(result.wsEndpoint, 'wss://pairport-api.onrender.com/ws?client=web');
  });

  it('derives backend actual /ws route when API URL ends with /api', () => {
    const env = {
      VITE_API_BASE_URL: 'https://pairport-api.onrender.com/api',
    };
    const result = resolveBackendUrls(env);
    assert.equal(result.apiBaseUrl, 'https://pairport-api.onrender.com/api');
    assert.equal(result.wsBaseUrl, 'wss://pairport-api.onrender.com');
    assert.equal(result.wsEndpoint, 'wss://pairport-api.onrender.com/ws');
  });

  it('derives backend actual /ws route when API URL ends with /api/ (trailing slash)', () => {
    const env = {
      VITE_API_BASE_URL: 'https://pairport-api.onrender.com/api///',
    };
    const result = resolveBackendUrls(env);
    assert.equal(result.apiBaseUrl, 'https://pairport-api.onrender.com/api');
    assert.equal(result.wsBaseUrl, 'wss://pairport-api.onrender.com');
    assert.equal(result.wsEndpoint, 'wss://pairport-api.onrender.com/ws');
  });

  it('derives clean API base URL without /ws when only WS URL ending with /ws is provided', () => {
    const env = {
      VITE_WS_BASE_URL: 'wss://pairport-api.onrender.com/ws',
    };
    const result = resolveBackendUrls(env);
    assert.equal(result.apiBaseUrl, 'https://pairport-api.onrender.com');
    assert.equal(result.wsBaseUrl, 'wss://pairport-api.onrender.com');
    assert.equal(result.wsEndpoint, 'wss://pairport-api.onrender.com/ws');
  });
});
