import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderPairingSection,
  updatePairingCardsUI,
  setFeedback,
  initPairing,
  validateJoinInput,
  setPairingFeedback,
} from '../src/features/pairing/index.js';
import { SIGNALING_STATES } from '../src/services/signaling.js';
import { createInitialState } from '../src/state/app-state.js';

describe('1. renderPairingSection', () => {
  it('renders pairing section, onboarding guide, live session container slot, and cards', () => {
    const html = renderPairingSection({ liveSessionHtml: '<div class="test-live">Active Session</div>' });
    assert.ok(html.includes('id="pairing"'));
    assert.ok(html.includes('quick-start-guide'));
    assert.ok(html.includes('id="live-session-container"'));
    assert.ok(html.includes('test-live'));
    assert.ok(html.includes('id="pairing-cards-grid"'));
    assert.ok(html.includes('id="create-room-btn"'));
    assert.ok(html.includes('id="join-room-btn"'));
    assert.ok(html.includes('id="display-room-code"'));
    assert.ok(html.includes('id="copy-code-btn"'));
    assert.ok(html.includes('id="join-code-feedback"'));
  });
});

describe('2. setFeedback', () => {
  it('updates element text and css class name correctly', () => {
    const el = { textContent: '', className: '' };
    setFeedback(el, 'Test error message', 'error');
    assert.equal(el.textContent, 'Test error message');
    assert.equal(el.className, 'form-feedback feedback-error');

    setFeedback(el, 'Valid code', 'success');
    assert.equal(el.className, 'form-feedback feedback-success');

    // Safe handling of null element
    assert.doesNotThrow(() => setFeedback(null, 'message', 'error'));
  });
});

describe('3. validateJoinInput', () => {
  it('clears feedback when input is empty', () => {
    const feedback = { textContent: 'previous', className: 'form-feedback' };
    const input = { value: '   ' };
    validateJoinInput(input, feedback);
    assert.equal(feedback.textContent, '');
    assert.equal(feedback.className, 'form-feedback feedback-clear');
  });

  it('sets warning feedback when room code is incomplete or invalid', () => {
    const feedback = { textContent: '', className: '' };
    const input = { value: 'AB' }; // Too short
    validateJoinInput(input, feedback);
    assert.equal(feedback.className, 'form-feedback feedback-warning');
    assert.ok(feedback.textContent.length > 0);
  });

  it('sets success feedback when code format is valid', () => {
    const feedback = { textContent: '', className: '' };
    const input = { value: 'PORT-ABCD' };
    validateJoinInput(input, feedback);
    assert.equal(feedback.className, 'form-feedback feedback-success');
    assert.ok(feedback.textContent.includes('looks valid'));
  });
});

describe('4. updatePairingCardsUI', () => {
  it('updates display code, button states, and loading indicators based on state', () => {
    const displayCodeEl = { textContent: '' };
    const copyBtnEl = { disabled: true };
    const cardsGridEl = {
      classList: {
        toggle: (cls, val) => { cardsGridEl.isCollapsed = val; },
      },
      isCollapsed: false,
    };
    const createBtnEl = {
      classList: {
        add: () => { createBtnEl.loading = true; },
        remove: () => { createBtnEl.loading = false; },
      },
      loading: false,
    };
    const createBtnTextEl = { textContent: '' };
    const joinBtnEl = {
      classList: {
        add: () => { joinBtnEl.loading = true; },
        remove: () => { joinBtnEl.loading = false; },
      },
      loading: false,
    };
    const joinBtnTextEl = { textContent: '' };

    const fakeRoot = {
      querySelector: (sel) => {
        if (sel === '#display-room-code') return displayCodeEl;
        if (sel === '#copy-code-btn') return copyBtnEl;
        if (sel === '#pairing-cards-grid') return cardsGridEl;
        if (sel === '#create-room-btn') return createBtnEl;
        if (sel === '#create-room-btn-text') return createBtnTextEl;
        if (sel === '#join-room-btn') return joinBtnEl;
        if (sel === '#join-room-btn-text') return joinBtnTextEl;
        return null;
      },
    };

    const mockState = createInitialState();
    mockState.realRoomCode = 'ROOM-7890';
    mockState.signalingState = SIGNALING_STATES.CREATING;

    updatePairingCardsUI(fakeRoot, mockState);

    assert.equal(displayCodeEl.textContent, 'ROOM-7890');
    assert.equal(copyBtnEl.disabled, false);
    assert.equal(cardsGridEl.isCollapsed, true);
    assert.equal(createBtnEl.loading, true);
    assert.ok(createBtnTextEl.textContent.includes('Connecting'));
  });
});

describe('5. initPairing and setPairingFeedback', () => {
  it('sets error feedback on the feedback element via setPairingFeedback', () => {
    const feedback = { textContent: '', className: '' };
    const fakeRoot = {
      querySelector: (sel) => (sel === '#join-code-feedback' ? feedback : null),
    };
    setPairingFeedback(fakeRoot, 'Signaling connection failed', 'error');
    assert.equal(feedback.textContent, 'Signaling connection failed');
    assert.equal(feedback.className, 'form-feedback feedback-error');
  });

  it('wires up room creation and join form submit handlers idempotently', () => {
    let created = false;
    let joinedCode = null;

    const mockSignaling = {
      createRoom: () => { created = true; },
      joinRoom: (code) => { joinedCode = code; },
    };

    let createHandler = null;
    let submitHandler = null;
    let inputHandler = null;

    const fakeSection = {
      dataset: {},
      querySelector: (sel) => {
        if (sel === '#create-room-btn') {
          return { addEventListener: (evt, fn) => { createHandler = fn; } };
        }
        if (sel === '#copy-code-btn') {
          return { addEventListener: () => {} };
        }
        if (sel === '#paste-sample-code-btn') {
          return { addEventListener: () => {} };
        }
        if (sel === '#room-code-input') {
          return {
            value: 'PORT-XYZ9',
            addEventListener: (evt, fn) => { inputHandler = fn; },
            focus: () => {},
          };
        }
        if (sel === '#join-code-feedback') {
          return { textContent: '', className: '' };
        }
        if (sel === '#join-room-form') {
          return { addEventListener: (evt, fn) => { submitHandler = fn; } };
        }
        return null;
      },
    };

    const fakeRoot = {
      querySelector: (sel) => (sel === '#pairing' ? fakeSection : null),
    };

    initPairing(fakeRoot, { signaling: mockSignaling });
    assert.equal(fakeSection.dataset.pairingInitialized, 'true');
    assert.ok(typeof createHandler === 'function');
    assert.ok(typeof submitHandler === 'function');

    // Trigger create room click
    createHandler();
    assert.equal(created, true);

    // Trigger join form submit
    submitHandler({ preventDefault: () => {} });
    assert.equal(joinedCode, 'PORT-XYZ9');

    // Idempotency: calling again should return early
    initPairing(fakeRoot, { signaling: mockSignaling });
    assert.equal(fakeSection.dataset.pairingInitialized, 'true');
  });
});
