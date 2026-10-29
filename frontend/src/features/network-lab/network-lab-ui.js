/**
 * PairPort Network Lab — UI Renderer (Phase 2)
 *
 * Professional in-app network diagnostics and packet inspection console.
 *
 * Strict Display Policies:
 * - Clear distinction: Application chunks vs Browser WebRTC stats vs External packets.
 * - Default: Bounded hexadecimal preview (first 64 bytes).
 * - Readable payload: Revealed ONLY after an explicit user click.
 * - Never auto-decode binary file payloads or reconstruct full files in memory.
 * - Never log or expose invitation tokens, reconnect tokens, room secrets, or raw IP addresses.
 * - No fabricated throughput, packet counts, or cipher names (unavailable fields marked as 'Unavailable').
 */

import { escapeHtml, formatFileSize } from '../../utils/ui-helpers.js';
import { icons } from '../../components/icons.js';
import { EVENT_CATEGORIES, EVENT_SOURCES } from '../../services/network-lab.js';

/**
 * Format timestamp into precise HH:MM:SS.mmm format for network events.
 * @param {number|Date} ts
 * @returns {string}
 */
export function formatPreciseTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Render Wireshark-style bounded hex dump with ASCII representation.
 * @param {string} hexStr - Space-separated hex string
 * @param {number} totalBytes - Total application payload size
 * @param {number} previewBytes - Bytes included in preview
 * @param {boolean} isTruncated - Whether preview was capped
 * @returns {string}
 */
export function renderHexViewer(hexStr, totalBytes, previewBytes, isTruncated) {
  if (!hexStr || hexStr.length === 0) {
    return `
      <div class="netlab-hex-empty">
        <span class="netlab-empty-hint">No application payload bytes for this event.</span>
      </div>
    `;
  }

  const hexTokens = hexStr.split(' ');
  const rows = [];
  const bytesPerRow = 16;

  for (let i = 0; i < hexTokens.length; i += bytesPerRow) {
    const chunkTokens = hexTokens.slice(i, i + bytesPerRow);
    const offsetHex = i.toString(16).padStart(4, '0').toUpperCase();

    // Split into 8-byte halves for readability
    const firstHalf = chunkTokens.slice(0, 8).join(' ');
    const secondHalf = chunkTokens.slice(8, 16).join(' ');
    const hexRow = `${firstHalf.padEnd(23, ' ')}   ${secondHalf.padEnd(23, ' ')}`;

    // Generate ASCII printable representation
    const asciiRow = chunkTokens
      .map((tok) => {
        const byteVal = parseInt(tok, 16);
        return byteVal >= 32 && byteVal <= 126 ? String.fromCharCode(byteVal) : '.';
      })
      .join('');

    rows.push(
      `<span class="hex-offset">${offsetHex}:</span>  <span class="hex-bytes">${escapeHtml(
        hexRow
      )}</span>  <span class="hex-ascii">|${escapeHtml(asciiRow)}|</span>`
    );
  }

  const truncNotice = isTruncated
    ? `<span class="netlab-trunc-badge">Showing first ${previewBytes} of ${formatFileSize(
        totalBytes
      )} (bounded view)</span>`
    : `<span class="netlab-trunc-badge complete">Full payload (${previewBytes} bytes)</span>`;

  return `
    <div class="netlab-hex-container">
      <div class="netlab-hex-meta">
        <span class="netlab-hex-label">${icons.shield(14)} Bounded Hexadecimal Preview</span>
        ${truncNotice}
      </div>
      <pre class="netlab-hex-pre" aria-label="Hexadecimal payload dump"><code>${rows.join('\n')}</code></pre>
    </div>
  `;
}

/**
 * Render the Selected Event Inspector panel.
 * @param {object|null} event - Currently selected event
 * @param {boolean} isRevealed - Whether the user has explicitly revealed readable content
 * @returns {string}
 */
