/**
 * PairPort Phase 5 — Unit Tests for WebRTC Peer-to-Peer File Transfer
 * Covers:
 *  - Filename sanitization and path traversal neutralization
 *  - Binary chunk packing/unpacking and bit-for-bit payload fidelity
 *  - Maximum file size boundary checks and rejection
 *  - Receiver chunk ordering, bounds checking, and duplicate prevention
 *  - Integrity verification on file-complete (exact chunk count & byte match)
 *  - Transfer cancellation and memory cleanup
 *  - Progress calculation and 99% capping before full verification
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeFilename,
  packChunk,
  unpackChunk,
  CHUNK_HEADER_SIZE,
  TRANSFER_STATES,
  PeerConnectionService,
} from '../src/services/peer-connection.js';
import { APP_CONFIG } from '../src/config/app-config.js';

test('1. sanitizeFilename security and edge cases', async (t) => {
  await t.test('preserves clean filenames', () => {
    assert.equal(sanitizeFilename('report_2026.pdf'), 'report_2026.pdf');
    assert.equal(sanitizeFilename('photo.final.v2.jpg'), 'photo.final.v2.jpg');
    assert.equal(sanitizeFilename('my-archive.tar.gz'), 'my-archive.tar.gz');
  });

  await t.test('strips Unix directory traversal and path prefixes', () => {
    assert.equal(sanitizeFilename('../../../etc/passwd'), 'passwd');
    assert.equal(sanitizeFilename('/var/log/syslog'), 'syslog');
    assert.equal(sanitizeFilename('dir/subdir/file.txt'), 'file.txt');
  });

  await t.test('strips Windows directory traversal and path prefixes', () => {
    assert.equal(sanitizeFilename('..\\..\\Windows\\System32\\cmd.exe'), 'cmd.exe');
    assert.equal(sanitizeFilename('C:\\Users\\Admin\\Desktop\\secret.key'), 'secret.key');
    assert.equal(sanitizeFilename('D:\\data\\export.csv'), 'export.csv');
  });

  await t.test('removes control characters and null bytes', () => {
    assert.equal(sanitizeFilename('my\x00file\x07name.txt'), 'myfilename.txt');
    assert.equal(sanitizeFilename('test\x1f\x7f.doc'), 'test.doc');
  });

  await t.test('neutralizes multiple dots and empty inputs to safe fallback', () => {
    assert.equal(sanitizeFilename(''), 'unnamed_file');
    assert.equal(sanitizeFilename(null), 'unnamed_file');
    assert.equal(sanitizeFilename(undefined), 'unnamed_file');
    assert.equal(sanitizeFilename('   '), 'unnamed_file');
    assert.equal(sanitizeFilename('....'), 'unnamed_file');
    assert.equal(sanitizeFilename('..'), 'unnamed_file');
  });

  await t.test('truncates excessively long filenames to 255 characters', () => {
    const longName = 'a'.repeat(300) + '.txt';
    const sanitized = sanitizeFilename(longName);
    assert.equal(sanitized.length, 255);
  });
});

test('2. Binary chunk packing and unpacking fidelity', async (t) => {
  await t.test('packs and unpacks small payloads with exact byte fidelity', () => {
    const transferId = 'file-test-12345';
    const chunkIndex = 0;
    const rawData = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);

    const packedBuffer = packChunk(transferId, chunkIndex, rawData);
    assert.equal(packedBuffer.byteLength, CHUNK_HEADER_SIZE + rawData.byteLength);

    const unpacked = unpackChunk(packedBuffer);
    assert.equal(unpacked.transferId, transferId);
    assert.equal(unpacked.chunkIndex, 0);

    const unpackedBytes = new Uint8Array(unpacked.payload);
    assert.deepEqual(Array.from(unpackedBytes), Array.from(rawData));
  });

  await t.test('supports 32-bit chunk indices and max transfer ID lengths', () => {
    const transferId = 'abcdefghijklmnopqrstuvwxyz012345'; // exactly 32 chars
    const chunkIndex = 123456;
    const payload = new Uint8Array(1024).fill(0xaa);

    const packed = packChunk(transferId, chunkIndex, payload);
    const unpacked = unpackChunk(packed);

    assert.equal(unpacked.transferId, transferId);
    assert.equal(unpacked.chunkIndex, 123456);
    assert.equal(unpacked.payload.byteLength, 1024);
    assert.equal(new Uint8Array(unpacked.payload)[500], 0xaa);
  });

  await t.test('rejects buffers smaller than header size or null', () => {
    assert.throws(() => unpackChunk(null), /Malformed chunk/);
    assert.throws(() => unpackChunk(new ArrayBuffer(10)), /Malformed chunk/);
    assert.throws(() => unpackChunk(new ArrayBuffer(35)), /Malformed chunk/);
  });
});

test('3. Maximum file size configuration and sender boundary validation', async (t) => {
  const service = new PeerConnectionService();
  const maxBytes = APP_CONFIG.fileTransfer.maxFileSizeBytes;

  assert.equal(service.maxFileSizeBytes, 100 * 1024 * 1024); // 100 MiB default

  await t.test('rejects sendFile if file channel is not open', async () => {
    await assert.rejects(
      async () => {
        await service.sendFile({ name: 'test.pdf', size: 1024, type: 'application/pdf' });
      },
      /WebRTC file channel is not open/
    );
  });

  await t.test('rejects files exceeding maximum allowed size before sending', async () => {
    // Mock open fileChannel
    service.fileChannel = {
      readyState: 'open',
      send: () => {},
      bufferedAmount: 0,
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    const oversizedFile = {
      name: 'giant_movie.iso',
      size: maxBytes + 1, // 100MB + 1 byte
      type: 'application/octet-stream',
    };

    await assert.rejects(
      async () => {
        await service.sendFile(oversizedFile);
      },
      /exceeds maximum allowed limit/
    );
  });
});

test('4. Receiver flow: chunk ordering, duplicate filtering, bounds checking, and integrity', async (t) => {
  const service = new PeerConnectionService();
  const transferId = 'transfer-p2p-test-001';
  const fileSize = 40;
  const chunkSize = 16;
  const totalChunks = 3; // 16 + 16 + 8 bytes

  const startMsg = {
    type: 'file-start',
    transferId,
    name: 'sample_doc.txt',
    size: fileSize,
    mimeType: 'text/plain',
    totalChunks,
    chunkSize,
  };

  // 1. Process file-start
  service._handleFileStart(startMsg);
  const transfer = service.activeTransfers.get(transferId);
  assert.ok(transfer, 'Transfer must be tracked in activeTransfers');
  assert.equal(transfer.status, TRANSFER_STATES.RECEIVING);
  assert.equal(transfer.name, 'sample_doc.txt');
  assert.equal(transfer.transferredBytes, 0);

  // 2. Process chunk 0 (16 bytes)
  const chunk0Data = new Uint8Array(16).fill(0x30); // '0'
  const chunk0Packet = packChunk(transferId, 0, chunk0Data);
  service._handleFileChunk(chunk0Packet);

  assert.equal(transfer.transferredBytes, 16);
  assert.equal(transfer.receivedIndices.size, 1);
  assert.equal(transfer.progress, 40); // 16/40 = 40%

  // 3. Process duplicate chunk 0 (must be ignored)
  service._handleFileChunk(chunk0Packet);
  assert.equal(transfer.transferredBytes, 16, 'Duplicate chunk must not increase byte count');
  assert.equal(transfer.receivedIndices.size, 1);

  // 4. Process chunk with index out of bounds (must be rejected)
  const oobPacket = packChunk(transferId, 5, new Uint8Array(8));
  service._handleFileChunk(oobPacket);
  assert.equal(transfer.receivedIndices.size, 1, 'Out of bounds chunk must be ignored');

  // 5. Incomplete transfer verification failure
  service._handleFileComplete({ transferId });
  assert.equal(transfer.status, TRANSFER_STATES.FAILED, 'Incomplete chunks must cause file verification to fail');
  assert.match(transfer.error, /Integrity verification failed/);

  // 6. Test fresh valid transfer to completion
  const validId = 'transfer-p2p-complete-002';
  service._handleFileStart({
    type: 'file-start',
    transferId: validId,
    name: 'hello.txt',
    size: 10,
    mimeType: 'text/plain',
    totalChunks: 1,
    chunkSize: 16,
  });

  const validTransfer = service.activeTransfers.get(validId);
  const chunkData = new Uint8Array([72, 101, 108, 108, 111, 33, 33, 33, 33, 33]); // 10 bytes
  const validPacket = packChunk(validId, 0, chunkData);
  service._handleFileChunk(validPacket);

  assert.equal(validTransfer.transferredBytes, 10);
  // Verify progress is capped at 99% until file-complete verification
  assert.equal(validTransfer.progress, 99, 'Progress must cap at 99% before file-complete verification');

  // Mock URL.createObjectURL in Node environment if missing
  if (typeof URL.createObjectURL !== 'function') {
    URL.createObjectURL = (blob) => `blob:http://localhost/mock-${Math.random().toString(36).slice(2)}`;
    URL.revokeObjectURL = () => {};
  }

  service._handleFileComplete({ transferId: validId });
  assert.equal(validTransfer.status, TRANSFER_STATES.COMPLETED);
  assert.equal(validTransfer.progress, 100);
  assert.ok(validTransfer.blobUrl.startsWith('blob:'));
  assert.equal(validTransfer.receivedChunks, null, 'Raw chunk arrays must be cleared to prevent memory leaks');
});

test('5. Cancellation handling and cleanup', async (t) => {
  const service = new PeerConnectionService();
  const transferId = 'transfer-cancel-test';

  let cancelledEventFired = false;
  service.on('fileTransferCancelled', (e) => {
    if (e.id === transferId) {
      cancelledEventFired = true;
    }
  });

  service._handleFileStart({
    type: 'file-start',
    transferId,
    name: 'cancelled.pdf',
    size: 5000,
    mimeType: 'application/pdf',
    totalChunks: 2,
    chunkSize: 2500,
  });

  service.cancelTransfer(transferId, 'User cancelled transfer');

  const transfer = service.activeTransfers.get(transferId);
  assert.equal(transfer.status, TRANSFER_STATES.CANCELLED);
  assert.equal(transfer.isCancelled, true);
  assert.equal(transfer.receivedChunks, null);
  assert.equal(cancelledEventFired, true);
});
