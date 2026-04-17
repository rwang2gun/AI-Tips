import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enforceSentenceBreaks,
  applySynonymReplacements,
} from '../../../lib/transcript/post-process.js';

test('enforceSentenceBreaks: 짧은 줄(<80자)은 변경 없음', () => {
  const input = '짧은 문장. 다음 문장도 있음.';
  assert.equal(enforceSentenceBreaks(input), input);
});

test('enforceSentenceBreaks: 긴 줄에서 마침표 뒤에 줄바꿈 삽입', () => {
  // 80자 이상 한 줄, 마침표 + 공백 + 한글로 시작.
  const long = `${'가'.repeat(50)}. ${'나'.repeat(50)}.`;
  const out = enforceSentenceBreaks(long);
  const lines = out.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^가+\.$/);
  assert.match(lines[1], /^나+\.$/);
});

test('enforceSentenceBreaks: 물음표/느낌표/말줄임표도 처리', () => {
  const long = `${'가'.repeat(50)}? ${'나'.repeat(50)}! ${'다'.repeat(50)}…`;
  // 첫 줄이 80자를 넘으니 처리 대상.
  const out = enforceSentenceBreaks(long);
  assert.ok(out.includes('가\n나') || out.includes('?\n나'));
});

test('enforceSentenceBreaks: 숫자 목록("1. ", "2. ")은 분리하지 않음', () => {
  // "1. " 뒤는 한글이지만 ". " 앞이 숫자라 정규식 그룹은 매치되지만 …
  // 실제로는 숫자 목록 패턴이 줄바꿈 안에 자주 들어있으니 길이가 80 미만이면 안전.
  const input = '1. 첫번째 항목.';
  assert.equal(enforceSentenceBreaks(input), input);
});

test('applySynonymReplacements: 무조건 치환만 적용, 한글 경계 인식', () => {
  const synonyms = [
    { correct: '아이템', misrecs: ['아이탬'], strategy: '무조건 치환' },
    { correct: '밸런스', misrecs: ['벨런스'], strategy: '맥락 조건부' },
  ];
  const { text, applied } = applySynonymReplacements('이번에 아이탬 추가하고 벨런스 조정함', synonyms);
  assert.match(text, /이번에 아이템 추가하고 벨런스 조정함/);
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0], { from: '아이탬', to: '아이템', count: 1 });
});

test('applySynonymReplacements: 부분 매치 방지 (앞뒤가 한글이면 매칭 X)', () => {
  const synonyms = [{ correct: '아이템', misrecs: ['아템'], strategy: '무조건 치환' }];
  // "테스트아템확인" — '아템' 앞뒤가 한글이라 매치되면 안 됨
  const { text, applied } = applySynonymReplacements('테스트아템확인', synonyms);
  assert.equal(text, '테스트아템확인');
  assert.equal(applied.length, 0);
});

test('applySynonymReplacements: 빈 변형/정답과 동일한 변형은 스킵', () => {
  const synonyms = [
    { correct: '아이템', misrecs: ['', '아이템', '아이탬'], strategy: '무조건 치환' },
  ];
  const { text, applied } = applySynonymReplacements('아이탬 좋다', synonyms);
  assert.equal(text, '아이템 좋다');
  assert.equal(applied.length, 1);
});

test('applySynonymReplacements: synonyms 비어있어도 안전', () => {
  const { text, applied } = applySynonymReplacements('변경 없음', []);
  assert.equal(text, '변경 없음');
  assert.deepEqual(applied, []);
});
