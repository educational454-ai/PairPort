/**
 * PairPort Live Mesh Network Visualization — UI Renderer (Phase 2B)
 *
 * Renders an accessible, responsive, real-time SVG network topology graph
 * and compact link telemetry inspector inspired by Wireshark and Packet Tracer.
 *
 * Guarantees:
 * - Edges drawn ONLY for actual peer connections in local registry.
 * - Local node labeled as "You"; safe truncated IDs for remote peers.
 * - Privacy-safe: zero IP addresses, tokens, or ICE secrets exposed.
 * - Accurate connection states: connecting, connected, disconnected, reconnecting, failed.
 * - Missing diagnostics render as "—"; no fabricated values.
 * - Accessible SVG with role="button", tabindex="0", and keyboard navigation.
 */

import { formatFileSize, escapeHtml } from '../../utils/ui-helpers.js';
import { PEER_CONNECTION_STATES, DATA_CHANNEL_STATES } from '../../services/peer-connection.js';
import { SIGNALING_STATES } from '../../services/signaling.js';

export const CANVAS_WIDTH = 600;
export const CANVAS_HEIGHT = 320;
export const MAX_MESH_PARTICIPANTS = 4;

/**
 * Compute topology graph nodes and edges from current state and peer registry.
 *
 * @param {object} currentState - Application state
 * @param {object} peerRegistry - PeerRegistry instance
 * @returns {object} Graph structure with nodes, edges, and counts
 */
export function computeTopologyGraph(currentState, peerRegistry) {
  const mySessionId = peerRegistry?.mySessionId || currentState?.realSessionId || null;
  const myRole = peerRegistry?.myRole || currentState?.realRole || 'host';
  const isIdle = currentState?.signalingState === SIGNALING_STATES.IDLE;
  const isSignalingReconnecting = currentState?.isSignalingReconnecting || false;

  // 1. Gather all unique participants from authoritative roster or registry
  const roster = peerRegistry?.getRoster ? peerRegistry.getRoster() : (currentState?.participants || []);
  const participantMap = new Map();

  if (Array.isArray(roster)) {
    roster.forEach((p) => {
      if (p && p.session_id && p.status !== 'removed') {
        participantMap.set(p.session_id, {
          sessionId: p.session_id,
          role: p.role || 'guest',
          status: p.status || 'connected',
        });
      }
    });
  }

  // Ensure remote peers in registry are included even if roster message was delayed
  if (peerRegistry && typeof peerRegistry.getPeerIds === 'function') {
    peerRegistry.getPeerIds().forEach((peerId) => {
      if (!participantMap.has(peerId)) {
        const peer = peerRegistry.getPeer(peerId);
        participantMap.set(peerId, {
          sessionId: peerId,
          role: peer?.role || 'guest',
          status: peer?.connectionState === 'closed' ? 'disconnected' : 'connected',
        });
      }
    });
  }

  // 2. Build remote participant nodes (excluding local device)
  const remoteParticipants = [];
  participantMap.forEach((info, sessionId) => {
    if (sessionId !== mySessionId) {
      remoteParticipants.push(info);
    }
  });

  // Sort deterministically by sessionId for stable layout
  remoteParticipants.sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId)));

  // 3. Compute layout coordinates
  const remoteNodes = [];
  const cx = CANVAS_WIDTH / 2;
  const cy = 150;
  const count = remoteParticipants.length;

  let localPos = { x: cx, y: cy };

  if (count === 1) {
    localPos = { x: 180, y: cy };
    const p = remoteParticipants[0];
    remoteNodes.push(createRemoteNode(p, 420, cy, peerRegistry));
  } else if (count === 2) {
    localPos = { x: cx, y: 220 };
    remoteNodes.push(createRemoteNode(remoteParticipants[0], 180, 95, peerRegistry));
    remoteNodes.push(createRemoteNode(remoteParticipants[1], 420, 95, peerRegistry));
  } else if (count === 3) {
    localPos = { x: cx, y: cy };
    remoteNodes.push(createRemoteNode(remoteParticipants[0], 160, 90, peerRegistry));
    remoteNodes.push(createRemoteNode(remoteParticipants[1], 440, 90, peerRegistry));
    remoteNodes.push(createRemoteNode(remoteParticipants[2], cx, 255, peerRegistry));
  } else if (count >= 4) {
    localPos = { x: cx, y: cy };
    const radius = 125;
    remoteParticipants.forEach((p, idx) => {
      const angle = (idx * 2 * Math.PI) / count - Math.PI / 2;
      const x = Math.round(cx + radius * Math.cos(angle));
      const y = Math.round(cy + radius * Math.sin(angle));
      remoteNodes.push(createRemoteNode(p, x, y, peerRegistry));
    });
  }

  const localStatus = isIdle
    ? 'idle'
    : isSignalingReconnecting
    ? 'reconnecting'
    : 'connected';

  const localNode = {
    id: 'local',
    sessionId: mySessionId,
    role: myRole,
    isLocal: true,
    label: 'You',
    sublabel: myRole === 'host' ? 'Host' : 'Guest',
    status: localStatus,
    x: localPos.x,
    y: localPos.y,
  };

  // 4. Build edges ONLY for actual peer connections in registry
  const edges = [];
  remoteNodes.forEach((node) => {
    if (peerRegistry && typeof peerRegistry.hasPeer === 'function' && peerRegistry.hasPeer(node.sessionId)) {
      const peerService = peerRegistry.getPeer(node.sessionId);
      if (peerService && peerService.connectionState !== 'closed') {
        const edgeState = mapConnectionToEdgeStatus(peerService, node.status);
        edges.push({
          id: `edge-local-${node.sessionId}`,
          peerSessionId: node.sessionId,
          from: 'local',
          to: node.sessionId,
          x1: localNode.x,
          y1: localNode.y,
          x2: node.x,
          y2: node.y,
          status: edgeState,
          isRelay: Boolean(peerService._lastDiagnostics?.isRelay),
          selectedCandidateType: peerService._lastDiagnostics?.selectedCandidateType || null,
          roundTripTimeMs: peerService._lastDiagnostics?.roundTripTimeMs || null,
        });
      }
    }
  });

  return {
    localNode,
    remoteNodes,
    edges,
    totalParticipants: 1 + remoteNodes.length,
    activeConnections: edges.filter((e) => e.status === 'connected').length,
    maxParticipants: MAX_MESH_PARTICIPANTS,
  };
}

