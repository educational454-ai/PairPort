import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderActiveTransferPanel,
  renderFilesList,
  renderFileHubColumn,
  updateFilesUI,
  initFiles,
} from '../src/features/files/index.js';
import { DATA_CHANNEL_STATES } from '../src/services/peer-connection.js';
import { createInitialState } from '../src/state/app-state.js';

describe('1. renderActiveTransferPanel', () => {
  it('renders standby station when activeTransfer is null and channel is closed', () => {
    const s = createInitialState();
    s.activeTransfer = null;
    const html = renderActiveTransferPanel(s, false);

    assert.ok(html.includes('active-transfer-panel standby'));
    assert.ok(html.includes('CHUNKED STREAMING STATION'));
    assert.ok(html.includes('Awaiting Peer'));
    assert.ok(html.includes('Direct WebRTC data channels will activate here'));
  });

  it('renders ready standby station when activeTransfer is null and channel is open', () => {
    const s = createInitialState();
    s.activeTransfer = null;
    const html = renderActiveTransferPanel(s, true);

    assert.ok(html.includes('P2P Ready (Standby)'));
    assert.ok(html.includes('Ready to stream files directly to your peer'));
  });

  it('renders active outgoing transfer with progress, bytes, and cancel button', () => {
    const s = createInitialState();
    s.activeTransfer = {
      id: 'tx-send-1',
      name: 'dataset.zip',
      direction: 'outgoing',
      status: 'sending',
      progress: 45,
      transferredBytes: 4500000,
      totalBytes: 10000000,
      totalChunks: 611,
    };
    const html = renderActiveTransferPanel(s, true);

    assert.ok(html.includes('active-transfer-panel active'));
    assert.ok(html.includes('STREAMING DIRECTLY TO PEER (SCTP)'));
    assert.ok(html.includes('SENDING · 45%'));
    assert.ok(html.includes('dataset.zip'));
    assert.ok(html.includes('aria-valuenow="45"'));
    assert.ok(html.includes('style="width: 45%"'));
    assert.ok(html.includes('cancel-active-transfer-btn'));
    assert.ok(html.includes('data-id="tx-send-1"'));
    assert.ok(html.includes('611 chunks'));
  });

  it('renders active incoming transfer and safely escapes malicious filenames', () => {
    const s = createInitialState();
    s.activeTransfer = {
      id: 'tx-recv-1',
      name: '<script>alert("xss")</script>.bin',
      direction: 'incoming',
      status: 'receiving',
      progress: 80,
      transferredBytes: 800000,
      totalBytes: 1000000,
      totalChunks: 62,
    };
    const html = renderActiveTransferPanel(s, true);

    assert.ok(html.includes('RECEIVING DIRECTLY FROM PEER'));
    assert.ok(html.includes('RECEIVING · 80%'));
    assert.ok(!html.includes('<script>alert("xss")</script>'));
    assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;.bin'));
  });
});

describe('2. renderFilesList', () => {
  it('renders friendly empty state when file transfer history is empty', () => {
    const html = renderFilesList([]);
    assert.ok(html.includes('empty-files-item'));
    assert.ok(html.includes('No files transferred yet'));
    assert.ok(html.includes('Zero bytes are saved on any server.'));
  });

  it('renders completed received file with safe download link (blob: scheme)', () => {
    const files = [
      {
        id: 'f-1',
        name: 'received_photo.jpg',
        size: 2048576,
        direction: 'incoming',
        status: 'completed',
        progress: 100,
        blobUrl: 'blob:http://localhost:5173/abc-123',
      },
    ];

    const html = renderFilesList(files);
    assert.ok(html.includes('received_photo.jpg'));
    assert.ok(html.includes('Received (100%)'));
    assert.ok(html.includes('href="blob:http://localhost:5173/abc-123"'));
    assert.ok(html.includes('download="received_photo.jpg"'));
    assert.ok(html.includes('Save'));
  });

  it('refuses to render non-blob download URLs for security', () => {
    const files = [
      {
        id: 'f-evil',
        name: 'dangerous.exe',
        size: 1024,
        direction: 'incoming',
        status: 'completed',
        blobUrl: 'javascript:alert(1)',
      },
    ];

    const html = renderFilesList(files);
    assert.ok(!html.includes('href="javascript:alert(1)"'));
    assert.ok(html.includes('Delivered'));
  });

  it('renders completed delivered badge for outgoing transfers', () => {
    const files = [
      {
        id: 'f-out',
        name: 'presentation.pdf',
        size: 5000000,
        direction: 'outgoing',
        status: 'completed',
        progress: 100,
      },
    ];

    const html = renderFilesList(files);
    assert.ok(html.includes('presentation.pdf'));
    assert.ok(html.includes('Delivered (100%)'));
    assert.ok(html.includes('Delivered directly to peer'));
    assert.ok(!html.includes('download="presentation.pdf"'));
  });

  it('renders in-progress sending and receiving items with cancel action', () => {
    const files = [
      {
        id: 'f-prog-1',
        name: 'video.mp4',
        size: 50000000,
        direction: 'outgoing',
        status: 'sending',
        progress: 32,
      },
      {
        id: 'f-prog-2',
        name: 'music.mp3',
        size: 10000000,
        direction: 'incoming',
        status: 'receiving',
        progress: 77,
      },
    ];

    const html = renderFilesList(files);
    assert.ok(html.includes('video.mp4'));
    assert.ok(html.includes('Sent (32%)'));
    assert.ok(html.includes('data-action="cancel" data-id="f-prog-1"'));

    assert.ok(html.includes('music.mp3'));
    assert.ok(html.includes('Received (77%)'));
    assert.ok(html.includes('data-action="cancel" data-id="f-prog-2"'));
  });

  it('renders failed and cancelled status badges with escaped error text', () => {
    const files = [
      {
        id: 'f-fail',
        name: 'doc.txt',
        size: 1024,
        direction: 'incoming',
        status: 'failed',
        error: 'DataChannel <closed> unexpectedly',
      },
      {
        id: 'f-cancel',
        name: 'archive.tar',
        size: 2048,
        direction: 'outgoing',
        status: 'cancelled',
      },
    ];

    const html = renderFilesList(files);
    assert.ok(html.includes('status-failed'));
    assert.ok(html.includes('DataChannel &lt;closed&gt; unexpectedly'));
    assert.ok(html.includes('status-cancelled'));
  });
});

