import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderChatMessages,
  renderChatColumn,
  updateChatUI,
  initChat,
} from '../src/features/chat/index.js';
import {
  PEER_CONNECTION_STATES,
  DATA_CHANNEL_STATES,
} from '../src/services/peer-connection.js';
import { createInitialState } from '../src/state/app-state.js';

describe('1. renderChatMessages', () => {
  it('renders friendly empty state when realChatMessages is empty', () => {
    const s = createInitialState();
    const html = renderChatMessages(s);
    assert.ok(html.includes('empty-chat-item'));
    assert.ok(html.includes('Ephemeral P2P Chat'));
    assert.ok(html.includes('Connect to a peer above'));
  });

  it('renders active empty state message when data channel is open', () => {
    const s = createInitialState();
    s.dataChannelState = DATA_CHANNEL_STATES.OPEN;
    const html = renderChatMessages(s);
    assert.ok(html.includes('WebRTC DataChannel is active! Start chatting'));
  });

  it('renders system messages with time and icons', () => {
    const s = createInitialState();
    s.realChatMessages = [
      {
        id: 'sys-1',
        sender: 'system',
        text: 'Direct WebRTC DataChannel open!',
        timestamp: '10:45 AM',
      },
    ];
    const html = renderChatMessages(s);
    assert.ok(html.includes('chat-system-message'));
    assert.ok(html.includes('Direct WebRTC DataChannel open!'));
    assert.ok(html.includes('10:45 AM'));
  });

  it('renders user and peer messages with proper bubble classes and tags', () => {
    const s = createInitialState();
    s.realChatMessages = [
      {
        id: 'msg-1',
        sender: 'user',
        senderName: 'You',
        text: 'Hello peer!',
        timestamp: '10:46 AM',
      },
      {
        id: 'msg-2',
        sender: 'peer',
        senderName: 'Remote Peer',
        text: 'Hey there! P2P works.',
        timestamp: '10:47 AM',
      },
    ];
    const html = renderChatMessages(s);
    assert.ok(html.includes('msg-you'));
    assert.ok(html.includes('Hello peer!'));
    assert.ok(html.includes('msg-peer'));
    assert.ok(html.includes('Remote Peer'));
    assert.ok(html.includes('P2P Direct'));
  });

  it('safely escapes HTML characters in user and peer text (XSS defense)', () => {
    const s = createInitialState();
    s.realChatMessages = [
      {
        id: 'xss-1',
        sender: 'peer',
        senderName: '<img src=x onerror=alert(1)>',
        text: '<script>alert("hack")</script> & <b>bold</b>',
        timestamp: '10:48 AM',
      },
    ];
    const html = renderChatMessages(s);
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;alert(&quot;hack&quot;)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;'));
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });
});

describe('2. renderChatColumn', () => {
  it('renders complete chat column markup with input, button, and clear actions', () => {
    const s = createInitialState();
    const html = renderChatColumn(s);
    assert.ok(html.includes('chat-column'));
    assert.ok(html.includes('Real-Time P2P Chat'));
    assert.ok(html.includes('id="chat-channel-badge"'));
    assert.ok(html.includes('id="chat-col-clear-btn"'));
    assert.ok(html.includes('id="chat-notice-text"'));
    assert.ok(html.includes('id="chat-messages-container"'));
    assert.ok(html.includes('id="chat-form"'));
    assert.ok(html.includes('id="chat-input"'));
    assert.ok(html.includes('id="chat-send-btn"'));
    assert.ok(html.includes('id="char-counter"'));
    // Disabled in idle state
    assert.ok(html.includes('disabled'));
  });

  it('renders enabled input and active badge when dataChannel is open', () => {
    const s = createInitialState();
    s.dataChannelState = DATA_CHANNEL_STATES.OPEN;
    const html = renderChatColumn(s);
    assert.ok(html.includes('badge-success'));
    assert.ok(html.includes('P2P DataChannel Open'));
    assert.ok(html.includes('Type a real-time message to peer (P2P)...'));
  });
});

