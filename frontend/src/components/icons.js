/**
 * Accessible inline SVG icons for PairPort UI.
 * Lightweight, dependency-free, and styled via currentColor.
 */

function createSvg(content, { size = 20, className = 'icon', viewBox = '0 0 24 24', ariaHidden = true } = {}) {
  const hiddenAttr = ariaHidden ? 'aria-hidden="true"' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${className}" ${hiddenAttr}>${content}</svg>`;
}

export const icons = {
  logo: (size = 28, className = 'brand-icon') => `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" class="${className}" aria-hidden="true">
      <defs>
        <linearGradient id="ppGrad" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop stop-color="#a78bfa" />
          <stop offset="0.5" stop-color="#818cf8" />
          <stop offset="1" stop-color="#6366f1" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#ppGrad)" />
      <circle cx="11" cy="16" r="3.5" fill="#ffffff" />
      <circle cx="21" cy="16" r="3.5" fill="#ffffff" />
      <path d="M14.5 16h3" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-dasharray="1 1" />
      <path d="M11 11a5 5 0 0 1 5 5m5 5a5 5 0 0 1-5-5" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-opacity="0.85" />
    </svg>
  `,

  p2p: (size = 20) => createSvg(`
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="6" r="3" />
    <path d="M18 9v3a3 3 0 0 1-3 3H9" />
    <polyline points="12 12 9 15 12 18" />
  `, { size }),

  shield: (size = 20) => createSvg(`
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="m9 12 2 2 4-4" />
  `, { size }),

  chat: (size = 20) => createSvg(`
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  `, { size }),

  file: (size = 20) => createSvg(`
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
    <polyline points="14 2 14 8 20 8" />
  `, { size }),

  fileZip: (size = 20) => createSvg(`
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="10" y1="12" x2="14" y2="12" />
    <line x1="10" y1="15" x2="14" y2="15" />
    <line x1="12" y1="18" x2="12" y2="18.01" />
  `, { size }),

  upload: (size = 20) => createSvg(`
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  `, { size }),

  download: (size = 20) => createSvg(`
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  `, { size }),

  copy: (size = 18) => createSvg(`
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  `, { size }),

  check: (size = 18) => createSvg(`
    <polyline points="20 6 9 17 4 12" />
  `, { size }),

  arrowRight: (size = 18) => createSvg(`
    <line x1="5" y1="12" x2="19" y2="12" />
    <polyline points="12 5 19 12 12 19" />
  `, { size }),

  send: (size = 18) => createSvg(`
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" fill="currentColor" fill-opacity="0.1" />
  `, { size }),

  wifi: (size = 18) => createSvg(`
    <path d="M5 12.55a11 11 0 0 1 14.08 0" />
    <path d="M1.42 9a16 16 0 0 1 21.16 0" />
    <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
    <line x1="12" y1="20" x2="12.01" y2="20" />
  `, { size }),

  zap: (size = 20) => createSvg(`
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  `, { size }),

  info: (size = 18) => createSvg(`
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  `, { size }),

  refresh: (size = 18) => createSvg(`
    <path d="M21.5 2v6h-6" />
    <path d="M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
  `, { size }),

  user: (size = 18) => createSvg(`
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  `, { size }),

  x: (size = 18) => createSvg(`
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  `, { size }),

  menu: (size = 22) => createSvg(`
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="18" x2="21" y2="18" />
  `, { size }),

  lock: (size = 18) => createSvg(`
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  `, { size }),

  sparkles: (size = 18) => createSvg(`
    <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3z" />
  `, { size }),

  trash: (size = 18) => createSvg(`
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  `, { size }),

  arrowUp: (size = 18) => createSvg(`
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
  `, { size }),

  arrowDown: (size = 18) => createSvg(`
    <line x1="12" y1="5" x2="12" y2="19" />
    <polyline points="19 12 12 19 5 12" />
  `, { size }),

  alertTriangle: (size = 18) => createSvg(`
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  `, { size }),

  helpCircle: (size = 18) => createSvg(`
    <circle cx="12" cy="12" r="10" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  `, { size }),
};