function createRemoteNode(participant, x, y, peerRegistry) {
  const hasConnection = Boolean(peerRegistry && peerRegistry.hasPeer && peerRegistry.hasPeer(participant.sessionId));
  const peerService = hasConnection ? peerRegistry.getPeer(participant.sessionId) : null;
  const status = computePeerNodeStatus(participant, peerService);

  return {
    id: participant.sessionId,
    sessionId: participant.sessionId,
    role: participant.role || 'guest',
    isLocal: false,
    label: `Peer ${String(participant.sessionId || '').slice(0, 8)}`,
    sublabel: participant.role === 'host' ? 'Host' : 'Guest',
    status,
    hasConnection,
    peerService,
    x,
    y,
  };
}

function computePeerNodeStatus(participant, peerService) {
  if (participant.status === 'disconnected') {
    return 'disconnected';
  }
  if (!peerService) {
    return 'connecting';
  }
  if (peerService.isRestartingIce || (peerService.iceRestartAttempts > 0 && peerService.connectionState !== PEER_CONNECTION_STATES.CONNECTED)) {
    return 'reconnecting';
  }
  switch (peerService.connectionState) {
    case PEER_CONNECTION_STATES.CONNECTED:
      return 'connected';
    case PEER_CONNECTION_STATES.CONNECTING:
      return 'connecting';
    case PEER_CONNECTION_STATES.FAILED:
      return 'failed';
    default:
      return peerService.connectionState || 'connecting';
  }
}

function mapConnectionToEdgeStatus(peerService, nodeStatus) {
  if (nodeStatus === 'disconnected') return 'disconnected';
  if (peerService.isRestartingIce || (peerService.iceRestartAttempts > 0 && peerService.connectionState !== PEER_CONNECTION_STATES.CONNECTED)) {
    return 'reconnecting';
  }
  switch (peerService.connectionState) {
    case PEER_CONNECTION_STATES.CONNECTED:
      return 'connected';
    case PEER_CONNECTION_STATES.CONNECTING:
      return 'connecting';
    case PEER_CONNECTION_STATES.FAILED:
      return 'failed';
    default:
      return 'connecting';
  }
}

