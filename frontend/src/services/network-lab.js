/**
 * PairPort Network Lab Service
 *
 * Provides application-level inspection of WebRTC messages, chunked file frames,
 * peer connection lifecycle events, and browser-reported WebRTC statistics.
 *
 * Privacy & Security Invariants:
 * - Default: Bounded hexadecimal preview (max 64 bytes).
 * - Full file contents or full payload buffers are NEVER retained in memory.
 * - Sensitive credentials (tokens, secrets, raw IP addresses) are strictly excluded.
 * - Does not persist inspection data in localStorage or transmit it to the server.
 * - Inspector failures are isolated and never crash the data streaming pipeline.
 */

export const MAX_LAB_EVENTS = 500;
export const MAX_HEX_PREVIEW_BYTES = 64;

export const EVENT_SOURCES = Object.freeze({
  APPLICATION: 'application',
  BROWSER_STATS: 'browser-stats',
  EXTERNAL_CAPTURE: 'external-capture',
});

export const EVENT_CATEGORIES = Object.freeze({
  CHAT: 'chat',
  FILE: 'file',
  FILES: 'file', // Alias for compatibility
  WEBRTC: 'webrtc',
  STATS: 'stats',
});

/**
 * Format a binary buffer or TypedArray into a bounded hex preview.
 * Strictly respects view byteOffset and byteLength.
 *
 * @param {ArrayBuffer|ArrayBufferView|string} source - Source data
 * @param {number} [maxBytes=MAX_HEX_PREVIEW_BYTES] - Maximum bytes to format
 * @returns {{ hex: string, hexPreview: string, previewBytes: number, byteCount: number, totalBytes: number, isTruncated: boolean }}
 */
export function formatHexPreview(source, maxBytes = MAX_HEX_PREVIEW_BYTES) {
  if (source === null || source === undefined) {
    return { hex: '', hexPreview: '', previewBytes: 0, byteCount: 0, totalBytes: 0, isTruncated: false };
  }

  try {
    let bytes;
    if (typeof source === 'string') {
      bytes = new TextEncoder().encode(source);
    } else if (source instanceof ArrayBuffer) {
      bytes = new Uint8Array(source);
    } else if (ArrayBuffer.isView(source)) {
      bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    } else {
      return { hex: '', hexPreview: '', previewBytes: 0, byteCount: 0, totalBytes: 0, isTruncated: false };
    }

    const totalBytes = bytes.byteLength;
    const count = Math.min(totalBytes, maxBytes);
    const hexParts = [];

    for (let i = 0; i < count; i++) {
      const b = bytes[i].toString(16).padStart(2, '0');
      hexParts.push(b);
    }

    const hex = hexParts.join(' ');
    const isTruncated = totalBytes > count;

    return {
      hex,
      hexPreview: hex,
      previewBytes: count,
      byteCount: count,
      totalBytes,
      isTruncated,
    };
  } catch (err) {
    console.warn('[NetworkLab] Error generating hex preview:', err);
    return { hex: '', hexPreview: '', previewBytes: 0, byteCount: 0, totalBytes: 0, isTruncated: false };
  }
}

/**
 * Safely decode a bounded text preview from bytes or string.
 * Rejects unprintable binary streams.
 *
 * @param {ArrayBuffer|ArrayBufferView|string} source
 * @param {number} [maxChars=1000]
 * @returns {{ text: string, isText: boolean, isTruncated: boolean }}
 */