export function renderEventInspector(event, isRevealed = false) {
  if (!event) {
    return `
      <div class="netlab-inspector-empty">
        <div class="netlab-empty-icon">${icons.activity(32)}</div>
        <h4 class="netlab-empty-title">Select an event from the timeline</h4>
        <p class="netlab-empty-desc">
          Inspect application-level frames, transfer chunk headers, byte boundaries, and bounded hex previews.
        </p>
      </div>
    `;
  }

  const {
    id,
    timestamp,
    category,
    source,
    direction,
    peerSessionId,
    targetSessionId,
    transferId,
    chunkIndex,
    totalChunks,
    headerSize,
    chunkPayloadSize,
    totalFrameSize,
    originalFileSize,
    applicationByteCount,
    observationPoint,
    status,
    hexPreview,
    previewBytes,
    isTruncated,
    rawPayloadType,
    safeTextPreview,
  } = event;

  const effectivePeer = peerSessionId || targetSessionId || 'Local';
  const safePeerDisplay = effectivePeer !== 'Local' && effectivePeer.length > 8 ? `${effectivePeer.slice(0, 8)}...` : effectivePeer;
  const dirLabel = direction === 'out' ? 'Outgoing (Local → Remote)' : direction === 'in' ? 'Incoming (Remote → Local)' : 'Local System';
  const dirClass = direction === 'out' ? 'dir-out' : direction === 'in' ? 'dir-in' : 'dir-local';

  // Category badge
  const catClass = `cat-${category || 'app'}`;

  // Layer Distinction Matrix: Application chunk vs File vs Wire Packet
  const isFileChunk = category === EVENT_CATEGORIES.FILE && typeof chunkIndex === 'number';
  const isChatMsg = category === EVENT_CATEGORIES.CHAT;

  return `
    <div class="netlab-inspector-content" data-inspector-event-id="${escapeHtml(id)}">
      <!-- Inspector Header -->
      <div class="netlab-insp-header">
        <div class="netlab-insp-title-row">
          <span class="netlab-badge ${catClass}">${escapeHtml(category ? category.toUpperCase() : 'EVENT')}</span>
          <span class="netlab-badge ${dirClass}">${escapeHtml(dirLabel)}</span>
          <span class="netlab-insp-time font-mono">${formatPreciseTime(timestamp)}</span>
        </div>
        <div class="netlab-insp-id font-mono">
          <span class="netlab-label">Event ID:</span> <code>${escapeHtml(id)}</code>
        </div>
      </div>

      <!-- Protocol Metadata Grid -->
      <div class="netlab-insp-grid">
        <div class="insp-cell">
          <span class="insp-k">Source Layer</span>
          <span class="insp-v">${escapeHtml(source || EVENT_SOURCES.APPLICATION)}</span>
        </div>

        <div class="insp-cell">
          <span class="insp-k">Observation Point</span>
          <span class="insp-v">${escapeHtml(observationPoint || 'DataChannel boundary')}</span>
        </div>

        <div class="insp-cell">
          <span class="insp-k">Peer Identity</span>
          <span class="insp-v font-mono">${escapeHtml(safePeerDisplay)}</span>
        </div>

        <div class="insp-cell">
          <span class="insp-k">Outcome / Status</span>
          <span class="insp-v status-${escapeHtml(status || 'ok')}">${escapeHtml(status || 'accepted')}</span>
        </div>

        ${
          transferId
            ? `
          <div class="insp-cell">
            <span class="insp-k">Transfer ID</span>
            <span class="insp-v font-mono">${escapeHtml(transferId)}</span>
          </div>
        `
            : ''
        }

        ${
          typeof chunkIndex === 'number'
            ? `
          <div class="insp-cell">
            <span class="insp-k">Chunk Index</span>
            <span class="insp-v font-mono">${chunkIndex + 1}${totalChunks ? ` / ${totalChunks}` : ''}</span>
          </div>
        `
            : ''
        }
      </div>

      <!-- Layer Size Comparison: Dispel ambiguity between chunk, file, and packet -->
      <div class="netlab-layer-matrix">
        <h5 class="matrix-title">Layer & Size Attribution</h5>
        <div class="matrix-table">
          <div class="matrix-row header">
            <span class="m-col layer">Layer</span>
            <span class="m-col spec">Specification / Protocol</span>
            <span class="m-col val">Measured Size</span>
          </div>

          ${
            isFileChunk
              ? `
            <div class="matrix-row">
              <span class="m-col layer">Chunk Payload</span>
              <span class="m-col spec">Binary file slice</span>
              <span class="m-col val font-mono">${chunkPayloadSize ? `${chunkPayloadSize.toLocaleString()} B` : '—'}</span>
            </div>
            <div class="matrix-row highlight">
              <span class="m-col layer">Application Frame</span>
              <span class="m-col spec">36B header ([0..31] ID, [32..35] Index) + chunk</span>
              <span class="m-col val font-mono">${totalFrameSize ? `${totalFrameSize.toLocaleString()} B` : '—'}</span>
            </div>
            ${
              originalFileSize
                ? `
              <div class="matrix-row">
                <span class="m-col layer">Total File</span>
                <span class="m-col spec">Complete application file</span>
                <span class="m-col val font-mono">${formatFileSize(originalFileSize)}</span>
              </div>
            `
                : ''
            }
          `
              : isChatMsg
              ? `
            <div class="matrix-row highlight">
              <span class="m-col layer">Application Payload</span>
              <span class="m-col spec">UTF-8 Encoded JSON DataChannel String</span>
              <span class="m-col val font-mono">${applicationByteCount ? `${applicationByteCount.toLocaleString()} B` : '—'}</span>
            </div>
          `
              : `
            <div class="matrix-row">
              <span class="m-col layer">Application Event</span>
              <span class="m-col spec">WebRTC State / Signaling Transition</span>
              <span class="m-col val font-mono">${applicationByteCount ? `${applicationByteCount.toLocaleString()} B` : '—'}</span>
            </div>
          `
          }

          <div class="matrix-row wire-packet-row">
            <span class="m-col layer">Wire Network Packet</span>
            <span class="m-col spec">IP / UDP / DTLS / SCTP transport</span>
            <span class="m-col val font-mono wire-note">External Capture Required</span>
          </div>
        </div>
        <p class="matrix-footnote">
          <em>Note:</em> The browser does not expose raw network packets to JavaScript. 
          Use Wireshark to inspect Ethernet/IP/UDP frames on the wire.
        </p>
      </div>

      <!-- Payload Preview Section (Privacy bounded hex by default) -->
      <div class="netlab-payload-section">
        <div class="payload-header-row">
          <h5 class="payload-section-title">Application Payload Preview</h5>
          ${
            hexPreview
              ? `
            <div class="payload-actions">
              ${
                isRevealed
                  ? `<button type="button" id="netlab-hide-payload-btn" class="btn btn-ghost btn-xs">
                      ${icons.lock(12)} Hide Readable Content
                    </button>`
                  : `<button type="button" id="netlab-reveal-payload-btn" class="btn btn-outline btn-xs">
                      ${icons.sparkles(12)} Reveal Readable Content
                    </button>`
              }
            </div>
          `
              : ''
          }
        </div>

        ${
          hexPreview
            ? `
          <!-- Bounded Hex Preview -->
          ${renderHexViewer(hexPreview, applicationByteCount || previewBytes, previewBytes, isTruncated)}

          <!-- Explicit Readable Reveal Container -->
          ${
            isRevealed
              ? `
            <div class="netlab-revealed-container animate-fade-in">
              <div class="revealed-header">
                <span class="revealed-tag">${icons.check(12)} Verified Decoded Content</span>
                <span class="revealed-type">${escapeHtml(rawPayloadType || 'text')}</span>
              </div>
              ${
                safeTextPreview
                  ? `<pre class="revealed-text"><code>${escapeHtml(safeTextPreview)}</code></pre>`
                  : `<div class="revealed-binary-notice">
                      ${icons.alertTriangle(16)}
                      <span>Binary payload: arbitrary binary data cannot be safely decoded as text. Only the bounded hexadecimal preview above represents this payload accurately.</span>
                    </div>`
              }
            </div>
          `
              : `
            <div class="netlab-privacy-note">
              ${icons.lock(13)}
              <span>Payload text is hidden by default to protect privacy. Click <strong>Reveal Readable Content</strong> to inspect decoded text for this event.</span>
            </div>
          `
          }
        `
            : `
          <div class="netlab-no-payload">
            <span>No binary or message payload associated with this control event.</span>
          </div>
        `
        }
      </div>
    </div>
  `;
}