/**
 * Render the complete SVG topology graph markup.
 *
 * @param {object} graphData - Computed graph data
 * @param {string|null} selectedPeerId - Currently selected node ID ('local' or remoteSessionId)
 * @param {Map} activityMap - Map of peerSessionId -> { type, direction, timestamp }
 * @returns {string} SVG markup string
 */
export function renderTopologySvg(graphData, selectedPeerId = null, activityMap = new Map()) {
  const { localNode, remoteNodes, edges } = graphData;

  // 1. Defs and markers
  const defsHtml = `
    <defs>
      <!-- Radar grid pattern -->
      <pattern id="topoGrid" width="30" height="30" patternUnits="userSpaceOnUse">
        <circle cx="15" cy="15" r="0.8" fill="rgba(255, 255, 255, 0.08)" />
      </pattern>

      <!-- Pulse glows -->
      <filter id="glowDirect" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="3" result="blur" />
        <feComposite in="SourceGraphic" in2="blur" operator="over" />
      </filter>
      <filter id="glowRelay" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="3" result="blur" />
        <feComposite in="SourceGraphic" in2="blur" operator="over" />
      </filter>

      <!-- Local node gradient -->
      <linearGradient id="gradLocal" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#818cf8" />
        <stop offset="100%" stop-color="#4f46e5" />
      </linearGradient>

      <!-- Remote node gradient -->
      <linearGradient id="gradRemote" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#1e293b" />
        <stop offset="100%" stop-color="#0f172a" />
      </linearGradient>
    </defs>
  `;

  // 2. Background radar grid
  const backgroundHtml = `
    <rect width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" fill="#0b0e17" rx="10" />
    <rect width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" fill="url(#topoGrid)" rx="10" />
    <circle cx="${CANVAS_WIDTH / 2}" cy="150" r="140" fill="none" stroke="rgba(255, 255, 255, 0.03)" stroke-width="1" stroke-dasharray="4 4" />
  `;

  // 3. Edges
  let edgesHtml = '';
  edges.forEach((edge) => {
    const isSelected = selectedPeerId === edge.peerSessionId;
    const isRelay = edge.isRelay;
    const strokeColor =
      edge.status === 'connected'
        ? isRelay ? '#a855f7' : '#10b981'
        : edge.status === 'connecting'
        ? '#38bdf8'
        : edge.status === 'reconnecting'
        ? '#f59e0b'
        : edge.status === 'failed'
        ? '#ef4444'
        : '#64748b';

    const dashArray =
      edge.status === 'connecting'
        ? '6 4'
        : edge.status === 'reconnecting'
        ? '5 5'
        : edge.status === 'failed'
        ? '2 4'
        : 'none';

    // Activity indicator
    const activity = activityMap.get(edge.peerSessionId);
    const hasActiveTraffic = activity && (Date.now() - activity.timestamp < 1200);

    const midX = Math.round((edge.x1 + edge.x2) / 2);
    const midY = Math.round((edge.y1 + edge.y2) / 2);

    edgesHtml += `
      <g class="topo-edge-group" data-edge-id="${edge.id}">
        <!-- Base edge line -->
        <line
          x1="${edge.x1}" y1="${edge.y1}"
          x2="${edge.x2}" y2="${edge.y2}"
          stroke="${strokeColor}"
          stroke-width="${isSelected ? 3.5 : 2}"
          stroke-dasharray="${dashArray}"
          class="topo-edge-line ${edge.status} ${hasActiveTraffic ? 'traffic-active' : ''}"
        />

        <!-- Real-time activity pulse packet (respects prefers-reduced-motion in CSS) -->
        ${hasActiveTraffic ? `
          <circle
            cx="${midX}" cy="${midY}" r="4"
            fill="${activity.type === 'file' ? '#38bdf8' : '#a78bfa'}"
            class="topo-activity-packet"
          />
        ` : ''}

        <!-- Midpoint badge for link candidate type / RTT if connected -->
        ${edge.status === 'connected' ? `
          <g transform="translate(${midX}, ${midY})" class="topo-edge-badge">
            <rect x="-24" y="-9" width="48" height="18" rx="4" fill="#0f172a" stroke="${strokeColor}" stroke-width="1" />
            <text x="0" y="3" text-anchor="middle" font-size="9" font-family="JetBrains Mono, monospace" fill="#e2e8f0">
              ${isRelay ? 'TURN' : 'P2P'}
            </text>
          </g>
        ` : ''}
      </g>
    `;
  });

  // 4. Remote nodes
  let remoteNodesHtml = '';
  remoteNodes.forEach((node) => {
    remoteNodesHtml += renderNodeElement(node, selectedPeerId === node.id);
  });

  // 5. Local node ("You")
  const localNodeHtml = renderNodeElement(localNode, selectedPeerId === 'local');

  // 6. Empty state overlay if zero remote peers
  let emptyStateHtml = '';
  if (remoteNodes.length === 0) {
    emptyStateHtml = `
      <g class="topo-empty-state" transform="translate(${CANVAS_WIDTH / 2}, 240)">
        <text text-anchor="middle" font-size="12" font-family="Inter, sans-serif" fill="#94a3b8" font-weight="500">
          Waiting for peers to join mesh network... (1/4 devices)
        </text>
        <text text-anchor="middle" y="20" font-size="11" font-family="Inter, sans-serif" fill="#64748b">
          Share the room code or invite link to establish direct P2P connections.
        </text>
      </g>
    `;
  }

  return `
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}"
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      class="topo-svg-canvas"
      role="img"
      aria-label="Live Mesh Network Topology Map"
    >
      ${defsHtml}
      ${backgroundHtml}
      <g class="topo-edges-layer">${edgesHtml}</g>
      <g class="topo-nodes-layer">
        ${localNodeHtml}
        ${remoteNodesHtml}
      </g>
      ${emptyStateHtml}
    </svg>
  `;
}

