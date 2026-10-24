/**
 * Accessible toast notification system for PairPort.
 */

let toastContainer = null;

function ensureContainer() {
  if (!toastContainer || !document.body.contains(toastContainer)) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    toastContainer.setAttribute('role', 'region');
    toastContainer.setAttribute('aria-label', 'Notifications');
    document.body.appendChild(toastContainer);
  }
  return toastContainer;
}

/**
 * Display a short toast notification.
 * @param {string} message
 * @param {'info' | 'success' | 'warning'} [type='info']
 * @param {number} [duration=3600]
 */
export function showToast(message, type = 'info', duration = 3600) {
  const container = ensureContainer();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  const badge = document.createElement('span');
  badge.className = `toast-badge ${type}`;
  badge.textContent = type === 'success' ? '✓' : type === 'warning' ? '!' : 'i';

  const textSpan = document.createElement('span');
  textSpan.className = 'toast-text';
  textSpan.textContent = String(message || '');

  toast.appendChild(badge);
  toast.appendChild(textSpan);

  container.appendChild(toast);

  // Trigger entrance transition
  requestAnimationFrame(() => {
    toast.classList.add('visible');
  });

  const timer = setTimeout(() => {
    dismissToast(toast);
  }, duration);

  toast.addEventListener('click', () => {
    clearTimeout(timer);
    dismissToast(toast);
  });
}

function dismissToast(toast) {
  toast.classList.remove('visible');
  toast.addEventListener('transitionend', () => {
    toast.remove();
  }, { once: true });
}
