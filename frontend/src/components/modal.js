/**
 * Accessible Roadmap and Phase Information Modal.
 * Uses native <dialog> with modern backdrop and keyboard navigation.
 */

import { icons } from './icons.js';

let modalElement = null;

export function initModal() {
  if (modalElement && document.body.contains(modalElement)) return modalElement;

  modalElement = document.createElement('dialog');
  modalElement.id = 'phase-info-modal';
  modalElement.className = 'info-dialog';
  modalElement.setAttribute('aria-labelledby', 'modal-title');

  modalElement.innerHTML = `
    <div class="dialog-content">
      <header class="dialog-header">
        <div class="dialog-title-group">
          <span class="dialog-eyebrow">PROJECT ROADMAP</span>
          <h2 id="modal-title">Phase 5 · Real WebRTC P2P File Transfer Active</h2>
        </div>
        <button type="button" class="btn-icon-subtle dialog-close" aria-label="Close dialog">
          ${icons.x(20)}
        </button>
      </header>

      <div class="dialog-body">
        <p class="dialog-lead">
          PairPort now features <strong>direct browser-to-browser WebRTC chunked file transfers</strong> alongside real-time ephemeral chat. Files stream in binary chunks directly between peers with zero cloud storage.
        </p>

        <div class="timeline-list">
          <div class="timeline-item completed">
            <span class="timeline-step">01</span>
            <div class="timeline-details">
              <strong>Phase 1 · Project Foundation</strong>
              <p>FastAPI service skeleton, Vite environment, and repository layout.</p>
            </div>
            <span class="badge badge-success">Done</span>
          </div>

          <div class="timeline-item completed">
            <span class="timeline-step">02</span>
            <div class="timeline-details">
              <strong>Phase 2 · Complete Frontend UI</strong>
              <p>Dark theme design system, responsive layouts, and interactive sharing workspace preview.</p>
            </div>
            <span class="badge badge-success">Done</span>
          </div>

          <div class="timeline-item completed">
            <span class="timeline-step">03</span>
            <div class="timeline-details">
              <strong>Phase 3 · WebSocket Signaling Server</strong>
              <p>FastAPI room pairing coordination, short code generation, and handshake exchange.</p>
            </div>
            <span class="badge badge-success">Done</span>
          </div>

          <div class="timeline-item completed">
            <span class="timeline-step">04</span>
            <div class="timeline-details">
              <strong>Phase 4 · WebRTC P2P Ephemeral Chat</strong>
              <p>Direct browser-to-browser RTCPeerConnection and RTCDataChannel for real-time text chat.</p>
            </div>
            <span class="badge badge-success">Done</span>
          </div>

          <div class="timeline-item completed">
            <span class="timeline-step">05</span>
            <div class="timeline-details">
              <strong>Phase 5 · Real WebRTC P2P File Transfer</strong>
              <p>Direct chunked binary streaming over WebRTC data channels with backpressure control and safe assembly.</p>
            </div>
            <span class="badge badge-success">Done</span>
          </div>

          <div class="timeline-item current">
            <span class="timeline-step">08</span>
            <div class="timeline-details">
              <strong>Phase 8 · Product Polish & UX (Current)</strong>
              <p>Session history controls, first-time user onboarding, status synchronization, and accessible responsive design.</p>
            </div>
            <span class="badge badge-primary">Active</span>
          </div>

          <div class="timeline-item upcoming">
            <span class="timeline-step">06</span>
            <div class="timeline-details">
              <strong>Phase 6 · Production Hardening & TURN Relay</strong>
              <p>TURN relay fallback for restricted NATs, bandwidth management, and transfer pause/resume.</p>
            </div>
            <span class="badge badge-neutral">Upcoming</span>
          </div>
        </div>
      </div>

      <footer class="dialog-footer">
        <p class="dialog-footnote">
          ${icons.info(14)} Files and chat messages stream directly between browsers over WebRTC data channels with zero cloud storage.
        </p>
        <button type="button" class="btn btn-primary dialog-close-btn">
          Explore PairPort
        </button>
      </footer>
    </div>
  `;

  document.body.appendChild(modalElement);

  // Close handlers
  const closeButtons = modalElement.querySelectorAll('.dialog-close, .dialog-close-btn');
  closeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      closeModal();
    });
  });

  // Close on backdrop click
  modalElement.addEventListener('click', (e) => {
    const rect = modalElement.getBoundingClientRect();
    const isInDialog = (
      rect.top <= e.clientY &&
      e.clientY <= rect.top + rect.height &&
      rect.left <= e.clientX &&
      e.clientX <= rect.left + rect.width
    );
    if (!isInDialog) {
      closeModal();
    }
  });

  return modalElement;
}

