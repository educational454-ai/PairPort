/**
 * PairPort Footer Component
 * Layout feature: Site footer, brand tagline, navigation anchors, tech specs, and copyright.
 */

import { APP_CONFIG } from '../../config/app-config.js';
import { icons } from '../../components/icons.js';

/**
 * Render the site footer markup.
 * @returns {string} HTML string
 */
export function renderFooter() {
  return `
    <footer class="site-footer" role="contentinfo">
      <div class="footer-container">
        <div class="footer-primary">
          <div class="footer-brand">
            <div class="brand-link">
              ${icons.logo(28)}
              <span class="brand-name">${APP_CONFIG.name}</span>
            </div>
            <p class="footer-tagline">${APP_CONFIG.tagline}</p>
            <p class="footer-description">
              A modern peer-to-peer web application designed for direct, browser-to-browser sharing without intermediaries.
            </p>
          </div>

          <div class="footer-nav-group">
            <h4 class="footer-group-title">Navigation</h4>
            <ul class="footer-links">
              <li><a href="#hero">Overview</a></li>
              <li><a href="#features">Features</a></li>
              <li><a href="#how-it-works">How it Works</a></li>
              <li><a href="#pairing">Room Pairing</a></li>
              <li><a href="#workspace">P2P Workspace</a></li>
            </ul>
          </div>

          <div class="footer-tech-group">
            <h4 class="footer-group-title">Architecture</h4>
            <ul class="footer-tech-list">
              <li><span class="tech-label">Frontend:</span> Vanilla JS + Vite</li>
              <li><span class="tech-label">Backend:</span> Python FastAPI (Signaling Relay)</li>
              <li><span class="tech-label">Chat Transport:</span> WebRTC DataChannel (Active)</li>
              <li><span class="tech-label">File Protocol:</span> Chunked SCTP (Phase 5)</li>
            </ul>
          </div>
        </div>

        <div class="footer-bottom">
          <div class="footer-status-pill">
            <span class="status-indicator-dot online"></span>
            <span>${APP_CONFIG.currentPhase}</span>
          </div>
          <p class="footer-copyright">
            © ${new Date().getFullYear()} PairPort. Direct peer-to-peer web technology.
          </p>
        </div>
      </div>
    </footer>
  `;
}
