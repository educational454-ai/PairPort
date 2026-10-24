/**
 * PairPort File Transfer Controller
 * Coordinates file selection, size validation, chunked P2P transfer events,
 * cancellation, blob URL lifecycle, and transfer history clearing.
 */

import { APP_CONFIG } from '../../config/app-config.js';
import { showToast } from '../../components/toast.js';
import { showConfirmDialog } from '../../components/modal.js';
import { peerConnectionService } from '../../services/peer-connection.js';
import {
  formatFileSize,
  filterClearableFiles,
} from '../../utils/ui-helpers.js';
import { state } from '../../state/app-state.js';
import { updateFilesUI } from './files-ui.js';

/**
 * Initialize file transfer event listeners and user interactions.
 * Idempotently attaches to the given root DOM node.
 *
 * @param {HTMLElement} root - Root application container
 * @param {object} [options]
 * @param {object} [options.peerConnection=peerConnectionService] - WebRTC peer connection service
 * @param {Function} [options.toast=showToast] - Toast notification function
 * @param {Function} [options.confirm=showConfirmDialog] - Confirmation modal function
 * @param {object} [options.appConfig=APP_CONFIG] - Application configuration
 * @returns {object} Controller API methods
 */
export function initFiles(root = document, {
  peerConnection = peerConnectionService,
  toast = showToast,
  confirm = showConfirmDialog,
  appConfig = APP_CONFIG,
} = {}) {
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
        `Receiving "${transfer.name}" (${formatFileSize(transfer.size)}) from peer...`,
        'info',
        3000
      );
    }
  });

  peerConnection.on('fileTransferProgress', (transfer) => {
    const existingIndex = state.realFiles.findIndex((f) => f.id === transfer.id);
    if (existingIndex >= 0) {
      state.realFiles[existingIndex] = transfer;
    }
    if (state.activeTransfer && state.activeTransfer.id === transfer.id) {
      state.activeTransfer = transfer;
    } else if (transfer.status === 'sending' || transfer.status === 'receiving') {
      state.activeTransfer = transfer;
    }
    updateFilesUI(root, state, peerConnection.isFileChannelReady());
  });

  peerConnection.on('fileTransferComplete', (transfer) => {
    const existingIndex = state.realFiles.findIndex((f) => f.id === transfer.id);
    if (existingIndex >= 0) {
      state.realFiles[existingIndex] = transfer;
    }
    if (state.activeTransfer && state.activeTransfer.id === transfer.id) {
      state.activeTransfer = null;
    }
    updateFilesUI(root, state, peerConnection.isFileChannelReady());
    if (transfer.direction === 'incoming') {
      toast(`Received "${transfer.name}"! Click Save to download.`, 'success', 5000);
    } else {
      toast(`Sent "${transfer.name}" successfully to peer!`, 'success', 4000);
    }
  });

  peerConnection.on('fileTransferFailed', (transfer) => {
    const existingIndex = state.realFiles.findIndex((f) => f.id === transfer.id);
    if (existingIndex >= 0) {
      state.realFiles[existingIndex] = transfer;
    }
    if (state.activeTransfer && state.activeTransfer.id === transfer.id) {
      state.activeTransfer = null;
    }
    updateFilesUI(root, state, peerConnection.isFileChannelReady());
    toast(
      `Transfer failed for "${transfer.name}": ${transfer.error || 'Connection error'}`,
      'warning',
      4500
    );
  });

  peerConnection.on('fileTransferCancelled', (transfer) => {
    const existingIndex = state.realFiles.findIndex((f) => f.id === transfer.id);
    if (existingIndex >= 0) {
      state.realFiles[existingIndex] = transfer;
    }
    if (state.activeTransfer && state.activeTransfer.id === transfer.id) {
      state.activeTransfer = null;
    }
    updateFilesUI(root, state, peerConnection.isFileChannelReady());
    toast(`Transfer cancelled for "${transfer.name}"`, 'warning', 3000);
  });

  // -----------------------------------------------------------------
  // 2. Clear File Transfer History
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
  // 3. File Selection, Validation & P2P Dispatch
  // -----------------------------------------------------------------

  const handleSelectedFiles = async (fileList) => {
    if (!fileList || fileList.length === 0) return;

    if (!peerConnection.isFileChannelReady()) {
      toast('Pair with a peer above to activate direct file streaming.', 'warning', 4000);
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

      try {
        await peerConnection.sendFile(file);
      } catch (err) {
        toast(`Failed to send "${file.name}": ${err.message}`, 'error', 4500);
      }
    }
  };

  const dropZone = root.querySelector('#file-drop-zone');
  const fileBrowseInput = root.querySelector('#file-browse-input');
  const browseBtn = root.querySelector('#browse-files-btn');
  const filesListEl = root.querySelector('#files-list');
  const activeTransferContainer = root.querySelector('#active-transfer-container');

  if (browseBtn && fileBrowseInput) {
    browseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!peerConnection.isFileChannelReady()) {
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
  // 4. Cancellation Actions (List and Active Card)
  // -----------------------------------------------------------------

  if (filesListEl) {
    filesListEl.addEventListener('click', (e) => {
      const cancelBtn = e.target.closest('[data-action="cancel"]');
      if (cancelBtn) {
        const transferId = cancelBtn.getAttribute('data-id');
        if (transferId) {
          peerConnection.cancelTransfer(transferId, 'Cancelled by user');
        }
      }
    });
  }

  if (activeTransferContainer) {
    activeTransferContainer.addEventListener('click', (e) => {
      const cancelBtn = e.target.closest('.cancel-active-transfer-btn');
      if (cancelBtn) {
        const transferId = cancelBtn.getAttribute('data-id');
        if (transferId) {
          peerConnection.cancelTransfer(transferId, 'Cancelled by user');
        }
      }
    });
  }

  // -----------------------------------------------------------------
  // 5. Drag & Drop and Keyboard Interactions
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
