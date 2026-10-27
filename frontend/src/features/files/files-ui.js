/**
 * PairPort File Transfer UI Component
 * Layout and markup for the real-time P2P file hub, drop zone,
 * recipient selector (Phase 3 multi-recipient), active transfer panel,
 * and session files list.
 */

import { icons } from '../../components/icons.js';
import { state } from '../../state/app-state.js';
import {
  peerConnectionService,
  DATA_CHANNEL_STATES,
} from '../../services/peer-connection.js';
import { peerRegistry } from '../../services/peer-registry.js';
import {
  formatFileSize,
  escapeHtml,
} from '../../utils/ui-helpers.js';

/**
 * Render the recipient selection panel for multi-recipient file transfers.
 *
 * @param {object} [currentState=state] - Current application state
 * @param {object} [registry=peerRegistry] - Peer registry service
 * @returns {string} HTML markup string
 */
export function renderRecipientSelector(currentState = state, registry = peerRegistry) {
  const mySessionId = registry?.mySessionId || currentState?.realSessionId || null;
  const myRole = registry?.myRole || currentState?.realRole || 'host';

  // Gather remote peers from authoritative roster or active peers
  const regRoster = typeof registry?.getRoster === 'function' ? registry.getRoster() : null;
  const roster = (Array.isArray(regRoster) && regRoster.length > 0)
    ? regRoster
    : (currentState?.participants || []);
  const remotePeersMap = new Map();

  if (Array.isArray(roster)) {
    roster.forEach((p) => {
      if (p && p.session_id && p.session_id !== mySessionId && p.status !== 'removed') {
        remotePeersMap.set(p.session_id, {
          id: p.session_id,
          role: p.role || 'guest',
          status: p.status || 'connected',
        });
      }
    });
  }

  // Include any peers from registry not yet in roster
  if (registry && typeof registry.getPeerIds === 'function') {
    registry.getPeerIds().forEach((id) => {
      if (id !== mySessionId && !remotePeersMap.has(id)) {
        const p = registry.getPeer(id);
        remotePeersMap.set(id, {
          id,
          role: p?.role || 'guest',
          status: p?.connectionState === 'closed' ? 'disconnected' : 'connected',
        });
      }
    });
  }

  const remotePeers = Array.from(remotePeersMap.values()).sort((a, b) =>
    String(a.id).localeCompare(String(b.id))
  );

  const selectedIds = new Set(currentState?.selectedRecipientIds || []);

  // Compute readiness for each remote peer
  let readyPeersCount = 0;
  const peerCards = remotePeers.map((peer) => {
    const peerService = registry?.getPeer ? registry.getPeer(peer.id) : null;
    const isReady = Boolean(peerService && typeof peerService.isFileChannelReady === 'function' && peerService.isFileChannelReady());
    if (isReady) readyPeersCount++;

    const isConnecting = Boolean(peerService && peerService.connectionState === 'connecting');
    const isFailed = Boolean(peerService && peerService.connectionState === 'failed');

    const readinessClass = isReady
      ? 'status-ready'
      : isConnecting
      ? 'status-connecting'
      : isFailed
      ? 'status-failed'
      : 'status-unready';

    const readinessLabel = isReady
      ? 'Ready'
      : isConnecting
      ? 'Connecting...'
      : isFailed
      ? 'Failed'
      : 'Not Ready';

    // Auto-select in 2-person mode if only 1 remote peer and no explicit selection state
    const isSelected = selectedIds.has(peer.id) || (remotePeers.length === 1 && selectedIds.size === 0 && isReady);
    const safePeerLabel = `Peer ${String(peer.id).slice(0, 8)}`;
    const roleLabel = peer.role === 'host' ? 'Host' : 'Guest';

    return `
      <label class="recipient-chip ${isSelected ? 'selected' : ''} ${!isReady ? 'disabled' : ''}" data-peer-id="${escapeHtml(peer.id)}">
        <input
          type="checkbox"
          class="recipient-checkbox"
          value="${escapeHtml(peer.id)}"
          data-peer-id="${escapeHtml(peer.id)}"
          ${isSelected ? 'checked' : ''}
          ${!isReady ? 'disabled' : ''}
          aria-label="${escapeHtml(safePeerLabel)} (${roleLabel}) - ${readinessLabel}"
        />
        <span class="recipient-indicator-dot ${readinessClass}"></span>
        <span class="recipient-name">${escapeHtml(safePeerLabel)}</span>
        <span class="recipient-role-badge">${escapeHtml(roleLabel)}</span>
        <span class="recipient-status-tag ${readinessClass}">${readinessLabel}</span>
      </label>
    `;
  });

  // Calculate selection counts
  const effectiveSelectedCount = selectedIds.size > 0
    ? selectedIds.size
    : (remotePeers.length === 1 && readyPeersCount === 1 ? 1 : 0);

  const selectedReadyCount = Array.from(selectedIds).filter((id) => {
    const ps = registry?.getPeer ? registry.getPeer(id) : null;
    return Boolean(ps && typeof ps.isFileChannelReady === 'function' && ps.isFileChannelReady());
  }).length + (selectedIds.size === 0 && remotePeers.length === 1 && readyPeersCount === 1 ? 1 : 0);

  // Notice banners
  let noticeHtml = '';
  if (remotePeers.length === 0) {
    noticeHtml = `
      <div class="recipient-notice standby">
        ${icons.wifi(14)}
        <span>Awaiting peers to join the room before selecting file recipients.</span>
      </div>
    `;
  } else if (effectiveSelectedCount === 0) {
    noticeHtml = `
      <div class="recipient-notice warning">
        ${icons.info(14)}
        <span>No recipients selected. Select at least one connected peer above to enable file transfer.</span>
      </div>
    `;
  } else if (selectedReadyCount === 0) {
    noticeHtml = `
      <div class="recipient-notice waiting">
        ${icons.refresh(14)}
        <span>Selected recipient's WebRTC file channel is not open yet. Waiting for P2P connection...</span>
      </div>
    `;
  }

  const hasConnectedPeers = readyPeersCount > 0;

  return `
    <div id="file-recipient-selector" class="file-recipient-selector" role="region" aria-label="File Transfer Recipients">
      <div class="recipient-selector-header">
        <div class="recipient-title-group">
          <span class="recipient-eyebrow">RECIPIENTS</span>
          <span class="recipient-count-badge">${selectedReadyCount}/${remotePeers.length} Ready</span>
        </div>
        <div class="recipient-actions">
          <button type="button" id="select-all-recipients-btn" class="btn btn-ghost btn-xs" ${!hasConnectedPeers ? 'disabled' : ''} title="Select all connected peers">
            Select All
          </button>
          <button type="button" id="deselect-all-recipients-btn" class="btn btn-ghost btn-xs" ${effectiveSelectedCount === 0 ? 'disabled' : ''} title="Deselect all recipients">
            Deselect
          </button>
        </div>
      </div>

      <div class="recipients-list" role="group" aria-label="Available recipients list">
        <!-- Local User Tag -->
        <div id="local-sender-chip" class="recipient-chip local" title="You (Local Sender)">
          <span class="recipient-indicator-dot local"></span>
          <span class="recipient-name">You (Sender)</span>
          <span class="recipient-role-badge">${myRole === 'host' ? 'Host' : 'Guest'}</span>
          <span class="recipient-status-tag local">Sender</span>
        </div>
        <!-- Remote Peers -->
        ${peerCards.join('')}
      </div>

      ${noticeHtml}
    </div>
  `;
}