function renderNodeElement(node, isSelected) {
  const statusColor =
    node.status === 'connected'
      ? '#10b981'
      : node.status === 'connecting'
      ? '#38bdf8'
      : node.status === 'reconnecting'
      ? '#f59e0b'
      : node.status === 'failed'
      ? '#ef4444'
      : '#64748b';

  const isLocal = node.isLocal;
  const radius = 22;

  return `
    <g
      class="topo-node ${isLocal ? 'node-local' : 'node-remote'} ${node.status} ${isSelected ? 'node-selected' : ''}"
      transform="translate(${node.x}, ${node.y})"
      data-peer-id="${escapeHtml(node.id)}"
      role="button"
      tabindex="0"
      aria-label="${escapeHtml(node.label)} (${escapeHtml(node.sublabel)}), Status: ${escapeHtml(node.status)}"
      aria-pressed="${Boolean(isSelected)}"
    >
      <!-- Selection ring -->
      ${isSelected ? `
        <circle r="${radius + 7}" fill="none" stroke="#60a5fa" stroke-width="2" stroke-dasharray="3 3" class="topo-selection-halo" />
      ` : ''}

      <!-- Outer status ring -->
      <circle r="${radius + 3}" fill="none" stroke="${statusColor}" stroke-width="2" opacity="0.85" class="topo-status-ring" />

      <!-- Node base disc -->
      <circle r="${radius}" fill="url(${isLocal ? '#gradLocal' : '#gradRemote'})" stroke="${isLocal ? '#818cf8' : '#334155'}" stroke-width="1.5" />

      <!-- Center icon glyph -->
      ${isLocal ? `
        <!-- Local device glyph (host/guest terminal) -->
        <g transform="translate(-8, -8)" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="3" width="12" height="8" rx="1.5" />
          <line x1="5" y1="14" x2="11" y2="14" />
        </g>
      ` : `
        <!-- Remote peer glyph -->
        <g transform="translate(-8, -8)" fill="none" stroke="#94a3b8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="8" cy="6" r="3" />
          <path d="M3 14c0-2.5 2.5-4 5-4s5 1.5 5 4" />
        </g>
      `}

      <!-- Status dot badge -->
      <circle cx="${radius - 3}" cy="${-radius + 3}" r="4" fill="${statusColor}" stroke="#0b0e17" stroke-width="1.5" />

      <!-- Node Title Label -->
      <text
        x="0" y="${radius + 15}"
        text-anchor="middle"
        font-size="11"
        font-weight="600"
        font-family="Inter, sans-serif"
        fill="#f8fafc"
        class="topo-node-title"
      >
        ${escapeHtml(node.label)}
      </text>

      <!-- Role & Status Sublabel -->
      <text
        x="0" y="${radius + 27}"
        text-anchor="middle"
        font-size="9.5"
        font-family="JetBrains Mono, monospace"
        fill="#94a3b8"
        class="topo-node-sublabel"
      >
        ${escapeHtml(node.sublabel)} · ${escapeHtml(node.status)}
      </text>
    </g>
  `;
}