/**
 * Render the Timeline list of events.
 * @param {Array<object>} events - List of recorded events
 * @param {string|null} selectedId - ID of currently selected event
 * @returns {string}
 */
export function renderTimelineEvents(events, selectedId = null) {
  if (!Array.isArray(events) || events.length === 0) {
    return `
      <div class="netlab-timeline-empty">
        <div class="netlab-empty-icon">${icons.activity(24)}</div>
        <p class="netlab-empty-text">No network events recorded yet.</p>
        <span class="netlab-empty-sub">Send a chat message or start a file transfer to inspect real application chunks.</span>
      </div>
    `;
  }

  const items = events.map((ev) => {
    const isSelected = ev.id === selectedId;
    const catClass = `cat-${ev.category || 'app'}`;
    const dirIcon = ev.direction === 'out' ? icons.arrowUp(12) : ev.direction === 'in' ? icons.arrowDown(12) : '•';
    const dirClass = ev.direction === 'out' ? 'dir-out' : ev.direction === 'in' ? 'dir-in' : 'dir-local';

    const safePeer = ev.peerSessionId ? (ev.peerSessionId.length > 6 ? ev.peerSessionId.slice(0, 6) : ev.peerSessionId) : 'Local';

    // Format human-friendly event title
    let title = ev.type || 'Event';
    if (ev.type === 'file:chunk_outgoing' || ev.type === 'file:chunk_incoming') {
      title = `Chunk #${(ev.chunkIndex || 0) + 1}${ev.totalChunks ? `/${ev.totalChunks}` : ''}`;
    } else if (ev.type === 'chat:outgoing') {
      title = 'Chat Sent';
    } else if (ev.type === 'chat:incoming') {
      title = 'Chat Received';
    } else if (ev.type === 'file:start_outgoing' || ev.type === 'file:start_incoming') {
      title = 'File Transfer Init';
    } else if (ev.type === 'file:complete_outgoing' || ev.type === 'file:complete_incoming') {
      title = 'File Transfer Complete';
    } else if (ev.type === 'webrtc:state') {
      title = `WebRTC: ${ev.stateType || 'state'}`;
    }

    const sizeStr = ev.chunkPayloadSize
      ? `${ev.chunkPayloadSize.toLocaleString()} B`
      : ev.applicationByteCount
      ? `${ev.applicationByteCount.toLocaleString()} B`
      : '—';

    return `
      <div class="netlab-event-item ${isSelected ? 'selected' : ''}" 
           data-event-id="${escapeHtml(ev.id)}" 
           role="button" 
           tabindex="0"
           aria-pressed="${isSelected}">
        <div class="event-item-top">
          <span class="event-item-dir ${dirClass}" title="${escapeHtml(ev.direction)}">${dirIcon}</span>
          <span class="event-item-time font-mono">${formatPreciseTime(ev.timestamp)}</span>
          <span class="event-item-cat ${catClass}">${escapeHtml(ev.category || 'app')}</span>
          <span class="event-item-peer font-mono" title="Peer: ${escapeHtml(ev.peerSessionId || 'Local')}">${escapeHtml(safePeer)}</span>
        </div>
        <div class="event-item-bottom">
          <span class="event-item-title">${escapeHtml(title)}</span>
          <span class="event-item-size font-mono">${escapeHtml(sizeStr)}</span>
        </div>
      </div>
    `;
  });

  return items.join('');
}

