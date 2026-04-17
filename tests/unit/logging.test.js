import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logError, _internal } from '../../lib/logging.js';

const { sanitizeSessionId, formatBody } = _internal;

test('sanitizeSessionId: UUID v4 형식만 통과', () => {
  assert.equal(sanitizeSessionId('abcdef12-3456-7890-abcd-ef1234567890'), 'abcdef12-3456-7890-abcd-ef1234567890');
  assert.equal(sanitizeSessionId(null), 'unknown');
  assert.equal(sanitizeSessionId(undefined), 'unknown');
  assert.equal(sanitizeSessionId(''), 'unknown');
  assert.equal(sanitizeSessionId('../etc/passwd'), 'unknown');
  assert.equal(sanitizeSessionId('short-id'), 'unknown');
});

test('formatBody: sessionId/action/message/stack 포함', () => {
  const err = new Error('boom');
  err.stack = 'Error: boom\n  at test';
  const body = formatBody({
    sessionId: 'abc',
    action: 'summarize',
    err,
    meta: {},
  });
  assert.match(body, /sessionId: abc/);
  assert.match(body, /action: summarize/);
  assert.match(body, /message: boom/);
  assert.match(body, /--- stack ---/);
  assert.match(body, /at test/);
});

test('formatBody: meta 객체가 있으면 JSON으로 포함', () => {
  const err = new Error('x');
  const body = formatBody({
    sessionId: 'sid',
    action: 'upload-chunk',
    err,
    meta: { action: 'upload-chunk', method: 'POST' },
  });
  assert.match(body, /--- meta ---/);
  assert.match(body, /"method": "POST"/);
});

test('formatBody: err.cause 가 있으면 포함', () => {
  const err = new Error('outer', { cause: new Error('inner') });
  const body = formatBody({ sessionId: 'sid', action: 'x', err, meta: {} });
  assert.match(body, /cause: inner/);
});

test('logError: putPublic을 logs/session-<sid>-<ts>.txt 키로 호출', async () => {
  const calls = [];
  const mockPut = async (key, body, opts) => {
    calls.push({ key, body, opts });
  };
  const sid = 'abcdef12-3456-7890-abcd-ef1234567890';
  const key = await logError(sid, new Error('fail'), { action: 'summarize' }, { put: mockPut });

  assert.equal(calls.length, 1);
  assert.match(calls[0].key, new RegExp(`^logs/session-${sid}-.*\\.txt$`));
  assert.equal(calls[0].opts.contentType, 'text/plain; charset=utf-8');
  assert.match(calls[0].body, /message: fail/);
  assert.match(calls[0].body, /action: summarize/);
  assert.equal(key, calls[0].key);
});

test('logError: sessionId null → "unknown" 로 저장', async () => {
  const calls = [];
  const mockPut = async (key, body) => { calls.push({ key, body }); };
  await logError(null, new Error('x'), {}, { put: mockPut });
  assert.match(calls[0].key, /^logs\/session-unknown-.*\.txt$/);
});

test('logError: put이 throw 해도 예외를 삼키고 null 반환', async () => {
  const mockPut = async () => { throw new Error('blob offline'); };
  const result = await logError('abcdef12-3456-7890-abcd-ef1234567890', new Error('x'), {}, { put: mockPut });
  assert.equal(result, null);
});

test('logError: 파일명의 타임스탬프에 콜론 없음 (S3/Blob 키 호환)', async () => {
  const calls = [];
  const mockPut = async (key) => { calls.push(key); };
  await logError('abcdef12-3456-7890-abcd-ef1234567890', new Error('x'), {}, { put: mockPut });
  assert.doesNotMatch(calls[0], /:/);
});