export function decodeSafeTextPreview(source, maxChars = 1000) {
  if (typeof source === 'string') {
    const isTruncated = source.length > maxChars;
    return {
      text: source.slice(0, maxChars),
      isText: true,
      isTruncated,
    };
  }

  try {
    let bytes;
    if (source instanceof ArrayBuffer) {
      bytes = new Uint8Array(source);
    } else if (ArrayBuffer.isView(source)) {
      bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    } else {
      return { text: '(Unsupported payload type)', isText: false, isTruncated: false };
    }

    // Heuristic: check if bytes look like valid UTF-8 text (no unexpected nulls or control codes)
    const sampleSize = Math.min(bytes.byteLength, 128);
    let printableCount = 0;
    for (let i = 0; i < sampleSize; i++) {
      const code = bytes[i];
      if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) {
        printableCount++;
      }
    }

    const isLikelyText = sampleSize === 0 || printableCount / sampleSize > 0.85;
    if (!isLikelyText) {
      return {
        text: null,
        isText: false,
        isTruncated: false,
      };
    }

    const decoder = new TextDecoder('utf-8', { fatal: false });
    const decoded = decoder.decode(bytes.subarray(0, maxChars));
    return {
      text: decoded,
      isText: true,
      isTruncated: bytes.byteLength > maxChars,
    };
  } catch {
    return {
      text: null,
      isText: false,
      isTruncated: false,
    };
  }
}

export class NetworkLabService {
  constructor(options = {}) {
    this.maxEvents = options.maxEvents || MAX_LAB_EVENTS;
    this.events = [];
    this.eventCounter = 0;
    this.listeners = new Map(); // eventName -> Set<Function>

    // Revealed content set for explicit user opt-in (stored by eventId)
    this.revealedEventIds = new Set();

    // Per-peer stats tracking: peerSessionId -> { lastReport, lastTimestamp, history: [] }
    this.peerStatsHistory = new Map();
    this.previousStatsSamples = new Map();

    // Stats polling timer
    this.statsPollIntervalMs = options.statsPollIntervalMs || 1500;
    this.statsTimer = null;
    this.isPolling = false;
    this.peerRegistry = null;
  }

