/**
 * PairPort Main Application Component
 * Phase 4 — WebRTC Peer-to-Peer Connection & Real-Time Ephemeral Chat
 *
 * Vanilla JavaScript implementation featuring:
 * - Real WebSocket signaling relay for WebRTC offer/answer/ICE candidates
 * - Direct RTCPeerConnection and RTCDataChannel for real-time chat
 * - Zero chat messages routed through backend servers
 * - Strict XSS protection and input sanitization
 * - Separation of live P2P chat from sample demo preview
 */
import { APP_CONFIG } from './config/app-config.js';
import { icons } from './components/icons.js';
import { showToast } from './components/toast.js';
import { initModal, showConfirmDialog } from './components/modal.js';
import {
  peerConnectionService,
  DATA_CHANNEL_STATES,
} from './services/peer-connection.js';
import {
  formatFileSize,
  escapeHtml,
  filterClearableFiles,
} from './utils/ui-helpers.js';

import { state } from './state/app-state.js';
import {
  renderNavbar,
  initNavbar,
  renderHero,
  renderFeatures,
  renderHowItWorks,
  renderFooter,
} from './features/layout/index.js';
import {
  renderPairingSection,
  updatePairingCardsUI,
  initPairing,
  setPairingFeedback,
} from './features/pairing/index.js';
import {
  renderLiveSessionPanel,
  updateSessionStatusUI,
  computeSessionStatusInfo,
  initConnectionController,
} from './features/connection/index.js';
import {
  renderChatColumn,
  updateChatUI,
  initChat,
} from './features/chat/index.js';

/** Render the complete Phase 4 UI and wire up interactions */
export function startApp(root = document.querySelector('#app')) {
  if (!root) {
    throw new Error('PairPort app root (#app) was not found.');
  }

  // Render complete HTML markup
  root.innerHTML = `
    <div class="site-wrapper">
      ${renderNavbar()}
      <main id="main-content">
        ${renderHero()}
        ${renderFeatures()}
        ${renderHowItWorks()}
        ${renderPairingSection({ liveSessionHtml: renderLiveSessionPanel() })}
        ${renderWorkspaceSection()}
      </main>
      ${renderFooter()}
    </div>
  `;

  // Initialize navbar interactions (mobile menu toggle & roadmap trigger)
  initNavbar(root);

  // Initialize pairing interactions (create room, join room, validation, copy code)
  initPairing(root);

  // Initialize connection controller (signaling & WebRTC connection lifecycle)
  initConnectionController(root, {
    onChatUIUpdate: () => updateChatUI(root),
    onFilesUIUpdate: () => updateFilesUI(root),
  });

  // Initialize ephemeral chat interactions and WebRTC message listeners
  initChat(root);

  // Initialize roadmap modal
  initModal();

  // Attach all DOM event listeners
  bindEvents(root);

  // Subscribe to remaining data channel events (chat & file streaming)
  bindWebRTCEvents(root);
}

// ==========================================
// RENDER HELPERS
// ==========================================

