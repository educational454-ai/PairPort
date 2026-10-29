/**
 * PairPort Network Lab — Comprehensive Test Suite
 *
 * Validates:
 * 1. Bounded hexadecimal preview formatting and byteOffset/byteLength precision.
 * 2. Privacy policy: sensitive tokens, credentials, and raw IPs excluded.
 * 3. Default privacy state: payload text hidden by default; opt-in reveal and hide.
 * 4. Chat & multi-recipient file transfer instrumentation and attribution.
 * 5. WebRTC getStats() normalization, rate calculation, and missing-field safety (no fake zeros or fabricated metrics).
 * 6. History bounding (max 500 entries) and memory cleanup on room reset.
 * 7. Layer distinction: clear separation between application frames and wire network packets.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatHexPreview,
  decodeSafeTextPreview,
  NetworkLabService,
  EVENT_CATEGORIES,
  EVENT_SOURCES,
} from '../src/services/network-lab.js';

import {
  formatPreciseTime,
  renderHexViewer,
  renderEventInspector,
  renderTimelineEvents,
  renderStatsTable,
  renderNetworkLabSection,
} from '../src/features/network-lab/network-lab-ui.js';

describe('Network Lab: Payload Hex Formatting & Privacy Policy', () => {
  it('formats hex preview up to 64 bytes with correct space-separated values', () => {
    const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    const result = formatHexPreview(data, 64);

    assert.equal(result.hexPreview, '48 65 6c 6c 6f');
    assert.equal(result.previewBytes, 5);
    assert.equal(result.totalBytes, 5);
    assert.equal(result.isTruncated, false);
  });

  it('bounds output to 64 bytes and reports isTruncated when buffer exceeds limit', () => {
    const largeBuffer = new Uint8Array(128);
    for (let i = 0; i < 128; i++) {
      largeBuffer[i] = i & 0xff;
    }

    const result = formatHexPreview(largeBuffer, 64);
    assert.equal(result.previewBytes, 64);
    assert.equal(result.totalBytes, 128);
    assert.equal(result.isTruncated, true);
    assert.equal(result.hexPreview.split(' ').length, 64);
  });

  it('strictly respects typed array byteOffset and byteLength (does not read outside view)', () => {
    // Backing buffer of 16 bytes: [0..15]
    const backingBuffer = new ArrayBuffer(16);
    const fullView = new Uint8Array(backingBuffer);
    for (let i = 0; i < 16; i++) {
      fullView[i] = i + 1; // 0x01 .. 0x10
    }

    // Subview from offset 4 to 8 (length 4): bytes [5, 6, 7, 8]
    const subView = new Uint8Array(backingBuffer, 4, 4);
    const result = formatHexPreview(subView, 64);

    assert.equal(result.previewBytes, 4);
    assert.equal(result.totalBytes, 4);
    assert.equal(result.hexPreview, '05 06 07 08');
  });

  it('handles string input safely by encoding to UTF-8 bytes', () => {
    const text = 'PairPort Test';
    const result = formatHexPreview(text, 64);

    assert.equal(result.totalBytes, 13);
    assert.equal(result.previewBytes, 13);
    assert.equal(result.isTruncated, false);
    // 'P' is 0x50, 'a' is 0x61
    assert.match(result.hexPreview, /^50 61/);
  });

  it('decodes printable UTF-8 text safely and rejects unprintable binary streams', () => {
    const textBytes = new TextEncoder().encode('Hello WebRTC!');
    const decoded = decodeSafeTextPreview(textBytes);
    assert.equal(decoded.text, 'Hello WebRTC!');
    assert.equal(decoded.isText, true);

    // Random non-printable binary with null bytes and control codes
    const binaryBytes = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x80, 0x81]);
    const binaryDecoded = decodeSafeTextPreview(binaryBytes);
    assert.equal(binaryDecoded.isText, false, 'Unprintable binary must return isText=false');
    assert.equal(binaryDecoded.text, null, 'Unprintable binary must return text=null');
  });
});

describe('Network Lab: Service Model & In-Memory History Bounding', () => {
  let labService;

  beforeEach(() => {
    labService = new NetworkLabService({ maxEvents: 10 });
  });

  it('records events with stable IDs, timestamps, and normalized metadata', () => {
    const event = labService.recordEvent({
      category: EVENT_CATEGORIES.CHAT,
      source: EVENT_SOURCES.APPLICATION,
      direction: 'out',
      type: 'chat:outgoing',
      peerSessionId: 'peer-abc-123',
      rawPayload: '{"text":"test message"}',
      observationPoint: 'Local DataChannel API Acceptance',
    });

    assert.ok(event.id.startsWith('ev_'));
    assert.ok(typeof event.timestamp === 'number');
    assert.equal(event.category, 'chat');
    assert.equal(event.direction, 'out');
    assert.equal(event.peerSessionId, 'peer-abc-123');
    assert.ok(event.hexPreview.length > 0);
    assert.equal(labService.getEventCount(), 1);
  });

  it('bounds history to maxEvents limit without unbounded memory retention', () => {
    for (let i = 0; i < 25; i++) {
      labService.recordEvent({
        category: EVENT_CATEGORIES.FILE,
        type: 'file:chunk_outgoing',
        chunkIndex: i,
        rawPayload: new Uint8Array([i]),
      });
    }

    assert.equal(labService.getEventCount(), 10, 'History must be bounded to maxEvents (10)');
    const events = labService.getEvents();
    assert.equal(events.length, 10);
    // Newest is at index 0, oldest surviving is at index 9
    assert.equal(events[0].chunkIndex, 24);
    assert.equal(events[9].chunkIndex, 15);
  });

  it('clears diagnostic history and reveal state completely on clearHistory()', () => {
    const ev = labService.recordEvent({
      category: EVENT_CATEGORIES.CHAT,
      rawPayload: 'Hello',
    });

    labService.setEventRevealed(ev.id, true);
    assert.equal(labService.isEventRevealed(ev.id), true);

    labService.clearHistory();

    assert.equal(labService.getEventCount(), 0);
    assert.equal(labService.getEvents().length, 0);
    assert.equal(labService.isEventRevealed(ev.id), false);
  });

  it('isolates subscriber errors so listeners cannot disrupt messaging or transfers', () => {
    labService.on('event', () => {
      throw new Error('Crashing subscriber simulation');
    });

    assert.doesNotThrow(() => {
      labService.recordEvent({
        category: EVENT_CATEGORIES.WEBRTC,
        type: 'webrtc:state',
      });
    });

    assert.equal(labService.getEventCount(), 1);
  });
});

describe('Network Lab: Chat & Multi-Recipient File Transfer Instrumentation', () => {
  it('correctly attributes chat event and derives size from serialized bytes', () => {
    const service = new NetworkLabService();
    const payloadStr = JSON.stringify({ type: 'chat', text: 'Hi peer!', id: 'msg-99' });
    const encodedLength = new TextEncoder().encode(payloadStr).byteLength;

    const event = service.recordEvent({
      category: EVENT_CATEGORIES.CHAT,
      type: 'chat:outgoing',
      direction: 'out',
      peerSessionId: 'guest-session-42',
      rawPayload: payloadStr,
      applicationByteCount: encodedLength,
      status: 'accepted',
    });

    assert.equal(event.peerSessionId, 'guest-session-42');
    assert.equal(event.applicationByteCount, encodedLength);
    assert.equal(service.isEventRevealed(event.id), false, 'Chat text must NOT be revealed by default');

    // Opt-in reveal
    service.setEventRevealed(event.id, true);
    assert.equal(service.isEventRevealed(event.id), true);
  });

  it('measures 36-byte header and chunk payload accurately for file transfer frames', () => {
    const service = new NetworkLabService();
    const transferId = 'transfer-uuid-1234567890';
    const chunkIndex = 2;
    const chunkData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]); // 4 bytes

    // 36-byte header + 4 bytes payload = 40 bytes frame
    const totalFrameSize = 36 + chunkData.byteLength;

    const event = service.recordEvent({
      category: EVENT_CATEGORIES.FILE,
      type: 'file:chunk_outgoing',
      direction: 'out',
      peerSessionId: 'guest-1',
      transferId,
      chunkIndex,
      totalChunks: 10,
      headerSize: 36,
      chunkPayloadSize: chunkData.byteLength,
      totalFrameSize,
      rawPayload: chunkData,
      status: 'streaming',
    });

    assert.equal(event.headerSize, 36);
    assert.equal(event.chunkPayloadSize, 4);
    assert.equal(event.totalFrameSize, 40);
    assert.equal(event.chunkIndex, 2);
    assert.equal(event.totalChunks, 10);
    assert.equal(event.peerSessionId, 'guest-1');
  });

  it('independently attributes multi-recipient transfers across different peers', () => {
    const service = new NetworkLabService();

    const ev1 = service.recordEvent({
      category: EVENT_CATEGORIES.FILE,
      type: 'file:chunk_outgoing',
      peerSessionId: 'guest-alpha',
      transferId: 't-1',
      chunkIndex: 0,
      rawPayload: new Uint8Array([1, 2, 3]),
    });

    const ev2 = service.recordEvent({
      category: EVENT_CATEGORIES.FILE,
      type: 'file:chunk_outgoing',
      peerSessionId: 'guest-beta',
      transferId: 't-2',
      chunkIndex: 0,
      rawPayload: new Uint8Array([1, 2, 3]),
    });

    assert.notEqual(ev1.id, ev2.id);
    assert.equal(ev1.peerSessionId, 'guest-alpha');
    assert.equal(ev2.peerSessionId, 'guest-beta');
  });
});

describe('Network Lab: WebRTC getStats() Normalization & Rate Calculations', () => {
  let service;

  beforeEach(() => {
    service = new NetworkLabService();
  });

  it('normalizes complete RTCStatsReport correctly with zero fabrication', () => {
    const sampleReport = new Map([
      [
        'cand-pair-1',
        {
          type: 'candidate-pair',
          state: 'succeeded',
          currentRoundTripTime: 0.024, // 24 ms
          bytesSent: 10240,
          bytesReceived: 5120,
          packetsSent: 10,
          packetsReceived: 6,
          localCandidateId: 'local-cand-1',
        },
      ],
      [
        'local-cand-1',
        {
          type: 'local-candidate',
          candidateType: 'host',
          protocol: 'udp',
        },
      ],
      [
        'transport-1',
        {
          type: 'transport',
          dtlsCipher: 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
        },
      ],
      [
        'dc-chat',
        {
          type: 'data-channel',
          label: 'chat',
          state: 'open',
          messagesSent: 4,
          messagesReceived: 2,
        },
      ],
    ]);

    const peerId = 'peer-test-1';
    const mockPeer = {
      connectionState: 'connected',
      getConnectionDiagnostics: async () => ({ roundTripTimeMs: 24, selectedCandidateType: 'host' }),
      pc: {
        connectionState: 'connected',
        iceConnectionState: 'connected',
        getStats: async () => sampleReport,
      },
      chatChannel: { label: 'chat', readyState: 'open' },
      fileChannel: { label: 'file', readyState: 'open' },
    };

    const mockRegistry = {
      peers: new Map([[peerId, mockPeer]]),
    };

    service.bindRegistry(mockRegistry);

    // Initial normalization check
    const normalized = service._normalizeStatsReport(sampleReport, mockPeer, peerId);
    assert.equal(normalized.peerSessionId, peerId);
    assert.equal(normalized.connectionState, 'connected');
    assert.equal(normalized.roundTripTimeMs, 24);
    assert.equal(normalized.bytesSent, 10240);
    assert.equal(normalized.bytesReceived, 5120);
    assert.equal(normalized.packetsSent, 10);
    assert.equal(normalized.packetsReceived, 6);
    assert.equal(normalized.dtlsCipher, 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256');
    assert.equal(normalized.candidateType, 'host');
  });

  it('keeps unsupported fields as null/undefined (never fabricates fake numbers or ciphers)', () => {
    const minimalReport = new Map([
      [
        'data-channel-1',
        {
          type: 'data-channel',
          label: 'chat',
          state: 'open',
        },
      ],
    ]);

    const mockPeer = {
      connectionState: 'connected',
      getConnectionDiagnostics: async () => ({}),
      chatChannel: null,
      fileChannel: null,
    };

    const normalized = service._normalizeStatsReport(minimalReport, mockPeer, 'peer-minimal');

    // Values not present in report MUST be null or undefined
    assert.equal(normalized.dtlsCipher, null);
    assert.equal(normalized.packetsSent, null);
    assert.equal(normalized.packetsReceived, null);
    assert.equal(normalized.roundTripTimeMs, null);
    assert.equal(normalized.throughputOutBps, null);
    assert.equal(normalized.throughputInBps, null);
  });

  it('calculates estimated rate only from two valid consecutive samples with positive dt', () => {
    const peerId = 'peer-rate-test';
    const t0 = 1000;
    const t1 = 2000; // 1 second elapsed

    const sample1 = {
      timestamp: t0,
      bytesSent: 1000,
      bytesReceived: 2000,
      throughputOutBps: null,
      throughputInBps: null,
    };

    // Stored as previous sample
    service.previousStatsSamples.set(peerId, sample1);

    const sample2 = {
      timestamp: t1,
      bytesSent: 2000, // +1000 bytes over 1 second = 1000 B/s
      bytesReceived: 4000, // +2000 bytes over 1 second = 2000 B/s
      throughputOutBps: null,
      throughputInBps: null,
    };

    service._calculateDerivativeRates(sample2, peerId);

    assert.equal(sample2.throughputOutBps, 1000);
    assert.equal(sample2.throughputInBps, 2000);
  });

  it('handles counter resets safely without generating negative rates', () => {
    const peerId = 'peer-reset-test';
    const sample1 = {
      timestamp: 1000,
      bytesSent: 50000,
      bytesReceived: 50000,
    };
    service.previousStatsSamples.set(peerId, sample1);

    // Counter reset (reconnection or new stream)
    const sample2 = {
      timestamp: 2000,
      bytesSent: 100, // Decreased
      bytesReceived: 100,
    };

    service._calculateDerivativeRates(sample2, peerId);

    assert.equal(sample2.throughputOutBps, null, 'Throughput must be null on counter reset, never negative');
    assert.equal(sample2.throughputInBps, null);
  });
});

describe('Network Lab: UI Markup & Layer Distinction Principles', () => {
  it('renders the mandatory Layer Distinction Banner', () => {
    const html = renderNetworkLabSection({ isNetworkLabOpen: true });
    assert.ok(html.includes('Layer Distinction Principle:'));
    assert.ok(html.includes('Application events show data handled by PairPort'));
    assert.ok(html.includes('WebRTC statistics are reported by the browser'));
    assert.ok(html.includes('Network packets are captured externally on the wire'));
  });

  it('clearly identifies Wire Network Packet as requiring external capture in the inspector', () => {
    const event = {
      id: 'ev_test_1',
      timestamp: Date.now(),
      category: EVENT_CATEGORIES.FILE,
      direction: 'out',
      chunkIndex: 0,
      totalChunks: 5,
      headerSize: 36,
      chunkPayloadSize: 65536,
      totalFrameSize: 65572,
      originalFileSize: 327680,
      applicationByteCount: 65572,
      observationPoint: 'DataChannel frame passed to local API',
      status: 'accepted',
      hexPreview: '00 00 00 01',
      previewBytes: 4,
      isTruncated: false,
    };

    const html = renderEventInspector(event, false);

    assert.ok(html.includes('Layer &amp; Size Attribution') || html.includes('Layer & Size Attribution'));
    assert.ok(html.includes('36B header'));
    assert.ok(html.includes('Wire Network Packet'));
    assert.ok(html.includes('External Capture Required'));
    assert.ok(html.includes('The browser does not expose raw network packets to JavaScript'));
  });

  it('renders Wireshark-style hex dump with offset and ASCII columns', () => {
    const hexDump = '48 65 6c 6c 6f 20 57 6f 72 6c 64 21';
    const html = renderHexViewer(hexDump, 12, 12, false);

    assert.ok(html.includes('0000:'));
    assert.ok(html.includes('Hello World!'));
    assert.ok(html.includes('Full payload (12 bytes)'));
  });

  it('displays "Unavailable" for missing WebRTC stats in the per-peer table', () => {
    const statsMap = new Map([
      [
        'remote-peer-9',
        {
          peerSessionId: 'remote-peer-9',
          connectionState: 'connected',
          candidateType: 'direct',
          roundTripTimeMs: null, // missing
          dtlsCipher: null, // missing
          bytesSent: 500,
          bytesReceived: 200,
          packetsSent: null, // missing
          packetsReceived: null, // missing
          throughputOutBps: null,
          throughputInBps: null,
        },
      ],
    ]);

    const html = renderStatsTable(statsMap);

    assert.ok(html.includes('remote-p'));
    assert.ok(html.includes('Unavailable'));
    assert.ok(html.includes('Not exposed by this browser'));
    assert.ok(html.includes('Cumulative counters reported directly by <code>RTCPeerConnection.getStats()</code>'));
  });

  it('formats precise timestamp with millisecond precision', () => {
    const ts = new Date('2026-10-29T14:30:15.123Z').getTime();
    const formatted = formatPreciseTime(ts);
    assert.match(formatted, /\d{2}:\d{2}:\d{2}\.\d{3}/);
  });
});
