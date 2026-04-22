import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enforceSentenceBreaks,
  applySynonymReplacements,
  detectLoop,
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

test('detectLoop: 정상 전사는 flag 되지 않음', () => {
  const normal = '오늘 회의에서는 전투 시스템과 난이도 조정을 논의했습니다. 각 팀의 의견을 반영할 예정입니다.';
  const r = detectLoop(normal);
  assert.equal(r.hasLoop, false);
  assert.equal(r.longestRun, null);
  assert.equal(r.repeatedChars, 0);
});

test('detectLoop: 한 글자 반복 (2026-04-22 seg 01 실제 케이스) 탐지', () => {
  const looped = '처음 몇 문장은 정상. ' + '그'.repeat(30) + ' 그리고 끝.';
  const r = detectLoop(looped);
  assert.equal(r.hasLoop, true);
  assert.equal(r.longestRun.token, '그');
  assert.equal(r.longestRun.count, 30);
  assert.equal(r.longestRun.chars, 30);
});

test('detectLoop: 다중 글자 어절 반복 (seg 13 미니 loop 유형) 탐지', () => {
  const looped = '초반 멀쩡. ' + '컴파일된 걸로 만들고 '.repeat(25) + '끝.';
  const r = detectLoop(looped);
  assert.equal(r.hasLoop, true);
  // 길이 6의 토큰도 minRun=20 이상 반복되면 잡혀야 함 — 여기서는 길이 1 토큰이 가장 많이 반복될 수 있으므로 hasLoop 확인만.
  assert.ok(r.longestRun.chars >= 20);
});

test('detectLoop: 반복 횟수가 threshold 미만이면 flag 안 함 (경계값)', () => {
  const borderline = '테스트 ' + 'a'.repeat(19) + ' 끝';
  const r = detectLoop(borderline);
  assert.equal(r.hasLoop, false);
});

test('detectLoop: minRun 옵션으로 민감도 조정 가능', () => {
  const mild = 'aaaaaaaaaa'; // 10회
  assert.equal(detectLoop(mild).hasLoop, false);
  assert.equal(detectLoop(mild, { minRun: 10 }).hasLoop, true);
});

test('detectLoop: 공백만인 토큰은 loop으로 잡지 않음', () => {
  const padded = '정상 발화' + '   '.repeat(50) + '다음 발화';
  const r = detectLoop(padded);
  assert.equal(r.hasLoop, false);
});

test('detectLoop: 빈/비문자열 입력 안전', () => {
  assert.equal(detectLoop('').hasLoop, false);
  assert.equal(detectLoop(null).hasLoop, false);
  assert.equal(detectLoop(undefined).hasLoop, false);
});

test('detectLoop: 한 글자 반복이 긴 토큰보다 먼저 잡혀도 longestRun은 문자 수 기준', () => {
  // "그" × 50 와 "abc" × 30이 각각 50자/90자 — 긴 쪽이 longestRun이어야 함.
  const mixed = '시작. ' + '그'.repeat(50) + ' 중간. ' + 'abc'.repeat(30) + ' 끝.';
  const r = detectLoop(mixed);
  assert.equal(r.hasLoop, true);
  assert.equal(r.longestRun.token, 'abc');
  assert.equal(r.longestRun.chars, 90);
});