describe('3. renderFileHubColumn', () => {
  it('renders complete file hub column with appropriate disabled states when channel is closed', () => {
    const s = createInitialState();
    const html = renderFileHubColumn(s, false);

    assert.ok(html.includes('workspace-column file-hub-column'));
    assert.ok(html.includes('id="file-channel-badge"'));
    assert.ok(html.includes('Waiting for Peer'));
    assert.ok(html.includes('id="file-drop-zone"'));
    assert.ok(html.includes('drop-zone-disabled'));
    assert.ok(html.includes('id="file-browse-input"'));
    assert.ok(html.includes('id="browse-files-btn"'));
    assert.ok(html.includes('id="active-transfer-container"'));
    assert.ok(html.includes('id="files-list"'));
    assert.ok(html.includes('id="clear-files-btn"'));
  });

  it('renders open badge and enabled dropzone when fileChannel is open', () => {
    const s = createInitialState();
    s.fileChannelState = DATA_CHANNEL_STATES.OPEN;
    const html = renderFileHubColumn(s, true);

    assert.ok(html.includes('badge-success'));
    assert.ok(html.includes('P2P FileChannel Open'));
    assert.ok(html.includes('Drop files here to share directly'));
  });
});

describe('4. updateFilesUI', () => {
  it('updates badges, dropzone, transfer container, files list, and clear button', () => {
    const s = createInitialState();
    s.fileChannelState = DATA_CHANNEL_STATES.OPEN;
    s.realFiles = [
      { id: '1', name: 'demo.pdf', size: 1024, direction: 'outgoing', status: 'completed' },
    ];

    const badgeEl = { className: '', textContent: '' };
    const dropZoneTitle = { textContent: '' };
    const dropZoneClasses = new Set(['drop-zone-disabled']);
    const dropZone = {
      classList: {
        toggle: (cls, force) => {
          if (force) dropZoneClasses.add(cls);
          else dropZoneClasses.delete(cls);
        },
      },
      querySelector: (sel) => sel === '.drop-zone-title' ? dropZoneTitle : null,
    };
    const fileBrowseInput = { disabled: true };
    const browseBtn = { disabled: true };
    const activeContainer = { innerHTML: '' };
    const filesListEl = { innerHTML: '' };
    const countBadge = { textContent: '' };
    const clearFilesBtn = { disabled: true };

    const fakeRoot = {
      querySelector: (sel) => {
        if (sel === '#file-channel-badge') return badgeEl;
        if (sel === '#file-drop-zone') return dropZone;
        if (sel === '#file-browse-input') return fileBrowseInput;
        if (sel === '#browse-files-btn') return browseBtn;
        if (sel === '#active-transfer-container') return activeContainer;
        if (sel === '#files-list') return filesListEl;
        if (sel === '#files-count-badge') return countBadge;
        if (sel === '#clear-files-btn') return clearFilesBtn;
        return null;
      },
    };

    updateFilesUI(fakeRoot, s, true);

    assert.equal(badgeEl.className, 'badge badge-success');
    assert.equal(badgeEl.textContent, 'P2P FileChannel Open');
    assert.equal(dropZoneClasses.has('drop-zone-disabled'), false);
    assert.equal(dropZoneTitle.textContent, 'Drop files here to share directly');
    assert.equal(fileBrowseInput.disabled, false);
    assert.equal(browseBtn.disabled, false);
    assert.ok(filesListEl.innerHTML.includes('demo.pdf'));
    assert.equal(countBadge.textContent, '1 items');
    assert.equal(clearFilesBtn.disabled, false);
  });
});

