/**
 * PairPort File Transfer Controller
 * Coordinates recipient selection, file selection, size validation, chunked P2P transfer events,
 * multi-recipient dispatch, cancellation, blob URL lifecycle, and transfer history clearing.
 */

import { APP_CONFIG } from '../../config/app-config.js';
import { showToast } from '../../components/toast.js';
import { showConfirmDialog } from '../../components/modal.js';
import { peerConnectionService } from '../../services/peer-connection.js';
import { peerRegistry } from '../../services/peer-registry.js';
import {
  formatFileSize,
  filterClearableFiles,
} from '../../utils/ui-helpers.js';
import { state as globalState } from '../../state/app-state.js';
import { updateFilesUI } from './files-ui.js';

/**
 * Initialize file transfer event listeners and user interactions.
 * Idempotently attaches to the given root DOM node.
 *
 * @param {HTMLElement} root - Root application container
 * @param {object} [options]
 * @param {object} [options.peerConnection=peerRegistry] - WebRTC peer connection or registry service
 * @param {Function} [options.toast=showToast] - Toast notification function
 * @param {Function} [options.confirm=showConfirmDialog] - Confirmation modal function
 * @param {object} [options.appConfig=APP_CONFIG] - Application configuration
 * @param {object} [options.appState=globalState] - Application state object
 * @returns {object} Controller API methods
 */