  // ----------------------------------------------------
  // Event Emitter Support
  // ----------------------------------------------------

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.delete(callback);
    }
  }

  emit(event, ...args) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.forEach((callback) => {
        try {
          callback(...args);
        } catch (err) {
          console.warn(`[NetworkLab] Listener error for '${event}':`, err);
        }
      });
    }
  }

  // Alias for backward compatibility
  subscribe(callback) {
    if (typeof callback === 'function') {
      return this.on('event', (record) => callback('eventAdded', record));
    }
    return () => {};
  }

  // ----------------------------------------------------
  // Application Event Recording
  // ----------------------------------------------------

  /**
   * Record an application lifecycle event.
   *
   * @param {object} eventData
   * @returns {object} The created event record
   */
  recordEvent(eventData) {
    try {
      this.eventCounter += 1;
      const id = `ev_${Date.now()}_${this.eventCounter}`;
      const timestamp = Date.now();

      // Normalize category (e.g. 'files' -> 'file')
      let cat = eventData.category || EVENT_CATEGORIES.WEBRTC;
      if (cat === 'files') cat = EVENT_CATEGORIES.FILE;

      // Hex & Text previews (bounded to MAX_HEX_PREVIEW_BYTES)
      let hexPreview = '';
      let previewBytes = 0;
      let totalBytes = 0;
      let isTruncated = false;
      let safeTextPreview = null;
      let rawPayloadType = 'none';

      if (eventData.rawPayload !== undefined && eventData.rawPayload !== null) {
        const hexRes = formatHexPreview(eventData.rawPayload);
        hexPreview = hexRes.hex;
        previewBytes = hexRes.previewBytes;
        totalBytes = hexRes.totalBytes;
        isTruncated = hexRes.isTruncated;

        const textRes = decodeSafeTextPreview(eventData.rawPayload);
        safeTextPreview = textRes.text;
        rawPayloadType = typeof eventData.rawPayload === 'string' ? 'text/json' : 'application/octet-stream';
      } else if (eventData.hexPreview) {
        hexPreview = typeof eventData.hexPreview === 'string' ? eventData.hexPreview : eventData.hexPreview.hex;
        previewBytes = eventData.previewBytes || eventData.hexPreview?.previewBytes || 0;
        totalBytes = eventData.totalBytes || eventData.hexPreview?.totalBytes || 0;
        isTruncated = Boolean(eventData.isTruncated || eventData.hexPreview?.isTruncated);
      }

      const appByteCount =
        typeof eventData.applicationByteCount === 'number'
          ? eventData.applicationByteCount
          : typeof eventData.payloadSize === 'number'
          ? eventData.payloadSize
          : totalBytes || null;

      const record = {
        id,
        timestamp,
        source: eventData.source || EVENT_SOURCES.APPLICATION,
        category: cat,
        type: eventData.type || 'unknown',
        direction: eventData.direction || 'internal', // 'out' | 'in' | 'internal'
        peerSessionId: eventData.peerSessionId || null,
        targetSessionId: eventData.targetSessionId || null,
        peerLabel: eventData.peerLabel || (eventData.peerSessionId ? `Peer ${String(eventData.peerSessionId).slice(0, 8)}` : null),
        transferId: eventData.transferId || null,
        messageId: eventData.messageId || null,
        name: eventData.name || null,
        status: eventData.status || 'accepted',
        progress: typeof eventData.progress === 'number' ? eventData.progress : null,

        // Actual sizes
        applicationByteCount: appByteCount,
        payloadSize: appByteCount,
        headerSize: typeof eventData.headerSize === 'number' ? eventData.headerSize : null,
        chunkPayloadSize: typeof eventData.chunkPayloadSize === 'number'
          ? eventData.chunkPayloadSize
          : typeof eventData.payloadSize === 'number'
          ? eventData.payloadSize
          : null,
        totalFrameSize: typeof eventData.totalFrameSize === 'number'
          ? eventData.totalFrameSize
          : typeof eventData.frameSize === 'number'
          ? eventData.frameSize
          : null,
        originalFileSize: typeof eventData.originalFileSize === 'number'
          ? eventData.originalFileSize
          : typeof eventData.size === 'number'
          ? eventData.size
          : null,
        chunkIndex: typeof eventData.chunkIndex === 'number' ? eventData.chunkIndex : null,
        totalChunks: typeof eventData.totalChunks === 'number' ? eventData.totalChunks : null,
        stateType: eventData.stateType || null,

        // Observation point clarification
        observationPoint: eventData.observationPoint || 'Local DataChannel API Acceptance',

        // Bounded Hex Preview
        hexPreview,
        previewBytes,
        isTruncated,
        rawPayloadType,
        safeTextPreview,

        details: eventData.details || {},
      };

      // Bounded in-memory retention (FIFO eviction)
      this.events.unshift(record);
      if (this.events.length > this.maxEvents) {
        this.events.pop();
      }

      this.emit('event', record);
      return record;
    } catch (err) {
      console.warn('[NetworkLab] Error recording event:', err);
      return null;
    }
  }

  getEvents(filterCategory = null) {
    if (!filterCategory || filterCategory === 'all') {
      return [...this.events];
    }
    return this.events.filter((e) => e.category === filterCategory);
  }

  getEventCount() {
    return this.events.length;
  }

  getEventById(id) {
    return this.events.find((e) => e.id === id) || null;
  }

  clearHistory() {
    this.events = [];
    this.revealedEventIds.clear();
    this.emit('clear');
  }

  // ----------------------------------------------------
  // Privacy & Content Reveal
  // ----------------------------------------------------

  isEventRevealed(eventId) {
    return this.revealedEventIds.has(eventId);
  }

  isContentRevealed(eventId) {
    return this.isEventRevealed(eventId);
  }

  setEventRevealed(eventId, revealed = true) {
    if (revealed) {
      this.revealedEventIds.add(eventId);
    } else {
      this.revealedEventIds.delete(eventId);
    }
  }

  revealContent(eventId) {
    this.setEventRevealed(eventId, true);
  }

  hideContent(eventId) {
    this.setEventRevealed(eventId, false);
  }

  // ----------------------------------------------------
  // WebRTC Stats Polling & Normalization
  // ----------------------------------------------------

  bindRegistry(peerRegistry) {
    this.peerRegistry = peerRegistry;
  }

  startStatsPolling(intervalMs = null) {
    if (intervalMs) this.statsPollIntervalMs = intervalMs;
    if (this.isPolling) return;
    this.isPolling = true;

    const poll = async () => {
      if (!this.isPolling) return;
      await this.pollAllPeerStats();
      if (this.isPolling) {
        this.statsTimer = setTimeout(poll, this.statsPollIntervalMs);
      }
    };

    poll();
  }

  stopStatsPolling() {
    this.isPolling = false;
    if (this.statsTimer) {
      clearTimeout(this.statsTimer);
      this.statsTimer = null;
    }
  }

  getLatestStats() {
    const map = new Map();
    this.peerStatsHistory.forEach((v, k) => {
      if (v.lastNormalized) {
        map.set(k, v.lastNormalized);
      }
    });
    return map;
  }

  async pollAllPeerStats() {
    if (!this.peerRegistry) {
      return new Map();
    }

    const peers = typeof this.peerRegistry.getPeers === 'function' ? this.peerRegistry.getPeers() : Array.from(this.peerRegistry.peers?.values() || []);
    const results = new Map();

    for (const peer of peers) {
      if (!peer || !peer.pc) continue;
      try {
        const stats = await this.queryPeerStats(peer);
        if (stats) {
          results.set(stats.peerSessionId, stats);
        }
      } catch (err) {
        console.warn(`[NetworkLab] Error polling stats for peer:`, err);
      }
    }

    this.emit('stats', results);
    return results;
  }

  async queryPeerStats(peer) {
    if (!peer || !peer.pc || typeof peer.pc.getStats !== 'function') return null;

    const peerId = peer.remoteSessionId || 'unknown';

    let rawStatsReport;
    try {
      rawStatsReport = await peer.pc.getStats();
    } catch {
      return null;
    }

    const normalizedStats = this._normalizeStatsReport(rawStatsReport, peer, peerId);
    this._calculateDerivativeRates(normalizedStats, peerId);

    // Update history for next sample
    this.peerStatsHistory.set(peerId, {
      timestamp: normalizedStats.timestamp,
      lastNormalized: normalizedStats,
    });

    return normalizedStats;
  }

  _normalizeStatsReport(rawStatsReport, peer, peerId) {
    const now = Date.now();
    let transportStats = null;
    let candidatePairStats = null;
    const dataChannelStatsMap = new Map();
    const candidateMap = new Map();

    if (rawStatsReport && typeof rawStatsReport.forEach === 'function') {
      rawStatsReport.forEach((report, key) => {
        const id = report.id || key;
        if (report.type === 'transport') {
          transportStats = report;
        } else if (report.type === 'candidate-pair') {
          if (report.selected || report.nominated || report.state === 'succeeded') {
            candidatePairStats = report;
          } else if (!candidatePairStats && report.state === 'in-progress') {
            candidatePairStats = report;
          }
        } else if (report.type === 'data-channel') {
          dataChannelStatsMap.set(report.label || id, report);
        } else if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
          candidateMap.set(id, report);
        }
      });
    }

    // Determine candidate type
    let candidateType = 'unknown';
    let isRelay = false;
    if (candidatePairStats) {
      const localCand = candidateMap.get(candidatePairStats.localCandidateId);
      const remoteCand = candidateMap.get(candidatePairStats.remoteCandidateId);
      if (localCand?.candidateType === 'relay' || remoteCand?.candidateType === 'relay') {
        isRelay = true;
        candidateType = 'relay';
      } else if (localCand?.candidateType === 'srflx' || remoteCand?.candidateType === 'srflx') {
        candidateType = 'srflx';
      } else if (localCand?.candidateType === 'host' && remoteCand?.candidateType === 'host') {
        candidateType = 'host';
      } else if (localCand?.candidateType) {
        candidateType = localCand.candidateType;
      }
    }

    // Round-trip time in milliseconds (safe conversion from seconds if < 1.0)
    let roundTripTimeMs = null;
    if (typeof candidatePairStats?.currentRoundTripTime === 'number') {
      roundTripTimeMs = Math.round(candidatePairStats.currentRoundTripTime * 1000);
    }

    const chatStats = dataChannelStatsMap.get('pairport-chat') || dataChannelStatsMap.get('chat') || null;
    const fileStats = dataChannelStatsMap.get('pairport-files') || dataChannelStatsMap.get('files') || null;

    return {
      peerSessionId: peerId,
      peerLabel: `Peer ${String(peerId).slice(0, 8)}`,
      timestamp: now,
      connectionState: peer?.pc?.connectionState || peer?.connectionState || 'unknown',
      iceConnectionState: peer?.pc?.iceConnectionState || 'unknown',
      candidateType,
      isRelay,
      candidatePairState: candidatePairStats?.state || 'unknown',
      roundTripTimeMs,
      dtlsCipher: transportStats?.dtlsCipher || null,
      srtpCipher: transportStats?.srtpCipher || null,

      // Cumulative bytes / packets: null if unavailable, NEVER fabricated as zero
      bytesSent: typeof transportStats?.bytesSent === 'number'
        ? transportStats.bytesSent
        : typeof candidatePairStats?.bytesSent === 'number'
        ? candidatePairStats.bytesSent
        : null,
      bytesReceived: typeof transportStats?.bytesReceived === 'number'
        ? transportStats.bytesReceived
        : typeof candidatePairStats?.bytesReceived === 'number'
        ? candidatePairStats.bytesReceived
        : null,
      packetsSent: typeof transportStats?.packetsSent === 'number'
        ? transportStats.packetsSent
        : typeof candidatePairStats?.packetsSent === 'number'
        ? candidatePairStats.packetsSent
        : null,
      packetsReceived: typeof transportStats?.packetsReceived === 'number'
        ? transportStats.packetsReceived
        : typeof candidatePairStats?.packetsReceived === 'number'
        ? candidatePairStats.packetsReceived
        : null,

      // Initial rate placeholders
      throughputOutBps: null,
      throughputInBps: null,

      // Channel details
      chatChannel: {
        state: chatStats?.state || peer?.chatChannel?.readyState || 'unknown',
        messagesSent: typeof chatStats?.messagesSent === 'number' ? chatStats.messagesSent : null,
        messagesReceived: typeof chatStats?.messagesReceived === 'number' ? chatStats.messagesReceived : null,
      },
      fileChannel: {
        state: fileStats?.state || peer?.fileChannel?.readyState || 'unknown',
        messagesSent: typeof fileStats?.messagesSent === 'number' ? fileStats.messagesSent : null,
        messagesReceived: typeof fileStats?.messagesReceived === 'number' ? fileStats.messagesReceived : null,
      },
    };
  }

  _calculateDerivativeRates(currentStats, peerId) {
    const prev = this.previousStatsSamples.get(peerId);
    this.previousStatsSamples.set(peerId, {
      timestamp: currentStats.timestamp,
      bytesSent: currentStats.bytesSent,
      bytesReceived: currentStats.bytesReceived,
    });

    if (!prev || !prev.timestamp || currentStats.timestamp <= prev.timestamp) {
      return;
    }

    const elapsedSec = (currentStats.timestamp - prev.timestamp) / 1000;
    if (elapsedSec <= 0) return;

    if (
      typeof currentStats.bytesSent === 'number' &&
      typeof prev.bytesSent === 'number' &&
      currentStats.bytesSent >= prev.bytesSent
    ) {
      currentStats.throughputOutBps = Math.round((currentStats.bytesSent - prev.bytesSent) / elapsedSec);
    } else {
      currentStats.throughputOutBps = null;
    }

    if (
      typeof currentStats.bytesReceived === 'number' &&
      typeof prev.bytesReceived === 'number' &&
      currentStats.bytesReceived >= prev.bytesReceived
    ) {
      currentStats.throughputInBps = Math.round((currentStats.bytesReceived - prev.bytesReceived) / elapsedSec);
    } else {
      currentStats.throughputInBps = null;
    }
  }

  getLatestPeerStats(peerId) {
    return this.peerStatsHistory.get(peerId)?.lastNormalized || null;
  }

  teardown() {
    this.stopStatsPolling();
    this.clearHistory();
    this.peerStatsHistory.clear();
    this.previousStatsSamples.clear();
    this.peerRegistry = null;
  }
}

/** Singleton instance */
export const networkLabService = new NetworkLabService();
