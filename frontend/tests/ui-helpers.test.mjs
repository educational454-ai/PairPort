/**
 * PairPort Phase 8 — Unit Tests for UI Helpers
 * Tests:
 *  - validateRoomCode validation, error states, and normalization
 *  - formatFileSize human-readable conversions and edge cases
 *  - formatTime time string outputs
 *  - escapeHtml XSS protection
 *  - filterClearableFiles safe history clearing protecting active streaming
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateRoomCode,
  formatFileSize,
  formatTime,
  escapeHtml,
  filterClearableFiles,
} from '../src/utils/ui-helpers.js';

test('1. validateRoomCode rules and normalization', async (t) => {
  await t.test('validates standard room codes', () => {
    assert.deepEqual(validateRoomCode('PORT-8492'), {
      isValid: true,
      code: 'PORT-8492',
      error: null,
      message: 'Valid room code format.',
    });

    assert.deepEqual(validateRoomCode('PORT-7K2M9X'), {
      isValid: true,
      code: 'PORT-7K2M9X',
      error: null,
      message: 'Valid room code format.',
    });

    assert.equal(validateRoomCode('abc123').code, 'ABC123');
    assert.equal(validateRoomCode('  7k2m  ').code, '7K2M');
    assert.equal(validateRoomCode('7K2M').isValid, true);
    assert.equal(validateRoomCode('  7k2m9x  ').code, '7K2M9X');
    assert.equal(validateRoomCode('7K2M9X').isValid, true);
  });

  await t.test('rejects empty or whitespace room codes', () => {
    assert.equal(validateRoomCode('').isValid, false);
    assert.equal(validateRoomCode('   ').isValid, false);
    assert.equal(validateRoomCode(null).isValid, false);
    assert.equal(validateRoomCode(undefined).isValid, false);
  });

  await t.test('rejects codes that are too short or too long', () => {
    const tooShort = validateRoomCode('AB');
    assert.equal(tooShort.isValid, false);
    assert.equal(tooShort.error, 'TOO_SHORT');

    const tooLong = validateRoomCode('A'.repeat(17));
    assert.equal(tooLong.isValid, false);
    assert.equal(tooLong.error, 'TOO_LONG');
  });

  await t.test('rejects invalid characters', () => {
    const invalidChar = validateRoomCode('PORT@123');
    assert.equal(invalidChar.isValid, false);
    assert.equal(invalidChar.error, 'INVALID_CHARACTERS');

    const withSpace = validateRoomCode('PORT 123');
    assert.equal(withSpace.isValid, false);
    assert.equal(withSpace.error, 'INVALID_CHARACTERS');
  });
});

test('2. formatFileSize formatting and boundaries', async (t) => {
  await t.test('formats zero and negative values to 0 Bytes', () => {
    assert.equal(formatFileSize(0), '0 Bytes');
    assert.equal(formatFileSize(-100), '0 Bytes');
    assert.equal(formatFileSize(null), '0 Bytes');
    assert.equal(formatFileSize(NaN), '0 Bytes');
  });

  await t.test('formats byte ranges accurately', () => {
    assert.equal(formatFileSize(512), '512 Bytes');
    assert.equal(formatFileSize(1024), '1 KB');
    assert.equal(formatFileSize(1536), '1.5 KB');
    assert.equal(formatFileSize(1048576), '1 MB');
    assert.equal(formatFileSize(52428800), '50 MB');
    assert.equal(formatFileSize(1073741824), '1 GB');
  });
});

test('3. formatTime output formatting', async (t) => {
  await t.test('formats valid dates to readable strings', () => {
    const d = new Date(2026, 0, 15, 14, 30);
    const timeStr = formatTime(d);
    assert.ok(timeStr.includes(':'));
  });

  await t.test('handles invalid date inputs gracefully', () => {
    assert.equal(formatTime('invalid-date'), '');
  });
});

test('4. escapeHtml XSS protection', async (t) => {
  await t.test('escapes HTML tags and script elements', () => {
    const malicious = '<script>alert("xss")</script>';
    const escaped = escapeHtml(malicious);
    assert.ok(!escaped.includes('<script>'));
    assert.ok(escaped.includes('&lt;script&gt;'));
  });

  await t.test('escapes quotes and ampersands', () => {
    const input = 'Tom & "Jerry" \'s file';
    const escaped = escapeHtml(input);
    assert.ok(escaped.includes('&amp;'));
    assert.ok(escaped.includes('&quot;'));
    assert.ok(escaped.includes('&#039;'));
  });

  await t.test('handles null and undefined safely', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });
});

test('5. filterClearableFiles safe history clearing', async (t) => {
  const sampleFiles = [
    { id: 'f-1', name: 'completed.pdf', status: 'completed' },
    { id: 'f-2', name: 'active.zip', status: 'sending' },
    { id: 'f-3', name: 'failed.txt', status: 'failed' },
    { id: 'f-4', name: 'cancelled.jpg', status: 'cancelled' },
  ];

  await t.test('protects in-flight streaming transfers while marking completed for clearing', () => {
    const { filesToKeep, filesToClear } = filterClearableFiles(sampleFiles, 'f-2');

    assert.equal(filesToKeep.length, 1);
    assert.equal(filesToKeep[0].id, 'f-2');

    assert.equal(filesToClear.length, 3);
    assert.deepEqual(filesToClear.map(f => f.id), ['f-1', 'f-3', 'f-4']);
  });

  await t.test('handles empty lists gracefully', () => {
    const result = filterClearableFiles([]);
    assert.deepEqual(result, { filesToKeep: [], filesToClear: [] });
  });
});
