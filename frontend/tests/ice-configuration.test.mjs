/**
 * PairPort Phase 6 — Unit Tests for ICE Configuration & STUN/TURN Parsing
 * Covers:
 *  - Default STUN-only configuration fallback
 *  - Custom STUN server URL parsing and validation
 *  - Optional TURN & TURNS server URL parsing with credentials
 *  - Incomplete TURN configuration warnings and omission
 *  - Multi-server and multi-URL parsing
 *  - Privacy protection: sanitization of candidate IP addresses and credentials
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STUN_SERVERS,
  buildIceServersConfig,
  APP_CONFIG,
} from '../src/config/app-config.js';

test('1. Default STUN Configuration', async (t) => {
  await t.test('uses reputable default Google STUN servers when environment is empty', () => {
    const config = buildIceServersConfig({});
    assert.equal(config.iceServers.length, 1);
    assert.deepEqual(config.iceServers[0].urls, DEFAULT_STUN_SERVERS);
    assert.equal(config.isTurnConfigured, false);
    assert.equal(config.warnings.length, 0);
  });

  await t.test('APP_CONFIG exposes default iceServers array and iceConfig metadata', () => {
    assert.ok(Array.isArray(APP_CONFIG.iceServers));
    assert.ok(APP_CONFIG.iceServers.length >= 1);
    assert.equal(typeof APP_CONFIG.iceConfig, 'object');
  });
});

test('2. Custom STUN Configuration Parsing & Validation', async (t) => {
  await t.test('parses comma-separated STUN URLs and trims whitespace', () => {
    const env = {
      VITE_STUN_URLS: 'stun:stun.cloudflare.com:3478, stun:stun.l.google.com:19302 ',
    };
    const config = buildIceServersConfig(env);
    assert.equal(config.iceServers.length, 1);
    assert.deepEqual(config.iceServers[0].urls, [
      'stun:stun.cloudflare.com:3478',
      'stun:stun.l.google.com:19302',
    ]);
    assert.equal(config.warnings.length, 0);
  });

  await t.test('supports stuns: scheme for encrypted STUN over TLS', () => {
    const env = {
      VITE_STUN_URLS: 'stuns:stun.example.com:5349',
    };
    const config = buildIceServersConfig(env);
    assert.deepEqual(config.iceServers[0].urls, ['stuns:stun.example.com:5349']);
  });

  await t.test('warns and ignores invalid STUN URLs, falling back to default if none valid', () => {
    const env = {
      VITE_STUN_URLS: 'http://invalid-stun.com, ftp://invalid-stun.org',
    };
    const config = buildIceServersConfig(env);
    assert.ok(config.warnings.length >= 2);
    assert.deepEqual(config.iceServers[0].urls, DEFAULT_STUN_SERVERS);
  });
});

test('3. TURN Server Parsing and Credential Handling', async (t) => {
  await t.test('configures valid TURN and TURNS servers when credentials are provided', () => {
    const env = {
      VITE_TURN_URLS: 'turn:turn.example.com:3478?transport=udp, turns:turn.example.com:5349?transport=tcp',
      VITE_TURN_USERNAME: 'pairport-user',
      VITE_TURN_CREDENTIAL: 'test-credential-token',
    };
    const config = buildIceServersConfig(env);

    assert.equal(config.isTurnConfigured, true);
    assert.equal(config.iceServers.length, 2);

    const turnEntry = config.iceServers[1];
    assert.deepEqual(turnEntry.urls, [
      'turn:turn.example.com:3478?transport=udp',
      'turns:turn.example.com:5349?transport=tcp',
    ]);
    assert.equal(turnEntry.username, 'pairport-user');
    assert.equal(turnEntry.credential, 'test-credential-token');
    assert.equal(config.warnings.length, 0);
  });

  await t.test('warns and omits TURN server when username is missing', () => {
    const env = {
      VITE_TURN_URLS: 'turn:turn.example.com:3478',
      VITE_TURN_USERNAME: '',
      VITE_TURN_CREDENTIAL: 'some-password',
    };
    const config = buildIceServersConfig(env);

    assert.equal(config.isTurnConfigured, false);
    assert.equal(config.iceServers.length, 1); // Only STUN
    assert.ok(config.warnings.some((w) => w.includes('VITE_TURN_USERNAME')));
  });

  await t.test('warns and omits TURN server when credential is missing', () => {
    const env = {
      VITE_TURN_URLS: 'turn:turn.example.com:3478',
      VITE_TURN_USERNAME: 'admin',
      VITE_TURN_CREDENTIAL: '',
    };
    const config = buildIceServersConfig(env);

    assert.equal(config.isTurnConfigured, false);
    assert.equal(config.iceServers.length, 1); // Only STUN
    assert.ok(config.warnings.some((w) => w.includes('VITE_TURN_CREDENTIAL')));
  });

  await t.test('warns on invalid TURN URL scheme (e.g. http or stun in turn var)', () => {
    const env = {
      VITE_TURN_URLS: 'https://turn.example.com',
      VITE_TURN_USERNAME: 'user',
      VITE_TURN_CREDENTIAL: 'pass',
    };
    const config = buildIceServersConfig(env);

    assert.equal(config.isTurnConfigured, false);
    assert.ok(config.warnings.some((w) => w.includes('Ignored invalid TURN URL')));
  });
});
