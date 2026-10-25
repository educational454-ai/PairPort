import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderNavbar,
  initNavbar,
  updateNavbarActive,
  renderHero,
  renderFeatures,
  renderHowItWorks,
  renderFooter,
} from '../src/features/layout/index.js';
import { state } from '../src/state/app-state.js';

describe('1. renderNavbar', () => {
  it('renders header markup with brand, navigation links, and controls', () => {
    const html = renderNavbar();
    assert.ok(html.includes('class="site-header"'));
    assert.ok(html.includes('id="site-nav"'));
    assert.ok(html.includes('class="brand-name"'));
    assert.ok(html.includes('class="phase-pill"'));
    assert.ok(html.includes('roadmap-btn'));
    assert.ok(html.includes('class="mobile-toggle"'));
    assert.ok(html.includes('href="#/home"'));
    assert.ok(html.includes('href="#features"'));
    assert.ok(html.includes('href="#how-it-works"'));
    assert.ok(html.includes('href="#/pair"'));
    assert.ok(html.includes('href="#/workspace"'));
    assert.ok(html.includes('nav-session-dot'));
  });
});

describe('2. renderHero', () => {
  it('renders hero section with heading, badges, CTAs, and preview mockup', () => {
    const html = renderHero({ roomCode: 'DEMO-9999' });
    assert.ok(html.includes('id="hero"'));
    assert.ok(html.includes('id="hero-heading"'));
    assert.ok(html.includes('Connect directly.'));
    assert.ok(html.includes('Share freely.'));
    assert.ok(html.includes('DEMO-9999'));
    assert.ok(html.includes('Direct WebRTC DataChannel Active'));
  });

  it('falls back to default demo room code if none provided', () => {
    const html = renderHero();
    assert.ok(html.includes('PORT-8492'));
  });
});

describe('3. renderFeatures', () => {
  it('renders features section with core architecture grid', () => {
    const html = renderFeatures();
    assert.ok(html.includes('id="features"'));
    assert.ok(html.includes('id="features-heading"'));
    assert.ok(html.includes('Real-Time WebRTC Chat'));
    assert.ok(html.includes('Private Room Pairing'));
    assert.ok(html.includes('Frictionless P2P Sharing'));
  });
});

describe('4. renderHowItWorks', () => {
  it('renders 3-step workflow grid with step badges and instructions', () => {
    const html = renderHowItWorks();
    assert.ok(html.includes('id="how-it-works"'));
    assert.ok(html.includes('id="how-heading"'));
    assert.ok(html.includes('Step 1'));
    assert.ok(html.includes('Step 2'));
    assert.ok(html.includes('Step 3'));
    assert.ok(html.includes('Create or Join a Room'));
    assert.ok(html.includes('WebRTC Handshake'));
    assert.ok(html.includes('Chat Directly (Live)'));
  });
});

describe('5. renderFooter', () => {
  it('renders footer with brand, navigation anchors, architecture tech specs, and copyright', () => {
    const html = renderFooter();
    assert.ok(html.includes('class="site-footer"'));
    assert.ok(html.includes('class="footer-brand"'));
    assert.ok(html.includes('class="footer-links"'));
    assert.ok(html.includes('class="footer-tech-list"'));
    assert.ok(html.includes(String(new Date().getFullYear())));
  });
});

describe('6. initNavbar event handling and idempotency', () => {
  it('gracefully handles missing header or duplicate calls without throwing', () => {
    const fakeRoot = {
      querySelector: () => null,
    };
    // Should not throw when header element is not found
    assert.doesNotThrow(() => initNavbar(fakeRoot));

    // Simulated DOM header
    let clickListener = null;
    const fakeHeader = {
      dataset: {},
      querySelector: (sel) => {
        if (sel === '.mobile-toggle') {
          return {
            setAttribute: (k, v) => {},
            addEventListener: (evt, fn) => { clickListener = fn; },
          };
        }
        if (sel === '#site-nav') {
          return {
            classList: { toggle: () => {} },
            querySelectorAll: () => [],
          };
        }
        return null;
      },
    };

    const rootWithHeader = {
      querySelector: (sel) => (sel === '.site-header' ? fakeHeader : null),
    };

    initNavbar(rootWithHeader);
    assert.equal(fakeHeader.dataset.navbarInitialized, 'true');
    assert.ok(typeof clickListener === 'function');

    // Calling again should be idempotent (early return without error)
    initNavbar(rootWithHeader);
    assert.equal(fakeHeader.dataset.navbarInitialized, 'true');
  });
});

describe('7. updateNavbarActive', () => {
  it('updates active class, aria-current, and session dot visibility', () => {
    let homeActive = false;
    let homeCurrent = null;
    let pairActive = false;
    let pairCurrent = null;
    let sessionDotHidden = true;

    const mockHomeLink = {
      dataset: { screen: 'home' },
      classList: {
        add: (cls) => { if (cls === 'active') homeActive = true; },
        remove: (cls) => { if (cls === 'active') homeActive = false; },
      },
      setAttribute: (k, v) => { if (k === 'aria-current') homeCurrent = v; },
      removeAttribute: (k) => { if (k === 'aria-current') homeCurrent = null; },
    };

    const mockPairLink = {
      dataset: { screen: 'pairing' },
      classList: {
        add: (cls) => { if (cls === 'active') pairActive = true; },
        remove: (cls) => { if (cls === 'active') pairActive = false; },
      },
      setAttribute: (k, v) => { if (k === 'aria-current') pairCurrent = v; },
      removeAttribute: (k) => { if (k === 'aria-current') pairCurrent = null; },
    };

    const mockSessionDot = {
      classList: {
        toggle: (cls, force) => { if (cls === 'hidden') sessionDotHidden = force; },
      },
    };

    const fakeHeader = {
      querySelectorAll: (sel) => {
        if (sel === '.nav-link') return [mockHomeLink, mockPairLink];
        return [];
      },
      querySelector: (sel) => {
        if (sel === '.nav-session-dot') return mockSessionDot;
        return null;
      },
    };

    const fakeRoot = {
      querySelector: (sel) => (sel === '.site-header' ? fakeHeader : null),
    };

    // 1. Activate Home without active session
    updateNavbarActive(fakeRoot, 'home', false);
    assert.equal(homeActive, true);
    assert.equal(homeCurrent, 'page');
    assert.equal(pairActive, false);
    assert.equal(pairCurrent, null);
    assert.equal(sessionDotHidden, true);

    // 2. Activate Pairing with active session
    updateNavbarActive(fakeRoot, 'pairing', true);
    assert.equal(homeActive, false);
    assert.equal(homeCurrent, null);
    assert.equal(pairActive, true);
    assert.equal(pairCurrent, 'page');
    assert.equal(sessionDotHidden, false);
  });
});
