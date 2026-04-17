import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscriptFilename } from '../../../lib/notion/file-upload.js';

test('buildTranscriptFilename: 기본 형식', () => {
  assert.equal(
    buildTranscriptFilename('회의', '2026-04-17'),
    '전사원문_2026-04-17_회의.txt',
  );
});

test('buildTranscriptFilename: 공백은 언더스코어로 치환', () => {
  assert.equal(
    buildTranscriptFilename('전투 시스템 회의', '2026-04-17'),
    '전사원문_2026-04-17_전투_시스템_회의.txt',
  );
});

test('buildTranscriptFilename: 금지 문자 제거', () => {
  assert.equal(
    buildTranscriptFilename('test/path:title?', '2026-04-17'),
    '전사원문_2026-04-17_testpathtitle.txt',
  );
});

test('buildTranscriptFilename: 80자 초과 제목 잘림', () => {
  const long = 'A'.repeat(120);
  const filename = buildTranscriptFilename(long, '2026-04-17');
  assert.equal(filename, `전사원문_2026-04-17_${'A'.repeat(80)}.txt`);
});

test('buildTranscriptFilename: title 없음 → untitled', () => {
  assert.equal(
    buildTranscriptFilename(null, '2026-04-17'),
    '전사원문_2026-04-17_untitled.txt',
  );
});