function renderWorkspaceSection() {
  const {
    statusDotClass,
    statusPillHtml,
    metaBadgeText,
    isDataChannelOpen,
    isFileChannelOpen,
    isReconnecting,
    isRelayActive,
  } = computeSessionStatusInfo(state);

  return `
    <section id="workspace" class="workspace-section" aria-labelledby="workspace-heading">
      <div class="section-container">
        <div class="section-header">
          <div class="demo-badge-banner ${isDataChannelOpen || isFileChannelOpen ? 'active-banner' : ''}">
            <span class="status-indicator-dot ${statusDotClass}"></span>
            <span>${
              isReconnecting
                ? 'RECONNECTING WEBRTC LINK · IN-FLIGHT TRANSFERS PAUSED'
                : isDataChannelOpen && isFileChannelOpen
                ? (isRelayActive ? 'WEBRTC ACTIVE · TURN RELAY DATACHANNELS (CHAT & FILES)' : 'WEBRTC P2P ACTIVE · DIRECT SCTP DATACHANNELS (CHAT & FILES)')
                : isDataChannelOpen
                ? 'WEBRTC P2P CHAT ACTIVE · DIRECT SCTP DATACHANNEL'
                : 'SHARING WORKSPACE & CHAT'
            }</span>
          </div>
          <h2 id="workspace-heading" class="section-title">Direct P2P Workspace</h2>
          <p class="section-subtitle">
            ${isDataChannelOpen || isFileChannelOpen
              ? (isRelayActive
                  ? 'Real-time peer-to-peer text chat and chunked binary file transfers stream via encrypted TURN relay. End-to-end data remains private.'
                  : 'Real-time peer-to-peer text chat and chunked binary file transfers stream directly between browsers. Zero bytes route through the server.')
              : 'Pair with a peer above to establish direct WebRTC DataChannels for live ephemeral chat and chunked peer-to-peer file transfers up to 100 MB.'}
          </p>
        </div>

        <div class="workspace-card">
          <!-- Workspace Session Top Bar -->
          <div class="workspace-topbar">
            <div class="topbar-session-info">
              <div class="room-chip">
                <span class="chip-label">Room:</span>
                <strong id="workspace-room-code">${escapeHtml(state.realRoomCode || 'Not Connected')}</strong>
              </div>

              <div class="peer-status-pill">
                <span class="status-indicator-dot ${statusDotClass}"></span>
                <span class="peer-label">
                  ${statusPillHtml}
                </span>
              </div>
            </div>

            <div class="topbar-meta">
              <span class="latency-badge" title="Connection Mode">
                ${icons.wifi(14)}
                <span>${metaBadgeText}</span>
              </span>
              <button type="button" id="clear-chat-btn" class="btn btn-ghost btn-xs" title="Clear chat messages">
                ${icons.refresh(14)}
                <span>Clear Chat</span>
              </button>
            </div>
          </div>

          <!-- Workspace Split Grid -->
          <div class="workspace-grid">
            <!-- Left Column: Real-Time WebRTC File Sharing -->
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
                ${renderActiveTransferPanel()}
              </div>

              <!-- Session Files List -->
              <div class="files-list-section">
                <div class="files-list-header">
                  <h4 class="list-heading">Session Files (Live)</h4>
                  <div class="files-header-actions">
                    <span id="files-count-badge" class="badge badge-neutral">${state.realFiles.length} items</span>
                    <button type="button" id="clear-files-btn" class="btn-clear-history" title="Clear transfer records from session" ${state.realFiles.length === 0 ? 'disabled' : ''}>
                      ${icons.trash(14)}
                      <span>Clear History</span>
                    </button>
                  </div>
                </div>

                <ul id="files-list" class="files-list" role="list">
                  ${renderFilesList(state.realFiles)}
                </ul>
              </div>
            </div>

            <!-- Right Column: Real-time WebRTC Ephemeral Chat -->
            ${renderChatColumn(state)}
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderActiveTransferPanel() {
  const active = state.activeTransfer;
  const isReady = peerConnectionService.isFileChannelReady();

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

function renderFilesList(files) {
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





// ==========================================
// DATA CHANNEL STREAMING WIRING
// ==========================================

function bindWebRTCEvents(root) {
  // File Transfer Events (Phase 5)
  peerConnectionService.on('fileTransferStart', (transfer) => {
    const existingIndex = state.realFiles.findIndex((f) => f.id === transfer.id);
    if (existingIndex >= 0) {
      state.realFiles[existingIndex] = transfer;
    } else {
      state.realFiles.unshift(transfer);
    }
    if (transfer.status === 'sending' || transfer.status === 'receiving') {
      state.activeTransfer = transfer;
    }
    updateFilesUI(root);
    if (transfer.direction === 'incoming') {
      showToast(`Receiving "${transfer.name}" (${formatFileSize(transfer.size)}) from peer...`, 'info', 3000);
    }
  });

  peerConnectionService.on('fileTransferProgress', (transfer) => {
    const existingIndex = state.realFiles.findIndex((f) => f.id === transfer.id);
    if (existingIndex >= 0) {
      state.realFiles[existingIndex] = transfer;
    }
    if (state.activeTransfer && state.activeTransfer.id === transfer.id) {
      state.activeTransfer = transfer;
    } else if (transfer.status === 'sending' || transfer.status === 'receiving') {
      state.activeTransfer = transfer;
    }
    updateFilesUI(root);
  });

  peerConnectionService.on('fileTransferComplete', (transfer) => {
    const existingIndex = state.realFiles.findIndex((f) => f.id === transfer.id);
    if (existingIndex >= 0) {
      state.realFiles[existingIndex] = transfer;
    }
    if (state.activeTransfer && state.activeTransfer.id === transfer.id) {
      state.activeTransfer = null;
    }
    updateFilesUI(root);
    if (transfer.direction === 'incoming') {
      showToast(`Received "${transfer.name}"! Click Save to download.`, 'success', 5000);
    } else {
      showToast(`Sent "${transfer.name}" successfully to peer!`, 'success', 4000);
    }
  });

  peerConnectionService.on('fileTransferFailed', (transfer) => {
    const existingIndex = state.realFiles.findIndex((f) => f.id === transfer.id);
    if (existingIndex >= 0) {
      state.realFiles[existingIndex] = transfer;
    }
    if (state.activeTransfer && state.activeTransfer.id === transfer.id) {
      state.activeTransfer = null;
    }
    updateFilesUI(root);
    showToast(`Transfer failed for "${transfer.name}": ${transfer.error || 'Connection error'}`, 'warning', 4500);
  });

  peerConnectionService.on('fileTransferCancelled', (transfer) => {
    const existingIndex = state.realFiles.findIndex((f) => f.id === transfer.id);
    if (existingIndex >= 0) {
      state.realFiles[existingIndex] = transfer;
    }
    if (state.activeTransfer && state.activeTransfer.id === transfer.id) {
      state.activeTransfer = null;
    }
    updateFilesUI(root);
    showToast(`Transfer cancelled for "${transfer.name}"`, 'warning', 3000);
  });
}



function updateFilesUI(root) {
  const isFileChannelOpen = state.fileChannelState === DATA_CHANNEL_STATES.OPEN || peerConnectionService.isFileChannelReady();

  // Update file channel badge
  const badge = root.querySelector('#file-channel-badge');
  if (badge) {
    badge.className = `badge ${isFileChannelOpen ? 'badge-success' : 'badge-subtle'}`;
    badge.textContent = isFileChannelOpen ? 'P2P FileChannel Open' : 'Waiting for Peer';
  }

  // Update dropzone styling and accessibility
  const dropZone = root.querySelector('#file-drop-zone');
  const fileBrowseInput = root.querySelector('#file-browse-input');
  const browseBtn = root.querySelector('#browse-files-btn');
  if (dropZone) {
    dropZone.classList.toggle('drop-zone-disabled', !isFileChannelOpen);
    const titleEl = dropZone.querySelector('.drop-zone-title');
    if (titleEl) {
      titleEl.textContent = isFileChannelOpen ? 'Drop files here to share directly' : 'Connect to a peer to enable file transfers';
    }
  }
  if (fileBrowseInput) {
    fileBrowseInput.disabled = !isFileChannelOpen;
  }
  if (browseBtn) {
    browseBtn.disabled = !isFileChannelOpen;
  }

  // Update active transfer panel
  const activeContainer = root.querySelector('#active-transfer-container');
  if (activeContainer) {
    activeContainer.innerHTML = renderActiveTransferPanel();
  }

  // Update files list
  const filesListEl = root.querySelector('#files-list');
  if (filesListEl) {
    filesListEl.innerHTML = renderFilesList(state.realFiles);
  }

  // Update count badge
  const countBadge = root.querySelector('#files-count-badge');
  if (countBadge) {
    countBadge.textContent = `${state.realFiles.length} items`;
  }
}





// ==========================================
// DOM EVENT HANDLING & ACCESSIBILITY
// ==========================================

function bindEvents(root) {


  // Clear file transfer history button with confirmation dialog
  const clearFilesBtn = root.querySelector('#clear-files-btn');
  if (clearFilesBtn) {
    clearFilesBtn.addEventListener('click', () => {
      if (state.realFiles.length === 0) return;

      showConfirmDialog({
        title: 'Clear Transfer History?',
        message: 'Remove finished and cancelled transfer records from this session? Any downloaded files on your computer will remain safe, and in-memory download links will be released.',
        confirmText: 'Clear Records',
        cancelText: 'Cancel',
        isDestructive: true,
        onConfirm: () => {
          const { filesToKeep, filesToClear } = filterClearableFiles(state.realFiles, state.activeTransfer?.id);

          filesToClear.forEach((f) => {
            if (f.blobUrl) {
              try { URL.revokeObjectURL(f.blobUrl); } catch {}
              f.blobUrl = null;
            }
          });

          state.realFiles = filesToKeep;
          updateFilesUI(root);
          showToast('Transfer history cleared.', 'info', 3000);
        },
      });
    });
  }

  // 8. Real WebRTC File Streaming interactions (Phase 5)
  const dropZone = root.querySelector('#file-drop-zone');
  const fileBrowseInput = root.querySelector('#file-browse-input');
  const browseBtn = root.querySelector('#browse-files-btn');
  const filesListEl = root.querySelector('#files-list');

  const handleSelectedFiles = async (fileList) => {
    if (!fileList || fileList.length === 0) return;

    if (!peerConnectionService.isFileChannelReady()) {
      showToast('Pair with a peer above to activate direct file streaming.', 'warning', 4000);
      return;
    }

    const files = Array.from(fileList);
    for (const file of files) {
      if (file.size > APP_CONFIG.fileTransfer.maxFileSizeBytes) {
        const maxMb = Math.round(APP_CONFIG.fileTransfer.maxFileSizeBytes / (1024 * 1024));
        showToast(`File "${file.name}" exceeds maximum allowed limit of ${maxMb} MB.`, 'warning', 5000);
        continue;
      }

      try {
        await peerConnectionService.sendFile(file);
      } catch (err) {
        showToast(`Failed to send "${file.name}": ${err.message}`, 'error', 4500);
      }
    }
  };

  if (browseBtn && fileBrowseInput) {
    browseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!peerConnectionService.isFileChannelReady()) {
        showToast('Pair with a peer above to activate direct file streaming.', 'warning', 3500);
        return;
      }
      fileBrowseInput.click();
    });
  }

  if (fileBrowseInput) {
    fileBrowseInput.addEventListener('change', () => {
      if (fileBrowseInput.files && fileBrowseInput.files.length > 0) {
        handleSelectedFiles(fileBrowseInput.files);
        fileBrowseInput.value = '';
      }
    });
  }

  if (filesListEl) {
    filesListEl.addEventListener('click', (e) => {
      const cancelBtn = e.target.closest('[data-action="cancel"]');
      if (cancelBtn) {
        const transferId = cancelBtn.getAttribute('data-id');
        if (transferId) {
          peerConnectionService.cancelTransfer(transferId, 'Cancelled by user');
        }
      }
    });
  }

  const activeTransferContainer = root.querySelector('#active-transfer-container');
  if (activeTransferContainer) {
    activeTransferContainer.addEventListener('click', (e) => {
      const cancelBtn = e.target.closest('.cancel-active-transfer-btn');
      if (cancelBtn) {
        const transferId = cancelBtn.getAttribute('data-id');
        if (transferId) {
          peerConnectionService.cancelTransfer(transferId, 'Cancelled by user');
        }
      }
    });
  }

  if (dropZone) {
    dropZone.addEventListener('click', () => {
      if (!peerConnectionService.isFileChannelReady()) {
        showToast('Pair with a peer above to activate direct file streaming.', 'warning', 3500);
        return;
      }
      if (fileBrowseInput) fileBrowseInput.click();
    });

    ['dragenter', 'dragover'].forEach((eventName) => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (peerConnectionService.isFileChannelReady()) {
          dropZone.classList.add('drag-active');
        }
      });
    });

    ['dragleave', 'dragend'].forEach((eventName) => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-active');
      });
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drag-active');

      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleSelectedFiles(e.dataTransfer.files);
      }
    });

    dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (fileBrowseInput && peerConnectionService.isFileChannelReady()) {
          fileBrowseInput.click();
        }
      }
    });
  }
}


