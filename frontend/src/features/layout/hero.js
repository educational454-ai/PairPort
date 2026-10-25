/**
 * PairPort Hero Section Component
 * Layout feature: Headline, value proposition, CTA buttons, and WebRTC preview mockup card.
 */

import { icons } from '../../components/icons.js';
import { state } from '../../state/app-state.js';

/**
 * Render the hero section markup.
 * @param {object} [options]
 * @param {string|null} [options.roomCode] - Optional override for active session room code
 * @returns {string} HTML string
 */
export function renderHero({ roomCode = state.realRoomCode } = {}) {
  const displayCode = roomCode || 'PORT-8492';

  return `
    <section id="hero" class="hero-section" aria-labelledby="hero-heading">
      <div class="hero-glow hero-glow-1" aria-hidden="true"></div>
      <div class="hero-glow hero-glow-2" aria-hidden="true"></div>

      <div class="hero-container">
        <div class="hero-content">
          <div class="hero-eyebrow">
            <span class="pulse-dot" aria-hidden="true"></span>
            <span>Direct WebRTC DataChannel Active · Ephemeral Chat</span>
          </div>

          <h1 id="hero-heading" class="hero-title">
            Connect directly.<br />
            <span class="text-gradient">Share freely.</span>
          </h1>

          <p class="hero-description">
            Fast, private peer-to-peer WebRTC connections and ephemeral real-time chat straight between web browsers.
            No cloud storage, zero server chat logging, and no account sign-up.
          </p>

          <div class="hero-cta-group">
            <a href="#/pair" class="btn btn-primary btn-lg" data-screen="pairing">
              <span>Start P2P Session</span>
              ${icons.arrowRight(18)}
            </a>
            <a href="#how-it-works" class="btn btn-secondary btn-lg">
              ${icons.sparkles(18)}
              <span>How it works</span>
            </a>
            <a href="#/workspace" class="btn btn-ghost btn-lg" data-screen="workspace">
              <span>Open P2P Workspace</span>
            </a>
          </div>

          <div class="hero-badges">
            <div class="badge-item">
              ${icons.shield(18)}
              <span>WebRTC DataChannels</span>
            </div>
            <div class="badge-item">
              ${icons.chat(18)}
              <span>Zero-Server Chat Relay</span>
            </div>
            <div class="badge-item">
              ${icons.lock(18)}
              <span>Local Ephemeral Memory Only</span>
            </div>
          </div>
        </div>

        <div class="hero-preview-wrapper">
          <div class="hero-mockup-card">
            <div class="mockup-header">
              <div class="mockup-dots" aria-hidden="true">
                <span></span><span></span><span></span>
              </div>
              <div class="mockup-room-badge">
                <span class="status-indicator-dot online"></span>
                <span>Active Session: <strong>${displayCode}</strong></span>
              </div>
              <span class="mockup-label">WebRTC Active</span>
            </div>

            <div class="mockup-body">
              <div class="mockup-peer-bar">
                <div class="peer-avatar">
                  ${icons.user(16)}
                </div>
                <div class="peer-info">
                  <span class="peer-name">Connected Peer</span>
                  <span class="peer-details">Direct WebRTC DataChannel · SCTP</span>
                </div>
                <span class="transfer-speed-chip">P2P Active</span>
              </div>

              <div class="mockup-chat-snippet">
                <div class="chat-bubble peer">
                  <span class="bubble-sender">Peer</span>
                  <p>Direct WebRTC channel open! No server sees our messages.</p>
                </div>
                <div class="chat-bubble you">
                  <span class="bubble-sender">You</span>
                  <p>Connected instantly via browser peer-to-peer data channel.</p>
                </div>
              </div>
            </div>

            <div class="mockup-footer">
              <a href="#workspace" class="mockup-cta-link">
                <span>Open live workspace and test chat</span>
                ${icons.arrowRight(14)}
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}
