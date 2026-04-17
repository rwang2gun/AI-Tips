import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSummarizePrompt,
  buildRefineTopicPrompt,
} from '../../../lib/prompts/summarize.js';

const meta = { requestedTitle: 'T', requestedMeetingType: '내부 논의', durationSec: 120, date: '2026-04-17' };

test('buildSummarizePrompt: 메타 JSON + 전사문 포함', () => {
  const prompt = buildSummarizePrompt({ meetingMeta: meta, transcript: 'hello transcript' });
  assert.match(prompt, /게임 기획 회의록 정리 전문가/);
  assert.match(prompt, /"requestedTitle": "T"/);
  assert.match(prompt, /hello transcript/);
  assert.match(prompt, /\[작성 규칙\]/);
});

test('buildSummarizePrompt: glossary/guide/synonym 순서는 glossary→synonym→guide', () => {
  const prompt = buildSummarizePrompt({
    meetingMeta: meta,
    transcript: 'X',
    glossaryText: '\nGLOSSARY\n',
    synonymHint: '\nSYN\n',
    guideText: '\nGUIDE\n',
  });
  const gIdx = prompt.indexOf('GLOSSARY');
  const sIdx = prompt.indexOf('SYN');
  const guideIdx = prompt.indexOf('GUIDE');
  assert.ok(gIdx < sIdx && sIdx < guideIdx, '순서가 glossary < synonym < guide 여야 함');
});

test('buildSummarizePrompt: api 호환 형태 (synonymHint 없음) — glossary 바로 뒤에 guide', () => {
  const prompt = buildSummarizePrompt({
    meetingMeta: meta,
    transcript: 'X',
    glossaryText: 'A',
    guideText: 'B',
  });
  assert.match(prompt, /AB/); // synonymHint 기본값 '' 이라 A와 B가 연달아 붙어야 함
});

test('buildRefineTopicPrompt: 제목/topic/agenda 섹션 포함', () => {
  const prompt = buildRefineTopicPrompt({
    meetingData: {
      title: '회의제목',
      topic: '아주 긴 현재 토픽'.repeat(5),
      agenda: [{ title: 'A안건' }, { title: 'B안건' }],
    },
  });
  assert.match(prompt, /회의제목/);
  assert.match(prompt, /- A안건/);
  assert.match(prompt, /- B안건/);
  assert.match(prompt, /50자 이내 한 문장/);
});

test('buildRefineTopicPrompt: agenda 없으면 아젠다 섹션 생략', () => {
  const prompt = buildRefineTopicPrompt({
    meetingData: { title: 'T', topic: '짧은 토픽', agenda: [] },
  });
  assert.doesNotMatch(prompt, /\[아젠다 제목들\]/);
});