/**
 * Render Live WebRTC Statistics Table from polled getStats() samples.
 * @param {Map<string, object>} statsMap - Map of peerSessionId -> PeerStats
 * @returns {string}
 */
export function renderStatsTable(statsMap) {
  if (!statsMap || statsMap.size === 0) {
    return `
      <div class="netlab-stats-empty">
        <span class="netlab-empty-hint">No active WebRTC peer connections. Connect to a room to view browser-reported transport statistics.</span>
      </div>
    `;
  }

  const rows = [];
  statsMap.forEach((stats, peerId) => {
    const safePeer = peerId.length > 8 ? `${peerId.slice(0, 8)}...` : peerId;
    const rttText = typeof stats.roundTripTimeMs === 'number' ? `${Math.round(stats.roundTripTimeMs)} ms` : 'Unavailable';
    const cipherText = stats.dtlsCipher || 'Not exposed by this browser';
    const candType = stats.candidateType || 'Unknown';
    const outRateText = typeof stats.throughputOutBps === 'number' ? `${formatFileSize(stats.throughputOutBps)}/s` : '—';
    const inRateText = typeof stats.throughputInBps === 'number' ? `${formatFileSize(stats.throughputInBps)}/s` : '—';
    const sentPktsText = typeof stats.packetsSent === 'number' ? ` <small>(${stats.packetsSent.toLocaleString()} pkts)</small>` : '';
    const recvPktsText = typeof stats.packetsReceived === 'number' ? ` <small>(${stats.packetsReceived.toLocaleString()} pkts)</small>` : '';
    const bytesSent = typeof stats.bytesSent === 'number' ? formatFileSize(stats.bytesSent) : '0 Bytes';
    const bytesRecv = typeof stats.bytesReceived === 'number' ? formatFileSize(stats.bytesReceived) : '0 Bytes';

    rows.push(`
      <tr class="stats-table-row">
        <td class="font-mono"><strong>${escapeHtml(safePeer)}</strong></td>
        <td><span class="stats-state-pill ${escapeHtml(stats.connectionState || 'idle')}">${escapeHtml(stats.connectionState || 'idle')}</span></td>
        <td><span class="stats-cand-pill ${candType === 'relay' ? 'relay' : 'direct'}">${escapeHtml(candType)}</span></td>
        <td class="font-mono">${escapeHtml(rttText)}</td>
        <td class="font-mono stats-cipher-cell" title="${escapeHtml(cipherText)}">${escapeHtml(cipherText)}</td>
        <td class="font-mono">${escapeHtml(bytesSent)}${sentPktsText}</td>
        <td class="font-mono">${escapeHtml(bytesRecv)}${recvPktsText}</td>
        <td class="font-mono stats-rate-cell">
          <span class="rate-out">↑ ${escapeHtml(outRateText)}</span>
          <span class="rate-in">↓ ${escapeHtml(inRateText)}</span>
        </td>
      </tr>
    `);
  });

  return `
    <div class="netlab-stats-table-wrapper">
      <table class="netlab-stats-table" aria-label="WebRTC Connection Statistics">
        <thead>
          <tr>
            <th>Peer</th>
            <th>State</th>
            <th>Path</th>
            <th>RTT</th>
            <th>DTLS Cipher</th>
            <th>Browser Sent</th>
            <th>Browser Received</th>
            <th>Est. Rate</th>
          </tr>
        </thead>
        <tbody>
          ${rows.join('')}
        </tbody>
      </table>
      <div class="netlab-stats-footer">
        <small>Cumulative counters reported directly by <code>RTCPeerConnection.getStats()</code>. Rates calculated from positive delta samples. Zero is rendered only when explicitly reported.</small>
      </div>
    </div>
  `;
}

