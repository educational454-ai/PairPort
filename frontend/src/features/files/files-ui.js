/**
 * PairPort File Transfer UI Component
 * Layout and markup for the real-time P2P file hub, drop zone, active transfer panel, and session files list.
 */

import { icons } from '../../components/icons.js';
import { state } from '../../state/app-state.js';
import {
  peerConnectionService,
  DATA_CHANNEL_STATES,
} from '../../services/peer-connection.js';
import {
  formatFileSize,
  escapeHtml,
} from '../../utils/ui-helpers.js';

/**
 * Render the active transfer progress card or standby station.
 *
 * @param {object} [currentState=state] - Current application state
 * @param {boolean} [isReady=peerConnectionService.isFileChannelReady()] - Whether file DataChannel is open
 * @returns {string} HTML markup
 */
export function renderActiveTransferPanel(
  currentState = state,
  isReady = peerConnectionService.isFileChannelReady()
) {
  const active = currentState ? currentState.activeTransfer : null;

  if (!active) {
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

  const isOutgoing = active.direction === 'outgoing';
  const transferredStr = formatFileSize(active.transferredBytes || 0);
  const totalStr = formatFileSize(active.totalBytes || active.size || 0);
  const percent = active.progress || 0;
  const statusLabel = active.status ? active.status.toUpperCase() : 'TRANSFERRING';
  const safeActiveName = typeof active.name === 'string' ? active.name : 'unnamed_file';
  const isZip = safeActiveName.endsWith('.zip');

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
              ${isOutgoing ? 'Chunked upload' : 'Chunked download'} · ${transferredStr} of ${totalStr}
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

/**
 * Render the session files list items with status badges, progress, and download/cancel actions.
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
  isReady = peerConnectionService.isFileChannelReady()
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
 * Update dynamic file transfer badges, dropzone states, active panel, files list, and counts.
 *
 * @param {HTMLElement} root - Root container element
 * @param {object} [currentState=state] - Current application state
 * @param {boolean} [isReady=peerConnectionService.isFileChannelReady()] - Whether file DataChannel is open
 */
export function updateFilesUI(
  root,
  currentState = state,
  isReady = peerConnectionService.isFileChannelReady()
) {
  if (!root) return;

  const isFileChannelOpen =
    (currentState && currentState.fileChannelState === DATA_CHANNEL_STATES.OPEN) || isReady;
  const isFileTransferAllowed =
    isFileChannelOpen &&
    !currentState?.isPeerDisconnected &&
    !currentState?.isSignalingReconnecting &&
    !currentState?.isReconnecting;
  const files = currentState && currentState.realFiles ? currentState.realFiles : [];

  // Update file channel badge
  const badge = root.querySelector('#file-channel-badge');
  if (badge) {
    badge.className = `badge ${isFileTransferAllowed ? 'badge-success' : 'badge-subtle'}`;
    badge.textContent = isFileTransferAllowed
      ? 'P2P FileChannel Open'
      : currentState?.isPeerDisconnected
      ? 'Peer Disconnected'
      : 'Waiting for Peer';
  }

  // Update dropzone styling and accessibility
  const dropZone = root.querySelector('#file-drop-zone');
  const fileBrowseInput = root.querySelector('#file-browse-input');
  const browseBtn = root.querySelector('#browse-files-btn');
  if (dropZone) {
    dropZone.classList.toggle('drop-zone-disabled', !isFileTransferAllowed);
    const titleEl = dropZone.querySelector('.drop-zone-title');
    if (titleEl) {
      titleEl.textContent = isFileTransferAllowed
        ? 'Drop files here to share directly'
        : currentState?.isPeerDisconnected
        ? 'Peer disconnected temporarily. Waiting for peer reconnect...'
        : 'Connect to a peer to enable file transfers';
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
