import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLegacyTranscribePrompt,
  buildSegmentTranscribePrompt,
  buildLocalTranscribePrompt,
} from '../../../lib/prompts/transcribe.js';

test('buildLegacyTranscribePrompt: 규칙 + 전사 지시 + anti-loop 가드', () => {
  const prompt = buildLegacyTranscribePrompt();
  assert.match(prompt, /첨부된 한국어 회의 녹음을 정확히 전사하세요/);
  assert.match(prompt, /1\. 들리는 내용을 누락 없이 옮겨 쓸 것/);
  assert.match(prompt, /6\. 해설이나 요약 없이 들은 말만 옮겨 쓸 것/);
  assert.match(prompt, /7\. 같은 어절·음절이 3회 이상 반복되는 것으로 들리면.*\[불분명\]/);
  assert.doesNotMatch(prompt, /8\./); // legacy는 7번까지
});

test('buildSegmentTranscribePrompt: totalSegments 있으면 "N/M 번째" 문구 + anti-loop 가드', () => {
  const prompt = buildSegmentTranscribePrompt({ segmentIndex: 2, totalSegments: 5 });
  assert.match(prompt, /전체 회의 중 3\/5 번째 5분 구간/);
  assert.match(prompt, /7\. 같은 어절·음절이 3회 이상 반복/);
  assert.match(prompt, /8\. 구간 시작\/끝에 별도 표시/);
});

test('buildSegmentTranscribePrompt: totalSegments 없으면 "한 구간" 문구', () => {
  const prompt = buildSegmentTranscribePrompt({ segmentIndex: 0, totalSegments: null });
  assert.match(prompt, /이 오디오는 전체 회의의 한 구간입니다/);
  assert.doesNotMatch(prompt, /번째 5분 구간/);
});

test('buildSegmentTranscribePrompt: synonymHint 주입되면 말미에 붙음', () => {
  const hint = '\n\n[고유 용어]\n소울류, 카잔';
  const prompt = buildSegmentTranscribePrompt({ segmentIndex: 0, totalSegments: 3, synonymHint: hint });
  assert.ok(prompt.endsWith(hint), 'synonymHint가 프롬프트 끝에 붙어야 함');
});

test('buildLocalTranscribePrompt: 기본은 synonymHint 없음 + anti-loop 가드 포함', () => {
  const prompt = buildLocalTranscribePrompt();
  assert.match(prompt, /한 문장이 끝날 때마다 반드시 줄바꿈/);
  assert.match(prompt, /7\. 같은 어절·음절이 3회 이상 반복/);
  assert.match(prompt, /8\. 해설이나 요약 없이 들은 말만 옮겨 쓸 것$/);
  assert.doesNotMatch(prompt, /\[고유 용어\]/);
});

test('buildLocalTranscribePrompt: synonymHint 주입되면 말미에 붙음', () => {
  const hint = '\n\n[고유 용어]\n예시용';
  const prompt = buildLocalTranscribePrompt({ synonymHint: hint });
  assert.ok(prompt.endsWith(hint), 'synonymHint가 프롬프트 끝에 붙어야 함');
});