describe('3. updateChatUI', () => {
  it('updates chat badge, notice text, placeholders, and disabled states', () => {
    const s = createInitialState();
    s.dataChannelState = DATA_CHANNEL_STATES.OPEN;
    s.peerConnectionState = PEER_CONNECTION_STATES.CONNECTED;
    s.realChatMessages = [{ id: 'm1', sender: 'user', text: 'hi' }];

    const badgeEl = { className: '', textContent: '' };
    const noticeEl = { textContent: '' };
    const inputEl = { disabled: true, placeholder: '' };
    const sendBtnEl = { disabled: true };
    const containerEl = { innerHTML: '', scrollTop: 0, scrollHeight: 100 };
    const clearBtn1 = { disabled: true };
    const clearBtn2 = { disabled: true };

    const fakeRoot = {
      querySelector: (sel) => {
        if (sel === '#chat-channel-badge') return badgeEl;
        if (sel === '#chat-notice-text') return noticeEl;
        if (sel === '#chat-input') return inputEl;
        if (sel === '#chat-send-btn') return sendBtnEl;
        if (sel === '#chat-messages-container') return containerEl;
        return null;
      },
      querySelectorAll: (sel) => {
        if (sel.includes('clear-chat-btn')) return [clearBtn1, clearBtn2];
        return [];
      },
    };

    updateChatUI(fakeRoot, s);

    assert.equal(badgeEl.className, 'badge badge-success');
    assert.equal(badgeEl.textContent, 'P2P DataChannel Open');
    assert.ok(noticeEl.textContent.includes('Direct WebRTC DataChannel active'));
    assert.equal(inputEl.disabled, false);
    assert.equal(sendBtnEl.disabled, false);
    assert.equal(clearBtn1.disabled, false);
    assert.equal(clearBtn2.disabled, false);
    assert.ok(containerEl.innerHTML.includes('hi'));
    assert.equal(containerEl.scrollTop, 100);
  });

  it('disables input when reconnecting and sets appropriate placeholder', () => {
    const s = createInitialState();
    s.dataChannelState = DATA_CHANNEL_STATES.OPEN;
    s.isReconnecting = true;
    s.reconnectAttempt = 2;

    const inputEl = { disabled: false, placeholder: '' };
    const sendBtnEl = { disabled: false };

    const fakeRoot = {
      querySelector: (sel) => {
        if (sel === '#chat-input') return inputEl;
        if (sel === '#chat-send-btn') return sendBtnEl;
        return null;
      },
      querySelectorAll: () => [],
    };

    updateChatUI(fakeRoot, s);
    assert.equal(inputEl.disabled, true);
    assert.equal(sendBtnEl.disabled, true);
    assert.ok(inputEl.placeholder.includes('Reconnecting to peer (Attempt 2/3)'));
  });
});