export function initFiles(root = document, {
  peerConnection = peerRegistry,
  toast = showToast,
  confirm = showConfirmDialog,
  appConfig = APP_CONFIG,
  appState = globalState,
} = {}) {
  const state = appState || globalState;
  // Prevent duplicate registration on same root
  const rootTarget = root && root.nodeType === 9 ? root.documentElement : root;
  if (rootTarget && rootTarget.dataset) {
    if (rootTarget.dataset.filesInitialized === 'true') {
      return {
        updateFilesUI: () => updateFilesUI(root, state, peerConnection.isFileChannelReady()),
      };
    }
    rootTarget.dataset.filesInitialized = 'true';
  } else if (root && root._filesInitialized) {
    return {
      updateFilesUI: () => updateFilesUI(root, state, peerConnection.isFileChannelReady()),
    };
  } else if (root) {
    root._filesInitialized = true;
  }

  // -----------------------------------------------------------------
  // 1. Subscribe to WebRTC File Transfer Events
  // -----------------------------------------------------------------

  peerConnection.on('fileTransferStart', (transfer) => {
    // Populate safe display label if missing
    if (!transfer.peerLabel && transfer.peerSessionId) {
      transfer.peerLabel = `Peer ${String(transfer.peerSessionId).slice(0, 8)}`;
    }

    const existingIndex = state.realFiles.findIndex((f) => f.id === transfer.id);
    if (existingIndex >= 0) {
      state.realFiles[existingIndex] = transfer;
    } else {
      state.realFiles.unshift(transfer);
    }

    if (transfer.status === 'sending' || transfer.status === 'receiving') {
      state.activeTransfer = transfer;
    }

    updateFilesUI(root, state, peerConnection.isFileChannelReady());

    if (transfer.direction === 'incoming') {
      toast(
        `Receiving "${transfer.name}" (${formatFileSize(transfer.size)}) from ${transfer.peerLabel || 'peer'}...`,
        'info',
        3000
      );
    }
  });

  peerConnection.on('fileTransferProgress', (transfer) => {
    const existingIndex = state.realFiles.findIndex((f) => f.id === transfer.id);
    if (existingIndex >= 0) {
      state.realFiles[existingIndex] = { ...state.realFiles[existingIndex], ...transfer };
    }

    if (state.activeTransfer && state.activeTransfer.id === transfer.id) {
      state.activeTransfer = { ...state.activeTransfer, ...transfer };
    } else if (transfer.status === 'sending' || transfer.status === 'receiving') {
      state.activeTransfer = transfer;
    }

    updateFilesUI(root, state, peerConnection.isFileChannelReady());
  });

  peerConnection.on('fileTransferComplete', (transfer) => {
    const existingIndex = state.realFiles.findIndex((f) => f.id === transfer.id);
    if (existingIndex >= 0) {
      state.realFiles[existingIndex] = { ...state.realFiles[existingIndex], ...transfer };
    }

    // Update active transfer pointer
    if (state.activeTransfer && state.activeTransfer.id === transfer.id) {
      const nextActive = state.realFiles.find(
        (f) => (f.status === 'sending' || f.status === 'receiving') && f.id !== transfer.id
      );
      state.activeTransfer = nextActive || null;
    }

    updateFilesUI(root, state, peerConnection.isFileChannelReady());

    const peerLabel = transfer.peerLabel || (transfer.peerSessionId ? `Peer ${String(transfer.peerSessionId).slice(0, 8)}` : 'peer');
    if (transfer.direction === 'incoming') {
      toast(`Received "${transfer.name}" from ${peerLabel}! Click Save to download.`, 'success', 5000);
    } else {
      toast(`Delivered "${transfer.name}" successfully to ${peerLabel}!`, 'success', 4000);
    }
  });

  peerConnection.on('fileTransferFailed', (transfer) => {
    const existingIndex = state.realFiles.findIndex((f) => f.id === transfer.id);
    if (existingIndex >= 0) {
      state.realFiles[existingIndex] = { ...state.realFiles[existingIndex], ...transfer };
    }

    if (state.activeTransfer && state.activeTransfer.id === transfer.id) {
      const nextActive = state.realFiles.find(
        (f) => (f.status === 'sending' || f.status === 'receiving') && f.id !== transfer.id
      );
      state.activeTransfer = nextActive || null;
    }

    updateFilesUI(root, state, peerConnection.isFileChannelReady());

    const peerLabel = transfer.peerLabel || (transfer.peerSessionId ? `Peer ${String(transfer.peerSessionId).slice(0, 8)}` : 'peer');
    toast(
      `Transfer failed for "${transfer.name}" (${peerLabel}): ${transfer.error || 'Connection error'}`,
      'warning',
      4500
    );
  });

  peerConnection.on('fileTransferCancelled', (transfer) => {
    const existingIndex = state.realFiles.findIndex((f) => f.id === transfer.id);
    if (existingIndex >= 0) {
      state.realFiles[existingIndex] = { ...state.realFiles[existingIndex], ...transfer };
    }

    if (state.activeTransfer && state.activeTransfer.id === transfer.id) {
      const nextActive = state.realFiles.find(
        (f) => (f.status === 'sending' || f.status === 'receiving') && f.id !== transfer.id
      );
      state.activeTransfer = nextActive || null;
    }

    updateFilesUI(root, state, peerConnection.isFileChannelReady());
    toast(`Transfer cancelled for "${transfer.name}"`, 'warning', 3000);
  });

  // -----------------------------------------------------------------
  // 2. Peer Lifecycle Subscriptions & Recipient Selection Pruning
  // -----------------------------------------------------------------

  if (typeof peerConnection.on === 'function') {
    peerConnection.on('peerRemoved', (evt) => {
      const removedId = evt?.peerSessionId;
      if (removedId && Array.isArray(state.selectedRecipientIds)) {
        state.selectedRecipientIds = state.selectedRecipientIds.filter((id) => id !== removedId);
      }
      updateFilesUI(root, state, peerConnection.isFileChannelReady());
    });

    peerConnection.on('peerAdded', () => {
      updateFilesUI(root, state, peerConnection.isFileChannelReady());
    });

    peerConnection.on('peerConnectionStateChange', () => {
      updateFilesUI(root, state, peerConnection.isFileChannelReady());
    });

    peerConnection.on('fileChannelOpen', () => {
      updateFilesUI(root, state, peerConnection.isFileChannelReady());
    });

    peerConnection.on('fileChannelClose', () => {
      updateFilesUI(root, state, peerConnection.isFileChannelReady());
    });
  }

  // -----------------------------------------------------------------
  // 3. Clear File Transfer History
  // -----------------------------------------------------------------

  const clearFilesBtn = root.querySelector('#clear-files-btn');
  if (clearFilesBtn) {
    clearFilesBtn.addEventListener('click', () => {
      if (!state.realFiles || state.realFiles.length === 0) return;

      confirm({
        title: 'Clear Transfer History?',
        message:
          'Remove finished and cancelled transfer records from this session? Any downloaded files on your computer will remain safe, and in-memory download links will be released.',
        confirmText: 'Clear Records',
        cancelText: 'Cancel',
        isDestructive: true,
        onConfirm: () => {
          const { filesToKeep, filesToClear } = filterClearableFiles(
            state.realFiles,
            state.activeTransfer?.id
          );

          filesToClear.forEach((f) => {
            if (f.blobUrl) {
              try {
                URL.revokeObjectURL(f.blobUrl);
              } catch {}
              f.blobUrl = null;
            }
          });

          state.realFiles = filesToKeep;
          updateFilesUI(root, state, peerConnection.isFileChannelReady());
          toast('Transfer history cleared.', 'info', 3000);
        },
      });
    });
  }

  // -----------------------------------------------------------------
  // 4. File Selection, Multi-Recipient Validation & P2P Dispatch
  // -----------------------------------------------------------------

  const handleSelectedFiles = async (fileList) => {
    if (!fileList || fileList.length === 0) return;

    // 1. Determine available remote peers
    const mySessionId = peerConnection?.mySessionId || state?.realSessionId || null;
    const roster = peerConnection?.getRoster ? peerConnection.getRoster() : (state?.participants || []);
    const remotePeers = Array.isArray(roster)
      ? roster.filter((p) => p && p.session_id && p.session_id !== mySessionId && p.status !== 'removed')
      : [];

    let targetIds = Array.isArray(state.selectedRecipientIds) ? [...state.selectedRecipientIds] : [];

    // 2. Legacy two-person fallback: auto-select single remote peer if not explicitly chosen
    if (targetIds.length === 0 && remotePeers.length === 1) {
      targetIds = [remotePeers[0].session_id];
      state.selectedRecipientIds = [...targetIds];
    }

    if (targetIds.length === 0 && remotePeers.length > 1) {
      toast('Select at least one connected recipient before sending files.', 'warning', 4000);
      return;
    }

    // 3. Filter to ready recipients with open file channels
    const readyRecipientIds = targetIds.filter((id) => {
      if (typeof peerConnection.hasPeer === 'function') {
        const p = peerConnection.getPeer(id);
        return Boolean(p && typeof p.isFileChannelReady === 'function' && p.isFileChannelReady());
      }
      return peerConnection.isFileChannelReady();
    });

    if (readyRecipientIds.length === 0 && remotePeers.length > 1) {
      toast('Selected recipient is not ready. Wait for WebRTC file channel to connect.', 'warning', 4000);
      return;
    }

    const files = Array.from(fileList);
    const maxSizeBytes = appConfig?.fileTransfer?.maxFileSizeBytes || 100 * 1024 * 1024;

    for (const file of files) {
      if (file.size > maxSizeBytes) {
        const maxMb = Math.round(maxSizeBytes / (1024 * 1024));
        toast(
          `File "${file.name}" exceeds maximum allowed limit of ${maxMb} MB.`,
          'warning',
          5000
        );
        continue;
      }

      // 4. Dispatch independently to each selected ready recipient
      if (typeof peerConnection.sendFilesToRecipients === 'function' && readyRecipientIds.length > 0) {
        try {
          await peerConnection.sendFilesToRecipients(file, readyRecipientIds);
        } catch (err) {
          toast(`Failed to send "${file.name}": ${err.message}`, 'error', 4500);
        }
      } else if (readyRecipientIds.length > 0) {
        for (const targetSessionId of readyRecipientIds) {
          try {
            if (typeof peerConnection.sendFile === 'function') {
              await peerConnection.sendFile(file, null, targetSessionId);
            }
          } catch (err) {
            toast(`Failed to send "${file.name}": ${err.message}`, 'error', 4500);
          }
        }
      } else {
        // Direct single-peer fallback (legacy 2-person mode or test mock)
        try {
          if (typeof peerConnection.sendFile === 'function') {
            await peerConnection.sendFile(file);
          }
        } catch (err) {
          toast(`Failed to send "${file.name}": ${err.message}`, 'error', 4500);
        }
      }
    }
  };

  const dropZone = root.querySelector('#file-drop-zone');
  const fileBrowseInput = root.querySelector('#file-browse-input');
  const browseBtn = root.querySelector('#browse-files-btn');
  const filesListEl = root.querySelector('#files-list');
  const activeTransferContainer = root.querySelector('#active-transfer-container');
  const recipientSelectorContainer = root.querySelector('#file-recipient-selector-container') || root.querySelector('#file-recipient-selector');

  if (browseBtn && fileBrowseInput) {
    browseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!peerConnection.isFileChannelReady() || state.isPeerDisconnected || state.isSignalingReconnecting) {
        toast('Pair with a peer above to activate direct file streaming.', 'warning', 3500);
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

  // -----------------------------------------------------------------
  // 5. Recipient Selector Delegated Event Handling
  // -----------------------------------------------------------------

  function handleRecipientSelectorEvents(e) {
    // 5a. Toggle single recipient checkbox
    const checkbox = e.target.closest('.recipient-checkbox');
    if (checkbox) {
      const peerId = checkbox.getAttribute('data-peer-id') || checkbox.value;
      if (peerId) {
        const currentSelected = new Set(state.selectedRecipientIds || []);
        if (checkbox.checked) {
          currentSelected.add(peerId);
        } else {
          currentSelected.delete(peerId);
        }
        state.selectedRecipientIds = Array.from(currentSelected);
        updateFilesUI(root, state, peerConnection.isFileChannelReady());
      }
      return;
    }

    // 5b. Select all ready recipients
    const selectAllBtn = e.target.closest('#select-all-recipients-btn');
    if (selectAllBtn) {
      const mySessionId = peerConnection?.mySessionId || state?.realSessionId || null;
      const roster = peerConnection?.getRoster ? peerConnection.getRoster() : (state?.participants || []);
      const readyPeerIds = [];

      if (Array.isArray(roster)) {
        roster.forEach((p) => {
          if (p && p.session_id && p.session_id !== mySessionId && p.status !== 'removed') {
            const peerService = typeof peerConnection.getPeer === 'function' ? peerConnection.getPeer(p.session_id) : null;
            if (peerService && typeof peerService.isFileChannelReady === 'function' && peerService.isFileChannelReady()) {
              readyPeerIds.push(p.session_id);
            }
          }
        });
      }

      state.selectedRecipientIds = readyPeerIds;
      updateFilesUI(root, state, peerConnection.isFileChannelReady());
      return;
    }

    // 5c. Deselect all recipients
    const deselectAllBtn = e.target.closest('#deselect-all-recipients-btn');
    if (deselectAllBtn) {
      state.selectedRecipientIds = [];
      updateFilesUI(root, state, peerConnection.isFileChannelReady());
    }
  }

  if (recipientSelectorContainer && typeof recipientSelectorContainer.addEventListener === 'function') {
    recipientSelectorContainer.addEventListener('change', handleRecipientSelectorEvents);
    recipientSelectorContainer.addEventListener('click', handleRecipientSelectorEvents);
  } else if (root && typeof root.addEventListener === 'function') {
    // Delegated fallback
    root.addEventListener('change', (e) => {
      if (e.target && typeof e.target.closest === 'function' && (e.target.closest('#file-recipient-selector') || e.target.closest('.file-recipient-selector'))) {
        handleRecipientSelectorEvents(e);
      }
    });
    root.addEventListener('click', (e) => {
      if (e.target && typeof e.target.closest === 'function' && (e.target.closest('#select-all-recipients-btn') || e.target.closest('#deselect-all-recipients-btn'))) {
        handleRecipientSelectorEvents(e);
      }
    });
  }

  // -----------------------------------------------------------------
  // 6. Cancellation Actions (Per-Transfer and Cancel All)
  // -----------------------------------------------------------------

  if (filesListEl) {
    filesListEl.addEventListener('click', (e) => {
      const cancelBtn = e.target.closest('[data-action="cancel"]');
      if (cancelBtn) {
        const transferId = cancelBtn.getAttribute('data-id');
        if (transferId && typeof peerConnection.cancelTransfer === 'function') {
          peerConnection.cancelTransfer(transferId, 'Cancelled by user');
        } else if (transferId && typeof peerConnection.cancelFileTransfer === 'function') {
          peerConnection.cancelFileTransfer(transferId, 'Cancelled by user');
        }
      }
    });
  }

  if (activeTransferContainer) {
    activeTransferContainer.addEventListener('click', (e) => {
      // Individual transfer cancellation
      const cancelBtn = e.target.closest('.cancel-active-transfer-btn');
      if (cancelBtn) {
        const transferId = cancelBtn.getAttribute('data-id');
        if (transferId && typeof peerConnection.cancelTransfer === 'function') {
          peerConnection.cancelTransfer(transferId, 'Cancelled by user');
        } else if (transferId && typeof peerConnection.cancelFileTransfer === 'function') {
          peerConnection.cancelFileTransfer(transferId, 'Cancelled by user');
        }
        return;
      }

      // Cancel all active transfers
      const cancelAllBtn = e.target.closest('#cancel-all-transfers-btn');
      if (cancelAllBtn) {
        const inFlight = (state.realFiles || []).filter(
          (f) => f.status === 'sending' || f.status === 'receiving'
        );
        inFlight.forEach((f) => {
          if (typeof peerConnection.cancelTransfer === 'function') {
            peerConnection.cancelTransfer(f.id, 'Cancelled by user');
          } else if (typeof peerConnection.cancelFileTransfer === 'function') {
            peerConnection.cancelFileTransfer(f.id, 'Cancelled by user');
          }
        });
      }
    });
  }

  // -----------------------------------------------------------------
  // 7. Drag & Drop and Keyboard Interactions
  // -----------------------------------------------------------------

  if (dropZone) {
    dropZone.addEventListener('click', () => {
      if (!peerConnection.isFileChannelReady()) {
        toast('Pair with a peer above to activate direct file streaming.', 'warning', 3500);
        return;
      }
      if (fileBrowseInput) fileBrowseInput.click();
    });

    ['dragenter', 'dragover'].forEach((eventName) => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (peerConnection.isFileChannelReady()) {
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
        if (fileBrowseInput && peerConnection.isFileChannelReady()) {
          fileBrowseInput.click();
        }
      }
    });
  }

  return {
    updateFilesUI: () => updateFilesUI(root, state, peerConnection.isFileChannelReady()),
    handleSelectedFiles,
  };
}
