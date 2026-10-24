/**
 * PairPort Features Section Component
 * Layout feature: 3-column architecture highlights (WebRTC Chat, Private Pairing, P2P Sharing).
 */

import { icons } from '../../components/icons.js';

/**
 * Render the features section markup.
 * @returns {string} HTML string
 */
export function renderFeatures() {
  return `
    <section id="features" class="features-section" aria-labelledby="features-heading">
      <div class="section-container">
        <div class="section-header">
          <span class="section-eyebrow">CORE ARCHITECTURE</span>
          <h2 id="features-heading" class="section-title">Built for direct peer communication</h2>
          <p class="section-subtitle">
            PairPort coordinates initial signaling via FastAPI WebSockets, then transfers data directly browser-to-browser via WebRTC.
          </p>
        </div>

        <div class="features-grid">
          <article class="feature-card highlight">
            <div class="feature-icon-wrapper">
              ${icons.chat(24)}
            </div>
            <h3 class="feature-title">Real-Time WebRTC Chat</h3>
            <p class="feature-text">
              Chat messages travel over dedicated SCTP data channels directly between browsers.
              Zero messages pass through or are saved by any server.
            </p>
            <ul class="feature-specs">
              <li>Direct browser-to-browser transport</li>
              <li>Zero server message logging</li>
              <li>Purely ephemeral memory session</li>
            </ul>
          </article>

          <article class="feature-card">
            <div class="feature-icon-wrapper">
              ${icons.shield(24)}
            </div>
            <h3 class="feature-title">Private Room Pairing</h3>
            <p class="feature-text">
              Clean 4-character room codes generated with unambiguous characters.
              Strictly restricted to two participants per room with immediate disconnect cleanup.
            </p>
            <ul class="feature-specs">
              <li>FastAPI WebSocket signaling</li>
              <li>Server-generated identities</li>
              <li>Two-participant room guarantee</li>
            </ul>
          </article>

          <article class="feature-card">
            <div class="feature-icon-wrapper">
              ${icons.zap(24)}
            </div>
            <h3 class="feature-title">Frictionless P2P Sharing</h3>
            <p class="feature-text">
              Direct connection without account creation or installs. Next phase enables chunked
              binary streaming of documents, media, and archives directly over data channels.
            </p>
            <ul class="feature-specs">
              <li>No cloud storage intermediaries</li>
              <li>Standard WebRTC STUN discovery</li>
              <li>Clean graceful disconnection</li>
            </ul>
          </article>
        </div>
      </div>
    </section>
  `;
}