/**
 * Render the complete Network Lab Section markup.
 * @param {object} currentState - Application state
 * @returns {string} HTML markup string
 */
export function renderNetworkLabSection(currentState) {
  const isOpen = Boolean(currentState?.isNetworkLabOpen);

  return `
    <div id="network-lab-panel" class="network-lab-section ${isOpen ? 'is-open' : 'is-collapsed'}" role="region" aria-labelledby="network-lab-heading">
      <!-- Section Header -->
      <div class="netlab-panel-header">
        <div class="netlab-title-group">
          <span class="netlab-status-dot"></span>
          <h3 id="network-lab-heading" class="netlab-title">
            ${icons.activity(18)} Network Lab
          </h3>
          <span class="netlab-subtitle">Application Frame & WebRTC Transport Inspector</span>
          <span class="netlab-counter-pill" id="netlab-event-counter">0 Events</span>
        </div>
        <div class="netlab-header-actions">
          <button type="button" id="netlab-clear-btn" class="btn btn-ghost btn-xs" title="Clear diagnostic timeline (does not affect chat or files)">
            ${icons.trash(14)} <span>Clear History</span>
          </button>
          <button type="button" id="netlab-toggle-btn" class="btn btn-ghost btn-xs" aria-expanded="${isOpen}" aria-controls="netlab-panel-body">
            <span class="netlab-toggle-text">${isOpen ? 'Collapse Lab' : 'Open Lab'}</span>
          </button>
        </div>
      </div>

      <!-- Collapsible Body -->
      <div id="netlab-panel-body" class="netlab-panel-body ${isOpen ? '' : 'hidden'}">
        <!-- Layer Distinction Educational Banner (Mandatory requirement) -->
        <div class="netlab-distinction-banner" role="note">
          <div class="banner-icon">${icons.info(18)}</div>
          <div class="banner-body">
            <strong>Layer Distinction Principle:</strong> Application events show data handled by PairPort. WebRTC statistics are reported by the browser. Network packets are captured externally on the wire. These views describe different layers and may not correspond one-to-one.
          </div>
        </div>

        <!-- Filter & Control Toolbar -->
        <div class="netlab-toolbar">
          <div class="toolbar-filter-group" role="group" aria-label="Filter events by category">
            <button type="button" class="netlab-filter-btn active" data-filter="all">All Events</button>
            <button type="button" class="netlab-filter-btn" data-filter="chat">Chat</button>
            <button type="button" class="netlab-filter-btn" data-filter="file">Files</button>
            <button type="button" class="netlab-filter-btn" data-filter="webrtc">WebRTC</button>
            <button type="button" class="netlab-filter-btn" data-filter="stats">Stats</button>
          </div>
          <div class="toolbar-hint">
            <span class="privacy-badge">${icons.shield(12)} Privacy Protected: 0 credentials logged</span>
          </div>
        </div>

        <!-- Split Grid Workspace -->
        <div class="netlab-workspace-grid">
          <!-- Left Column: Activity Timeline -->
          <div class="netlab-timeline-col">
            <div class="col-header">
              <span class="col-title">Live Activity Timeline</span>
              <span class="col-meta" id="netlab-filtered-count">Showing 0</span>
            </div>
            <div id="netlab-timeline-host" class="netlab-timeline-host" tabindex="0" aria-label="Event timeline list">
              <!-- Dynamically populated by renderTimelineEvents -->
            </div>
          </div>

          <!-- Right Column: Selected Event Inspector -->
          <div class="netlab-inspector-col">
            <div class="col-header">
              <span class="col-title">Selected Event Details & Frame Inspection</span>
            </div>
            <div id="netlab-inspector-host" class="netlab-inspector-host">
              <!-- Dynamically populated by renderEventInspector -->
            </div>
          </div>
        </div>

        <!-- Per-Peer WebRTC Statistics Section -->
        <div class="netlab-stats-section">
          <div class="stats-header">
            <div class="stats-title-group">
              <span class="stats-icon">${icons.wifi(16)}</span>
              <h4 class="stats-title">Live Peer Connection & Transport Statistics</h4>
            </div>
            <span class="stats-freshness" id="netlab-stats-freshness">Updated via getStats()</span>
          </div>
          <div id="netlab-stats-host" class="netlab-stats-host">
            <!-- Dynamically populated by renderStatsTable -->
          </div>
        </div>

        <!-- External Capture Guide Callout -->
        <div class="netlab-wireshark-callout">
          <div class="callout-left">
            <span class="callout-badge">${icons.lock(14)} Wire-Level Packet Capture</span>
            <p class="callout-text">
              Want to see actual encrypted UDP/DTLS/SCTP frames traveling through your network interface? 
              Follow our comprehensive guide for capturing PairPort traffic with Wireshark.
            </p>
          </div>
          <div class="callout-right">
            <a href="docs/NETWORK_LAB_PACKET_CAPTURE.md" target="_blank" rel="noopener noreferrer" class="btn btn-outline btn-xs" id="netlab-open-capture-guide-btn">
              ${icons.arrowRight(12)} Wireshark Guide
            </a>
          </div>
        </div>
      </div>
    </div>
  `;
}