/**
 * Render compact detail inspector card for selected peer.
 * Guarantees unavailable diagnostics display "—" and never exposes secrets.
 *
 * @param {object} selectedInfo - Selected peer or local device details
 * @returns {string} HTML markup for inspector card
 */
export function renderPeerDetailCard(selectedInfo) {
  if (!selectedInfo) {
    return `
      <div class="topo-detail-empty">
        <span class="topo-detail-hint">Select a participant node above to inspect real-time link diagnostics.</span>
      </div>
    `;
  }

  const isLocal = selectedInfo.isLocal;
  const diag = selectedInfo.diagnostics || {};
  const peerService = selectedInfo.peerService || null;

  const roleText = selectedInfo.role === 'host' ? 'Host (Creator)' : 'Guest (Participant)';
  const labelText = isLocal ? 'Local Device (You)' : selectedInfo.label;
  const statusText = selectedInfo.status ? selectedInfo.status.toUpperCase() : '—';

  // Format safe values without fabrications
  const rttText = typeof diag.roundTripTimeMs === 'number' ? `${diag.roundTripTimeMs} ms` : '—';
  const candTypeText = diag.selectedCandidateType
    ? diag.selectedCandidateType === 'relay'
      ? 'Relay (TURN)'
      : diag.selectedCandidateType === 'srflx'
      ? 'Reflexive (STUN NAT)'
      : diag.selectedCandidateType === 'host'
      ? 'Host (Direct LAN)'
      : diag.selectedCandidateType
    : '—';

  const bytesSentText = typeof diag.bytesSent === 'number' && diag.bytesSent > 0
    ? formatFileSize(diag.bytesSent)
    : (typeof diag.bytesSent === 'number' && diag.bytesSent === 0 ? '0 Bytes' : '—');

  const bytesRecvText = typeof diag.bytesReceived === 'number' && diag.bytesReceived > 0
    ? formatFileSize(diag.bytesReceived)
    : (typeof diag.bytesReceived === 'number' && diag.bytesReceived === 0 ? '0 Bytes' : '—');

  const chatChannelText = peerService
    ? (peerService.isChatReady() ? 'OPEN (P2P Active)' : (peerService.dataChannelState || '—').toUpperCase())
    : (isLocal ? 'READY' : '—');

  const fileChannelText = peerService
    ? (peerService.isFileChannelReady() ? 'OPEN (Streaming)' : (peerService.fileChannelState || '—').toUpperCase())
    : (isLocal ? 'READY' : '—');

  const iceStateText = (diag.iceConnectionState || (peerService?.pc?.iceConnectionState) || '—').toUpperCase();
  const reconnectRetriesText = typeof diag.reconnectAttempts === 'number'
    ? `${diag.reconnectAttempts} / ${diag.maxReconnectAttempts || 3}`
    : '—';

  return `
    <div class="topo-detail-card" role="region" aria-label="Participant Diagnostics Detail">
      <div class="topo-detail-header">
        <div class="topo-detail-identity">
          <span class="topo-detail-title">${escapeHtml(labelText)}</span>
          <span class="topo-detail-badge ${selectedInfo.status}">${escapeHtml(statusText)}</span>
        </div>
        <span class="topo-detail-role">${escapeHtml(roleText)}</span>
      </div>

      <div class="topo-detail-grid">
        <div class="topo-metric">
          <span class="metric-label">Connection State</span>
          <span class="metric-val ${selectedInfo.status === 'connected' ? 'val-good' : ''}">
            ${escapeHtml(selectedInfo.status ? selectedInfo.status.toUpperCase() : '—')}
          </span>
        </div>

        <div class="topo-metric">
          <span class="metric-label">DataChannel (Chat)</span>
          <span class="metric-val ${chatChannelText.startsWith('OPEN') ? 'val-good' : ''}">
            ${escapeHtml(chatChannelText)}
          </span>
        </div>

        <div class="topo-metric">
          <span class="metric-label">DataChannel (Files)</span>
          <span class="metric-val ${fileChannelText.startsWith('OPEN') ? 'val-good' : ''}">
            ${escapeHtml(fileChannelText)}
          </span>
        </div>

        <div class="topo-metric">
          <span class="metric-label">Candidate Type</span>
          <span class="metric-val ${diag.isRelay ? 'val-relay' : (candTypeText !== '—' ? 'val-direct' : '')}">
            ${escapeHtml(candTypeText)}
          </span>
        </div>

        <div class="topo-metric">
          <span class="metric-label">Round-Trip Latency</span>
          <span class="metric-val font-mono">${escapeHtml(rttText)}</span>
        </div>

        <div class="topo-metric">
          <span class="metric-label">ICE State</span>
          <span class="metric-val font-mono">${escapeHtml(iceStateText)}</span>
        </div>

        <div class="topo-metric">
          <span class="metric-label">Traffic Sent</span>
          <span class="metric-val font-mono">${escapeHtml(bytesSentText)}</span>
        </div>

        <div class="topo-metric">
          <span class="metric-label">Traffic Received</span>
          <span class="metric-val font-mono">${escapeHtml(bytesRecvText)}</span>
        </div>

        <div class="topo-metric">
          <span class="metric-label">Recovery Retries</span>
          <span class="metric-val font-mono">${escapeHtml(reconnectRetriesText)}</span>
        </div>

        <div class="topo-metric metric-privacy">
          <span class="metric-label">Privacy Shield</span>
          <span class="metric-val val-shielded">IP Addresses & Tokens Masked</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render the full Topology Section container markup.
 *
 * @param {object} currentState - Application state
 * @returns {string} HTML markup string
 */
export function renderTopologySection(currentState) {
  return `
    <div id="mesh-topology-panel" class="mesh-topology-section" role="region" aria-labelledby="mesh-topology-heading">
      <!-- Section Header -->
      <div class="topo-panel-header">
        <div class="topo-title-group">
          <span class="topo-status-dot"></span>
          <h3 id="mesh-topology-heading" class="topo-title">Live Mesh Topology</h3>
          <span class="topo-pill" id="topo-counter-pill">1/4 Devices · 0 Links</span>
        </div>
        <div class="topo-header-actions">
          <button type="button" id="topo-toggle-btn" class="btn btn-ghost btn-xs" aria-expanded="true" aria-controls="topo-panel-body">
            <span class="topo-toggle-text">Collapse</span>
          </button>
        </div>
      </div>

      <!-- Collapsible Body -->
      <div id="topo-panel-body" class="topo-panel-body">
        <!-- SVG Canvas Host -->
        <div id="topo-canvas-host" class="topo-canvas-host">
          <!-- Dynamically populated by renderTopologySvg -->
        </div>

        <!-- Legend Bar -->
        <div class="topo-legend-bar" role="note" aria-label="Network topology status legend">
          <span class="legend-item"><span class="legend-swatch direct"></span>Direct P2P</span>
          <span class="legend-item"><span class="legend-swatch relay"></span>TURN Relay</span>
          <span class="legend-item"><span class="legend-swatch connecting"></span>Connecting</span>
          <span class="legend-item"><span class="legend-swatch reconnecting"></span>Reconnecting</span>
          <span class="legend-item"><span class="legend-swatch failed"></span>Failed</span>
          <span class="legend-item"><span class="legend-swatch activity"></span>Traffic Pulse</span>
        </div>

        <!-- Detail Inspector Card -->
        <div id="topo-inspector-host" class="topo-inspector-host">
          <!-- Dynamically populated by renderPeerDetailCard -->
        </div>
      </div>
    </div>
  `;
}