/**
 * Render the active transfer progress card or standby station.
 * Supports multiple concurrent active transfers across different recipients.
 *
 * @param {object} [currentState=state] - Current application state
 * @param {boolean} [isReady=peerConnectionService.isFileChannelReady()] - Whether file DataChannel is open
 * @returns {string} HTML markup
 */
export function renderActiveTransferPanel(
  currentState = state,
  isReady = (peerRegistry.isFileChannelReady() || peerConnectionService.isFileChannelReady())
) {
  // Find all in-flight transfers (sending or receiving)
  const inFlightTransfers = (currentState?.realFiles || []).filter(
    (f) => f.status === 'sending' || f.status === 'receiving' || f.status === 'waiting'
  );

  // Fallback to currentState.activeTransfer if realFiles has no in-flight (for backward compat with test mocks)
  const transfersToRender = inFlightTransfers.length > 0
    ? inFlightTransfers
    : (currentState?.activeTransfer ? [currentState.activeTransfer] : []);

  if (transfersToRender.length === 0) {
    return `
      <div id="active-transfer-panel" class="active-transfer-panel standby">
        <div class="transfer-panel-header">
          <span class="panel-eyebrow">CHUNKED STREAMING STATION</span>
          <span class="speed-indicator ${isReady ? 'status-completed' : ''}">${isReady ? 'P2P Ready (Standby)' : 'Awaiting Peer'}</span>
        </div>
        <div class="standby-transfer-notice">
          <span class="standby-icon">${icons.upload(20)}</span>
          <p class="standby-text">
            ${isReady
              ? 'Ready to stream files directly to your peer. Drop or browse files above (up to 100 MB).'
              : 'Direct WebRTC data channels will activate here once paired with a room peer.'}
          </p>
        </div>
      </div>
    `;
  }

  // Single active transfer:
  if (transfersToRender.length === 1) {
    const active = transfersToRender[0];
    const isOutgoing = active.direction === 'outgoing';
    const transferredStr = formatFileSize(active.transferredBytes || 0);
    const totalStr = formatFileSize(active.totalBytes || active.size || 0);
    const percent = active.progress || 0;
    const statusLabel = active.status ? active.status.toUpperCase() : 'TRANSFERRING';
    const safeActiveName = typeof active.name === 'string' ? active.name : 'unnamed_file';
    const isZip = safeActiveName.endsWith('.zip');
    const peerDisplay = active.peerLabel || (active.peerSessionId ? `Peer ${String(active.peerSessionId).slice(0, 8)}` : null);

    return `
      <div id="active-transfer-panel" class="active-transfer-panel active">
        <div class="transfer-panel-header">
          <span class="panel-eyebrow">${isOutgoing ? 'STREAMING DIRECTLY TO PEER (SCTP)' : 'RECEIVING DIRECTLY FROM PEER'}</span>
          <span class="speed-indicator">${statusLabel} · ${percent}%</span>
        </div>

        <div class="transfer-item sample-active">
          <div class="transfer-info-row">
            <div class="file-badge">
              ${isZip ? icons.fileZip(18) : icons.file(18)}
            </div>
            <div class="file-meta">
              <span class="file-name" title="${escapeHtml(safeActiveName)}">${escapeHtml(safeActiveName)}</span>
              <span class="file-status-sub">
                ${isOutgoing ? 'Chunked upload' : 'Chunked download'}${peerDisplay ? ` · ${escapeHtml(peerDisplay)}` : ''} · ${transferredStr} of ${totalStr}
              </span>
            </div>
            <button type="button" class="btn btn-ghost btn-xs cancel-active-transfer-btn" data-id="${active.id}" title="Cancel this transfer">
              ${icons.x(14)}
              <span>Cancel</span>
            </button>
          </div>

          <div class="progress-bar-container" role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100">
            <div class="progress-bar-fill animated" style="width: ${percent}%"></div>
          </div>

          <div class="transfer-stats-row">
            <span>${transferredStr} / ${totalStr} (${active.totalChunks || 1} chunks)</span>
            <span class="p2p-direct-tag">${icons.shield(12)} Zero server relay</span>
          </div>
        </div>
      </div>
    `;
  }

  // Multiple active transfers:
  return `
    <div id="active-transfer-panel" class="active-transfer-panel active multi-active">
      <div class="transfer-panel-header">
        <span class="panel-eyebrow">STREAMING TO MULTIPLE RECIPIENTS (${transfersToRender.length} IN-FLIGHT)</span>
        <button type="button" id="cancel-all-transfers-btn" class="btn btn-outline-danger btn-xs" title="Cancel all active transfers">
          ${icons.x(12)}
          <span>Cancel All</span>
        </button>
      </div>

      <div class="multi-transfers-list">
        ${transfersToRender.map((active) => {
          const isOutgoing = active.direction === 'outgoing';
          const transferredStr = formatFileSize(active.transferredBytes || 0);
          const totalStr = formatFileSize(active.totalBytes || active.size || 0);
          const percent = active.progress || 0;
          const statusLabel = active.status ? active.status.toUpperCase() : 'TRANSFERRING';
          const safeActiveName = typeof active.name === 'string' ? active.name : 'unnamed_file';
          const isZip = safeActiveName.endsWith('.zip');
          const peerDisplay = active.peerLabel || (active.peerSessionId ? `Peer ${String(active.peerSessionId).slice(0, 8)}` : 'Peer');

          return `
            <div class="transfer-item sample-active multi-item" data-id="${active.id}">
              <div class="transfer-info-row">
                <div class="file-badge">
                  ${isZip ? icons.fileZip(18) : icons.file(18)}
                </div>
                <div class="file-meta">
                  <div class="file-title-group">
                    <span class="file-name" title="${escapeHtml(safeActiveName)}">${escapeHtml(safeActiveName)}</span>
                    <span class="peer-target-tag">${isOutgoing ? 'To:' : 'From:'} ${escapeHtml(peerDisplay)}</span>
                  </div>
                  <span class="file-status-sub">
                    ${statusLabel} · ${percent}% · ${transferredStr} of ${totalStr}
                  </span>
                </div>
                <button type="button" class="btn btn-ghost btn-xs cancel-active-transfer-btn" data-id="${active.id}" title="Cancel this transfer">
                  ${icons.x(14)}
                  <span>Cancel</span>
                </button>
              </div>

              <div class="progress-bar-container" role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100">
                <div class="progress-bar-fill animated" style="width: ${percent}%"></div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

/**
 * Render the session files list items with status badges, progress, recipient attribution, and download/cancel actions.
 *
 * @param {Array} [files=state.realFiles] - Array of file transfer records
 * @returns {string} HTML markup
 */
export function renderFilesList(files = (state.realFiles || [])) {
  if (!files || files.length === 0) {
    return `
      <li class="empty-files-item">
        <div class="empty-state-box">
          <div class="empty-state-icon">
            ${icons.upload(24)}
          </div>
          <p class="empty-state-title">No files transferred yet</p>
          <p class="empty-state-desc">Files transferred between you and your peer in this session will appear here. Zero bytes are saved on any server.</p>
        </div>
      </li>
    `;
  }

  return files.map((file) => {
    const isCompleted = file.status === 'completed';
    const isSending = file.status === 'sending';
    const isReceiving = file.status === 'receiving';
    const isFailed = file.status === 'failed';
    const isCancelled = file.status === 'cancelled';
    const isOutgoing = file.direction === 'outgoing';
    const directionLabel = isOutgoing ? 'Sent' : 'Received';
    const formattedSize = typeof file.size === 'number' ? formatFileSize(file.size) : file.size;
    const safeFileName = typeof file.name === 'string' ? file.name : 'unnamed_file';
    const isZip = safeFileName.endsWith('.zip');
    const peerDisplay = file.peerLabel || (file.peerSessionId ? `Peer ${String(file.peerSessionId).slice(0, 8)}` : null);

    const directionBadge = isOutgoing
      ? `<span class="file-direction-badge sent">${icons.arrowUp(12)} Sent</span>`
      : `<span class="file-direction-badge received">${icons.arrowDown(12)} Received</span>`;

    let statusBadgeHtml = '';
    let actionBtnHtml = '';

    // Enforce blob: scheme strictly for download URLs
    const safeBlobUrl = (typeof file.blobUrl === 'string' && file.blobUrl.startsWith('blob:')) ? file.blobUrl : null;

    if (isCompleted) {
      if (!isOutgoing && safeBlobUrl) {
        statusBadgeHtml = `<span class="status-completed">${icons.check(12)} Received (100%)</span>`;
        actionBtnHtml = `
          <a href="${safeBlobUrl}" download="${escapeHtml(safeFileName)}" class="btn btn-primary btn-xs file-action-btn" title="Save file to computer">
            ${icons.download(14)}
            <span>Save</span>
          </a>
        `;
      } else {
        statusBadgeHtml = `<span class="status-completed">${icons.check(12)} Delivered (100%)</span>`;
        actionBtnHtml = `
          <span class="badge badge-success" title="Delivered directly to peer">
            ${icons.check(12)} Delivered
          </span>
        `;
      }
    } else if (isSending || isReceiving) {
      statusBadgeHtml = `<span class="status-transferring">${directionLabel} (${file.progress || 0}%)</span>`;
      actionBtnHtml = `
        <button type="button" class="btn btn-ghost btn-xs file-action-btn" data-action="cancel" data-id="${file.id}" title="Cancel transfer">
          ${icons.x(14)}
          <span>Cancel</span>
        </button>
      `;
    } else if (isFailed) {
      statusBadgeHtml = `<span class="status-failed">${icons.x(12)} Failed</span>`;
      actionBtnHtml = `
        <span class="badge badge-error" title="${escapeHtml(file.error || 'Transfer failed')}">
          Failed
        </span>
      `;
    } else if (isCancelled) {
      statusBadgeHtml = `<span class="status-cancelled">Cancelled</span>`;
      actionBtnHtml = `
        <span class="badge badge-warning">Cancelled</span>
      `;
    } else {
      statusBadgeHtml = `<span class="status-waiting">Waiting...</span>`;
      actionBtnHtml = `<span class="badge badge-subtle">Queued</span>`;
    }

    return `
      <li class="file-item ${isOutgoing ? 'sent' : 'received'}" data-id="${file.id}">
        <div class="file-item-icon">
          ${isZip ? icons.fileZip(20) : icons.file(20)}
        </div>
        <div class="file-item-info">
          <div class="file-item-name" title="${escapeHtml(safeFileName)}">${escapeHtml(safeFileName)}</div>
          <div class="file-item-meta">
            ${directionBadge}
            ${peerDisplay ? `
              <span class="dot-separator">·</span>
              <span class="peer-target-badge" title="${isOutgoing ? 'Recipient' : 'Sender'}">${isOutgoing ? 'To: ' : 'From: '}${escapeHtml(peerDisplay)}</span>
            ` : ''}
            <span class="dot-separator">·</span>
            <span>${formattedSize}</span>
            <span class="dot-separator">·</span>
            ${statusBadgeHtml}
            <span class="p2p-direct-tag">[P2P]</span>
          </div>
        </div>
        <div class="file-item-action">
          ${actionBtnHtml}
        </div>
      </li>
    `;
  }).join('');
}

/**
 * Render the complete Left Column of the workspace grid (File Transfer Hub).
 *
 * @param {object} [currentState=state] - Current application state
 * @param {boolean} [isReady=peerConnectionService.isFileChannelReady()] - Whether file DataChannel is open
 * @returns {string} HTML markup
 */
export function renderFileHubColumn(
  currentState = state,
  isReady = (peerRegistry.isFileChannelReady() || peerConnectionService.isFileChannelReady())
) {
  const isFileChannelOpen =
    (currentState && currentState.fileChannelState === DATA_CHANNEL_STATES.OPEN) || isReady;
  const files = currentState && currentState.realFiles ? currentState.realFiles : [];

  return `
    <div class="workspace-column file-hub-column">
      <div class="column-header">
        <div class="column-title-group">
          <span class="col-icon">${icons.upload(18)}</span>
          <h3 class="column-title">P2P File Transfer</h3>
        </div>
        <span id="file-channel-badge" class="badge ${isFileChannelOpen ? 'badge-success' : 'badge-subtle'}">
          ${isFileChannelOpen ? 'P2P FileChannel Open' : 'Waiting for Peer'}
        </span>
      </div>

      <!-- Phase 3: Recipient Selector -->
      <div id="file-recipient-selector-container">
        ${renderRecipientSelector(currentState, peerRegistry)}
      </div>

      <!-- Drag & Drop Zone -->
      <div id="file-drop-zone" class="drop-zone ${!isFileChannelOpen ? 'drop-zone-disabled' : ''}" tabindex="0" role="region" aria-label="File drop zone">
        <input type="file" id="file-browse-input" multiple class="sr-only" aria-label="Upload files" ${!isFileChannelOpen ? 'disabled' : ''} />
        <div class="drop-zone-icon">
          ${icons.upload(36)}
        </div>
        <p class="drop-zone-title">${isFileChannelOpen ? 'Drop files here to share directly' : 'Connect to a peer to enable file transfers'}</p>
        <p class="drop-zone-sub">or <button type="button" id="browse-files-btn" class="btn-link" ${!isFileChannelOpen ? 'disabled' : ''}>browse from your computer</button></p>
        <div class="drop-zone-footer">
          <span>${icons.shield(14)} Direct P2P chunked streaming · Max 100 MB · Zero cloud storage</span>
        </div>
      </div>

      <!-- Active Transfer Panel Container -->
      <div id="active-transfer-container">
        ${renderActiveTransferPanel(currentState, isReady)}
      </div>

      <!-- Session Files List -->
      <div class="files-list-section">
        <div class="files-list-header">
          <h4 class="list-heading">Session Files (Live)</h4>
          <div class="files-header-actions">
            <span id="files-count-badge" class="badge badge-neutral">${files.length} items</span>
            <button type="button" id="clear-files-btn" class="btn-clear-history" title="Clear transfer records from session" ${files.length === 0 ? 'disabled' : ''}>
              ${icons.trash(14)}
              <span>Clear History</span>
            </button>
          </div>
        </div>

        <ul id="files-list" class="files-list" role="list">
          ${renderFilesList(files)}
        </ul>
      </div>
    </div>
  `;
}

/**
 * Update dynamic file transfer badges, recipient selector, dropzone states, active panel, files list, and counts.
 *
 * @param {HTMLElement} root - Root container element
 * @param {object} [currentState=state] - Current application state
 * @param {boolean} [isReady=peerConnectionService.isFileChannelReady()] - Whether file DataChannel is open
 */
export function updateFilesUI(
  root,
  currentState = state,
  isReady = (peerRegistry.isFileChannelReady() || peerConnectionService.isFileChannelReady())
) {
  if (!root) return;

  const isFileChannelOpen =
    (currentState && currentState.fileChannelState === DATA_CHANNEL_STATES.OPEN) || isReady;

  // Determine remote peers from roster or registry
  const mySessionId = peerRegistry?.mySessionId || currentState?.realSessionId || null;
  const roster = peerRegistry?.getRoster ? peerRegistry.getRoster() : (currentState?.participants || []);
  const remotePeers = Array.isArray(roster)
    ? roster.filter((p) => p && p.session_id && p.session_id !== mySessionId && p.status !== 'removed')
    : [];

  const selectedIds = new Set(currentState?.selectedRecipientIds || []);

  // Determine if at least one selected recipient is ready
  let hasReadyRecipient = false;
  if (remotePeers.length <= 1) {
    // 2-person legacy mode or single-peer mock: auto-select single peer if ready
    hasReadyRecipient = isReady;
  } else if (selectedIds.size > 0) {
    for (const sid of selectedIds) {
      const p = peerRegistry?.getPeer ? peerRegistry.getPeer(sid) : null;
      if (p && typeof p.isFileChannelReady === 'function' && p.isFileChannelReady()) {
        hasReadyRecipient = true;
        break;
      }
    }
  }

  const isFileTransferAllowed =
    hasReadyRecipient &&
    !currentState?.isPeerDisconnected &&
    !currentState?.isSignalingReconnecting &&
    !currentState?.isReconnecting;
  const files = currentState && currentState.realFiles ? currentState.realFiles : [];

  // Update file channel badge
  const badge = root.querySelector('#file-channel-badge');
  if (badge) {
    badge.className = `badge ${isFileChannelOpen ? 'badge-success' : 'badge-subtle'}`;
    badge.textContent = isFileChannelOpen
      ? 'P2P FileChannel Open'
      : currentState?.isPeerDisconnected
      ? 'Peer Disconnected'
      : 'Waiting for Peer';
  }

  // Update recipient selector container
  const recipientContainer = root.querySelector('#file-recipient-selector-container') || root.querySelector('#file-recipient-selector');
  if (recipientContainer) {
    if (recipientContainer.id === 'file-recipient-selector-container') {
      recipientContainer.innerHTML = renderRecipientSelector(currentState, peerRegistry);
    } else {
      recipientContainer.outerHTML = renderRecipientSelector(currentState, peerRegistry);
    }
  }

  // Update dropzone styling and accessibility
  const dropZone = root.querySelector('#file-drop-zone');
  const fileBrowseInput = root.querySelector('#file-browse-input');
  const browseBtn = root.querySelector('#browse-files-btn');
  if (dropZone) {
    dropZone.classList.toggle('drop-zone-disabled', !isFileTransferAllowed);
    const titleEl = dropZone.querySelector('.drop-zone-title');
    if (titleEl) {
      if (isFileTransferAllowed) {
        titleEl.textContent = 'Drop files here to share directly';
      } else if (currentState?.isPeerDisconnected) {
        titleEl.textContent = 'Peer disconnected temporarily. Waiting for peer reconnect...';
      } else if (remotePeers.length === 0) {
        titleEl.textContent = 'Connect to a peer to enable file transfers';
      } else if (selectedIds.size === 0 && remotePeers.length > 1) {
        titleEl.textContent = 'Select at least one connected recipient above to enable file transfer';
      } else {
        titleEl.textContent = 'Selected recipient is not ready for file transfer. Waiting for connection...';
      }
    }
  }
  if (fileBrowseInput) {
    fileBrowseInput.disabled = !isFileTransferAllowed;
  }
  if (browseBtn) {
    browseBtn.disabled = !isFileTransferAllowed;
  }

  // Update active transfer panel
  const activeContainer = root.querySelector('#active-transfer-container');
  if (activeContainer) {
    activeContainer.innerHTML = renderActiveTransferPanel(currentState, isReady);
  }

  // Update files list
  const filesListEl = root.querySelector('#files-list');
  if (filesListEl) {
    filesListEl.innerHTML = renderFilesList(files);
  }

  // Update count badge
  const countBadge = root.querySelector('#files-count-badge');
  if (countBadge) {
    countBadge.textContent = `${files.length} items`;
  }

  // Update clear button disabled state
  const clearFilesBtn = root.querySelector('#clear-files-btn');
  if (clearFilesBtn) {
    clearFilesBtn.disabled = files.length === 0;
  }
}