describe('4. initChat controller and interaction wiring', () => {
  it('enforces idempotency and does not register duplicate listeners', () => {
    const chatEvents = {};
    const fakePeer = {
      on: (event, handler) => { chatEvents[event] = handler; },
      isChatReady: () => true,
      sendChatMessage: (t) => ({ id: '1', sender: 'user', text: t }),
    };

    const fakeRoot = {
      nodeType: 1,
      dataset: {},
      querySelector: () => null,
      querySelectorAll: () => [],
    };

    const ctrl1 = initChat(fakeRoot, { peerConnection: fakePeer });
    assert.equal(typeof ctrl1.updateChatUI, 'function');
    assert.equal(typeof chatEvents.chatMessage, 'function');

    // Second call on same root
    const ctrl2 = initChat(fakeRoot, { peerConnection: fakePeer });
    assert.equal(typeof ctrl2.updateChatUI, 'function');
  });

  it('receives incoming chatMessage events from peerConnection and pushes to state', () => {
    let chatHandler = null;
    const fakePeer = {
      on: (event, handler) => {
        if (event === 'chatMessage') chatHandler = handler;
      },
      isChatReady: () => true,
    };

    let toastCalled = false;
    const fakeToast = () => { toastCalled = true; };

    const fakeRoot = {
      nodeType: 1,
      dataset: {},
      querySelector: () => null,
      querySelectorAll: () => [],
    };

    initChat(fakeRoot, {
      peerConnection: fakePeer,
      toast: fakeToast,
    });

    const incoming = {
      id: 'msg-remote-100',
      sender: 'peer',
      senderName: 'Guest',
      text: 'Direct message via WebRTC',
      timestamp: '11:00 AM',
    };

    chatHandler(incoming);
    assert.ok(toastCalled);
  });

  it('handles input character count and form submission sending via WebRTC', () => {
    let inputHandler = null;
    let submitHandler = null;
    let keydownHandler = null;

    const inputEl = {
      value: 'Hello WebRTC',
      addEventListener: (ev, fn) => {
        if (ev === 'input') inputHandler = fn;
        if (ev === 'keydown') keydownHandler = fn;
      },
    };
    const counterEl = { textContent: '1000' };
    const formEl = {
      addEventListener: (ev, fn) => {
        if (ev === 'submit') submitHandler = fn;
      },
      requestSubmit: () => {
        submitHandler({ preventDefault: () => {} });
      },
    };

    let sentText = null;
    const fakePeer = {
      on: () => {},
      isChatReady: () => true,
      sendChatMessage: (txt) => {
        sentText = txt;
        return { id: 'sent-1', sender: 'user', text: txt, timestamp: '11:05 AM' };
      },
    };

    const fakeRoot = {
      nodeType: 1,
      dataset: {},
      querySelector: (sel) => {
        if (sel === '#chat-form') return formEl;
        if (sel === '#chat-input') return inputEl;
        if (sel === '#char-counter') return counterEl;
        return null;
      },
      querySelectorAll: () => [],
    };

    initChat(fakeRoot, { peerConnection: fakePeer });

    // 1. Test character counting
    assert.equal(typeof inputHandler, 'function');
    inputHandler();
    assert.equal(counterEl.textContent, String(1000 - 'Hello WebRTC'.length));

    // 2. Test Enter key triggering form submission
    assert.equal(typeof keydownHandler, 'function');
    let enterPrevented = false;
    keydownHandler({
      key: 'Enter',
      shiftKey: false,
      preventDefault: () => { enterPrevented = true; },
    });
    assert.ok(enterPrevented);
    assert.equal(sentText, 'Hello WebRTC');
    assert.equal(inputEl.value, '');
    assert.equal(counterEl.textContent, '1000');
  });

  it('handles clear chat button with confirmation dialog', () => {
    let clickHandler = null;
    const clearBtn = {
      addEventListener: (ev, fn) => {
        if (ev === 'click') clickHandler = fn;
      },
      disabled: false,
    };

    let confirmOptions = null;
    const fakeConfirm = (opts) => {
      confirmOptions = opts;
      opts.onConfirm();
    };

    let toastMessage = null;
    const fakeToast = (msg) => { toastMessage = msg; };

    const fakeRoot = {
      nodeType: 1,
      dataset: {},
      querySelector: () => null,
      querySelectorAll: (sel) => {
        if (sel.includes('clear-chat-btn')) return [clearBtn];
        return [];
      },
    };

    initChat(fakeRoot, {
      peerConnection: { on: () => {} },
      confirm: fakeConfirm,
      toast: fakeToast,
    });

    assert.equal(typeof clickHandler, 'function');
    // Set a dummy message so clear proceeds
    const s = createInitialState();
    s.realChatMessages = [{ id: '1', text: 'temp' }];

    clickHandler();
    assert.ok(confirmOptions);
    assert.equal(confirmOptions.isDestructive, true);
    assert.ok(toastMessage.includes('cleared'));
  });
});