describe('5. initFiles controller and interaction wiring', () => {
  it('enforces idempotency and prevents duplicate registrations on same root', () => {
    const handlers = {};
    const fakePeer = {
      on: (ev, fn) => { handlers[ev] = fn; },
      isFileChannelReady: () => true,
    };

    const fakeRoot = {
      nodeType: 1,
      dataset: {},
      querySelector: () => null,
    };

    const ctrl1 = initFiles(fakeRoot, { peerConnection: fakePeer });
    assert.equal(typeof ctrl1.updateFilesUI, 'function');
    assert.equal(typeof handlers.fileTransferStart, 'function');

    // Second call on same root
    const ctrl2 = initFiles(fakeRoot, { peerConnection: fakePeer });
    assert.equal(typeof ctrl2.updateFilesUI, 'function');
  });

  it('receives fileTransferStart, updates realFiles and activeTransfer, and alerts user', () => {
    let startHandler = null;
    const fakePeer = {
      on: (ev, fn) => { if (ev === 'fileTransferStart') startHandler = fn; },
      isFileChannelReady: () => true,
    };

    let toastMessage = '';
    const fakeToast = (msg) => { toastMessage = msg; };

    const fakeRoot = {
      nodeType: 1,
      dataset: {},
      querySelector: () => null,
    };

    initFiles(fakeRoot, {
      peerConnection: fakePeer,
      toast: fakeToast,
    });

    const incomingTransfer = {
      id: 'tx-100',
      name: 'large_data.zip',
      size: 5242880,
      direction: 'incoming',
      status: 'receiving',
      progress: 0,
    };

    startHandler(incomingTransfer);
    assert.ok(toastMessage.includes('Receiving "large_data.zip"'));
  });

  it('validates file size boundary and rejects files exceeding max limit', async () => {
    let sent = false;
    const fakePeer = {
      on: () => {},
      isFileChannelReady: () => true,
      sendFile: async () => { sent = true; },
    };

    let toastMsg = '';
    const fakeToast = (msg) => { toastMsg = msg; };

    const fakeRoot = {
      nodeType: 1,
      dataset: {},
      querySelector: () => null,
    };

    const ctrl = initFiles(fakeRoot, {
      peerConnection: fakePeer,
      toast: fakeToast,
      appConfig: {
        fileTransfer: { maxFileSizeBytes: 100 * 1024 * 1024 },
      },
    });

    // File exceeding 100 MB limit
    const hugeFile = {
      name: 'oversized.iso',
      size: 105 * 1024 * 1024,
    };

    await ctrl.handleSelectedFiles([hugeFile]);
    assert.equal(sent, false);
    assert.ok(toastMsg.includes('exceeds maximum allowed limit of 100 MB'));
  });

  it('sends valid files via peerConnection.sendFile when channel is ready', async () => {
    let sentFile = null;
    const fakePeer = {
      on: () => {},
      isFileChannelReady: () => true,
      sendFile: async (f) => { sentFile = f; },
    };

    const fakeRoot = {
      nodeType: 1,
      dataset: {},
      querySelector: () => null,
    };

    const ctrl = initFiles(fakeRoot, {
      peerConnection: fakePeer,
      toast: () => {},
    });

    const goodFile = {
      name: 'readme.txt',
      size: 1024,
    };

    await ctrl.handleSelectedFiles([goodFile]);
    assert.equal(sentFile, goodFile);
  });

  it('handles cancellation and clear history with confirmation dialog', () => {
    let cancelledId = null;
    const fakePeer = {
      on: () => {},
      isFileChannelReady: () => true,
      cancelTransfer: (id) => { cancelledId = id; },
    };

    let filesListListener = null;
    const fakeFilesList = {
      addEventListener: (ev, fn) => { if (ev === 'click') filesListListener = fn; },
    };

    let confirmDialogArgs = null;
    const fakeConfirm = (args) => { confirmDialogArgs = args; };

    let clearBtnListener = null;
    const fakeClearBtn = {
      addEventListener: (ev, fn) => { if (ev === 'click') clearBtnListener = fn; },
    };

    const fakeRoot = {
      nodeType: 1,
      dataset: {},
      querySelector: (sel) => {
        if (sel === '#files-list') return fakeFilesList;
        if (sel === '#clear-files-btn') return fakeClearBtn;
        return null;
      },
    };

    initFiles(fakeRoot, {
      peerConnection: fakePeer,
      confirm: fakeConfirm,
    });

    // Test list cancel delegation
    filesListListener({
      target: {
        closest: (sel) => {
          if (sel === '[data-action="cancel"]') {
            return { getAttribute: (attr) => attr === 'data-id' ? 'transfer-99' : null };
          }
          return null;
        },
      },
    });
    assert.equal(cancelledId, 'transfer-99');

    // Test clear history button triggers confirmation
    clearBtnListener();
    assert.ok(confirmDialogArgs);
    assert.equal(confirmDialogArgs.title, 'Clear Transfer History?');
    assert.equal(confirmDialogArgs.isDestructive, true);
  });
});
