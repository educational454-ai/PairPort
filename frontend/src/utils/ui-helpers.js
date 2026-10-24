/**
 * PairPort UI Helpers and Validators
 * Pure utility functions for UI state formatting, code validation, and history management.
 */

/**
 * Validate a room code entered by a user.
 * Accepts formats such as "ABC123", "PORT-8492", "7K2M", etc.
 * @param {string} rawCode
 * @returns {{ isValid: boolean, code: string, error: string | null, message: string }}
 */
export function validateRoomCode(rawCode) {
  if (!rawCode || typeof rawCode !== 'string') {
    return {
      isValid: false,
      code: '',
      error: 'EMPTY_CODE',
      message: 'Room code cannot be empty.',
    };
  }

  const code = rawCode.trim().toUpperCase();

  if (code.length === 0) {
    return {
      isValid: false,
      code: '',
      error: 'EMPTY_CODE',
      message: 'Please enter a room code.',
    };
  }

  if (code.length < 3) {
    return {
      isValid: false,
      code,
      error: 'TOO_SHORT',
      message: 'Room code must be at least 3 characters.',
    };
  }

  if (code.length > 16) {
    return {
      isValid: false,
      code,
      error: 'TOO_LONG',
      message: 'Room code cannot exceed 16 characters.',
    };
  }

  // Must only contain alphanumeric characters and hyphens
  if (!/^[A-Z0-9-]+$/.test(code)) {
    return {
      isValid: false,
      code,
      error: 'INVALID_CHARACTERS',
      message: 'Room codes can only contain letters, numbers, and hyphens.',
    };
  }

  return {
    isValid: true,
    code,
    error: null,
    message: 'Valid room code format.',
  };
}

/**
 * Format bytes into human-readable units (Bytes, KB, MB, GB).
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  if (typeof bytes !== 'number' || isNaN(bytes) || bytes <= 0) {
    return '0 Bytes';
  }
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const unitIndex = Math.min(i, sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, unitIndex)).toFixed(1))} ${sizes[unitIndex]}`;
}

/**
 * Format a Date or timestamp into a readable 12-hour time string (e.g., "02:45 PM").
 * @param {Date | number | string} dateInput
 * @returns {string}
 */
export function formatTime(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Strictly escape HTML special characters to prevent XSS injection.
 * Works in both browser DOM and Node environments.
 * @param {string | any} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Filter transfer history for safe clearing.
 * Preserves currently in-flight/active transfers while identifying records safe to purge.
 * @param {Array<object>} files
 * @param {string | null} activeTransferId
 * @returns {{ filesToKeep: Array<object>, filesToClear: Array<object> }}
 */
export function filterClearableFiles(files, activeTransferId = null) {
  if (!Array.isArray(files)) {
    return { filesToKeep: [], filesToClear: [] };
  }

  const filesToKeep = [];
  const filesToClear = [];

  for (const file of files) {
    if (activeTransferId && file.id === activeTransferId) {
      filesToKeep.push(file);
    } else if (file.status === 'sending' || file.status === 'receiving') {
      // In-flight transfer must be protected from clearing
      filesToKeep.push(file);
    } else {
      filesToClear.push(file);
    }
  }

  return { filesToKeep, filesToClear };
}
