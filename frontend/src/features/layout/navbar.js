/**
 * PairPort Navigation Header Component & Controller
 * Layout feature: Top navigation bar, brand header, mobile menu toggle, and roadmap trigger.
 */

import { APP_CONFIG } from '../../config/app-config.js';
import { icons } from '../../components/icons.js';
import { openPhaseModal } from '../../components/modal.js';
import { state } from '../../state/app-state.js';

/**
 * Render the top navigation bar markup.
 * @returns {string} HTML string
 */
export function renderNavbar() {
  return `
    <header class="site-header" role="banner">
      <div class="header-container">
        <a href="#hero" class="brand-link" aria-label="PairPort Home">
          ${icons.logo(32)}
          <span class="brand-name">${APP_CONFIG.name}</span>
          <span class="phase-pill" title="Phase 5 WebRTC P2P File Transfer Active">Phase 5 P2P Files & Chat</span>
        </a>

        <nav id="site-nav" class="site-nav" aria-label="Primary navigation">
          <ul class="nav-links">
            <li><a href="#features" class="nav-link">Features</a></li>
            <li><a href="#how-it-works" class="nav-link">How it Works</a></li>
            <li><a href="#pairing" class="nav-link">Pairing (Live)</a></li>
            <li><a href="#workspace" class="nav-link">P2P Chat & Workspace</a></li>
          </ul>
        </nav>

        <div class="header-actions">
          <button type="button" class="btn btn-ghost btn-sm roadmap-btn" aria-label="View project roadmap">
            ${icons.info(16)}
            <span>Roadmap</span>
          </button>
          <a href="#pairing" class="btn btn-primary btn-sm header-cta">
            <span>Start Sharing</span>
            ${icons.arrowRight(16)}
          </a>
          <button type="button" class="mobile-toggle" aria-controls="site-nav" aria-expanded="false" aria-label="Toggle navigation menu">
            ${icons.menu(22)}
          </button>
        </div>
      </div>
    </header>
  `;
}

/**
 * Wire up navbar events (mobile drawer toggle and roadmap modal trigger).
 * Prevents multiple registrations if called multiple times on the same root.
 *
 * @param {HTMLElement} root - Root container element containing the header
 */
export function initNavbar(root = document) {
  const header = root.querySelector('.site-header');
  if (!header || header.dataset.navbarInitialized === 'true') {
    return;
  }
  header.dataset.navbarInitialized = 'true';

  // 1. Mobile navigation drawer toggle
  const mobileToggle = header.querySelector('.mobile-toggle');
  const siteNav = header.querySelector('#site-nav');
  if (mobileToggle && siteNav) {
    mobileToggle.addEventListener('click', () => {
      state.isMobileMenuOpen = !state.isMobileMenuOpen;
      mobileToggle.setAttribute('aria-expanded', String(state.isMobileMenuOpen));
      siteNav.classList.toggle('nav-open', state.isMobileMenuOpen);
    });

    siteNav.querySelectorAll('.nav-link').forEach((link) => {
      link.addEventListener('click', () => {
        state.isMobileMenuOpen = false;
        mobileToggle.setAttribute('aria-expanded', 'false');
        siteNav.classList.remove('nav-open');
      });
    });
  }

  // 2. Project roadmap dialog buttons inside header
  const roadmapBtn = header.querySelector('.roadmap-btn');
  if (roadmapBtn) {
    roadmapBtn.addEventListener('click', () => {
      openPhaseModal();
    });
  }
}
