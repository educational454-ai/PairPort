/**
 * PairPort How It Works Section Component
 * Layout feature: 3-step workflow explanation (Room Pairing, WebRTC Handshake, Ephemeral Chat).
 */

import { icons } from '../../components/icons.js';

/**
 * Render the how-it-works section markup.
 * @returns {string} HTML string
 */
export function renderHowItWorks() {
  return `
    <section id="how-it-works" class="how-it-works-section" aria-labelledby="how-heading">
      <div class="section-container">
        <div class="section-header">
          <span class="section-eyebrow">SIMPLE 3-STEP WORKFLOW</span>
          <h2 id="how-heading" class="section-title">How PairPort works</h2>
          <p class="section-subtitle">
            No installation, no account creation, and no cloud file storage required.
          </p>
        </div>

        <div class="steps-grid">
          <div class="step-card">
            <div class="step-badge">Step 1</div>
            <div class="step-icon">
              ${icons.p2p(24)}
            </div>
            <h3 class="step-title">Create or Join a Room</h3>
            <p class="step-text">
              One peer creates a room and receives a server-generated code (e.g. <code>PORT-XXXX</code>). The other peer enters the code to join.
            </p>
          </div>

          <div class="step-card">
            <div class="step-badge">Step 2</div>
            <div class="step-icon">
              ${icons.wifi(24)}
            </div>
            <h3 class="step-title">WebRTC Handshake</h3>
            <p class="step-text">
              Browsers exchange SDP offers/answers and ICE candidates via the signaling server to establish an encrypted direct peer connection.
            </p>
          </div>

          <div class="step-card">
            <div class="step-badge">Step 3</div>
            <div class="step-icon">
              ${icons.chat(24)}
            </div>
            <h3 class="step-title">Chat Directly (Live)</h3>
            <p class="step-text">
              An active <code>RTCDataChannel</code> allows instant messaging directly between devices. Messages clear completely upon disconnect.
            </p>
          </div>
        </div>
      </div>
    </section>
  `;
}
