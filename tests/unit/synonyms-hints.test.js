import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTranscribeSynonymHint,
  buildSummarizeSynonymHint,
} from '../../lib/synonyms.js';

const sampleSynonyms = [
  { correct: '아이템', misrecs: ['아이탬', '아템'], strategy: '무조건 치환', category: '시스템', note: '' },
  { correct: '밸런스', misrecs: ['벨런스'], strategy: '맥락 조건부', category: '', note: '수치 조정 얘기할 때' },
  { correct: '전투', misrecs: ['전두'], strategy: '수동 확인', category: '전투', note: '' },
];

test('buildTranscribeSynonymHint: 수동 확인 전략은 제외하고 정답 용어만 나열', () => {
  const hint = buildTranscribeSynonymHint(sampleSynonyms);
  assert.match(hint, /\[고유 용어\]/);
  assert.match(hint, /아이템, 밸런스/);
  assert.doesNotMatch(hint, /전투/); // 수동 확인
  assert.doesNotMatch(hint, /아이탬/); // 오인식 표기는 프라이밍 방지로 제외
});

test('buildTranscribeSynonymHint: 빈 배열이면 빈 문자열', () => {
  assert.equal(buildTranscribeSynonymHint([]), '');
});

test('buildTranscribeSynonymHint: 관련 전략 항목 없으면 빈 문자열', () => {
  const manualOnly = [{ correct: '전투', misrecs: ['전두'], strategy: '수동 확인', category: '', note: '' }];
  assert.equal(buildTranscribeSynonymHint(manualOnly), '');
});

test('buildSummarizeSynonymHint: 매핑 섹션 + 노트 섹션', () => {
  const hint = buildSummarizeSynonymHint(sampleSynonyms);
  assert.match(hint, /\[전사 오류 보정 가이드/);
  assert.match(hint, /"아이탬", "아템" → \*\*아이템\*\* \[시스템\]/);
  assert.match(hint, /\[유의어 맥락 메모\]/);
  assert.match(hint, /- 밸런스: 수치 조정 얘기할 때/);
  // 수동 확인 항목은 매핑 섹션에 안 들어가야 함
  assert.doesNotMatch(hint, /"전두"/);
});

test('buildSummarizeSynonymHint: 빈 배열이면 빈 문자열', () => {
  assert.equal(buildSummarizeSynonymHint([]), '');
});

test('buildSummarizeSynonymHint: 노트 없고 매핑만 있는 경우', () => {
  const input = [{ correct: '아이템', misrecs: ['아이탬'], strategy: '무조건 치환', category: '', note: '' }];
  const hint = buildSummarizeSynonymHint(input);
  assert.match(hint, /\[전사 오류 보정 가이드/);
  assert.doesNotMatch(hint, /\[유의어 맥락 메모\]/);
});