export function openPhaseModal() {
  const modal = initModal();
  if (typeof modal.showModal === 'function') {
    modal.showModal();
  } else {
    modal.setAttribute('open', '');
  }
}

export function closeModal() {
  if (!modalElement) return;
  if (typeof modalElement.close === 'function') {
    modalElement.close();
  } else {
    modalElement.removeAttribute('open');
  }
}

/**
 * Accessible confirmation dialog using native HTML5 <dialog>.
 * Locks focus, announces politely, supports light dismiss and keyboard cancel.
 */
export function showConfirmDialog({
  title = 'Confirm Action',
  message = 'Are you sure you want to proceed?',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  isDestructive = false,
  onConfirm = () => {},
}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'confirm-dialog';
  dialog.setAttribute('aria-labelledby', 'confirm-title');
  dialog.setAttribute('aria-describedby', 'confirm-desc');

  dialog.innerHTML = `
    <div class="confirm-dialog-content">
      <div class="confirm-dialog-header">
        <div class="confirm-icon-box ${isDestructive ? 'destructive' : ''}">
          ${isDestructive ? icons.alertTriangle(22) : icons.helpCircle(22)}
        </div>
        <h3 id="confirm-title" class="confirm-title"></h3>
      </div>
      <p id="confirm-desc" class="confirm-message"></p>
      <div class="confirm-actions">
        <button type="button" class="btn btn-secondary btn-sm confirm-cancel-btn"></button>
        <button type="button" class="btn ${isDestructive ? 'btn-danger' : 'btn-primary'} btn-sm confirm-ok-btn"></button>
      </div>
    </div>
  `;

  // Safely assign text content to prevent XSS injection from untrusted filenames/messages
  const titleEl = dialog.querySelector('#confirm-title');
  if (titleEl) titleEl.textContent = title;
  const descEl = dialog.querySelector('#confirm-desc');
  if (descEl) descEl.textContent = message;

  document.body.appendChild(dialog);

  const closeDialog = () => {
    try {
      if (typeof dialog.close === 'function') {
        dialog.close();
      }
    } catch {}
    dialog.remove();
  };

  const cancelBtn = dialog.querySelector('.confirm-cancel-btn');
  const okBtn = dialog.querySelector('.confirm-ok-btn');

  if (cancelBtn) cancelBtn.textContent = cancelText;
  if (okBtn) okBtn.textContent = confirmText;

  cancelBtn.addEventListener('click', closeDialog);
  okBtn.addEventListener('click', () => {
    closeDialog();
    try {
      onConfirm();
    } catch (err) {
      console.error('Confirmation callback error:', err);
    }
  });

  // Light dismiss on backdrop click
  dialog.addEventListener('click', (e) => {
    const rect = dialog.getBoundingClientRect();
    const isInDialog = (
      rect.top <= e.clientY &&
      e.clientY <= rect.top + rect.height &&
      rect.left <= e.clientX &&
      e.clientX <= rect.left + rect.width
    );
    if (!isInDialog) {
      closeDialog();
    }
  });

  dialog.addEventListener('cancel', () => {
    dialog.remove();
  });

  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
    // Focus cancel button by default for safety
    cancelBtn.focus();
  } else {
    dialog.setAttribute('open', '');
  }

  return dialog;
}
