import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMeetingPageBlocks,
  buildEvidenceBlocks,
} from '../../../lib/notion/page-builder.js';

// 스냅샷 기반 회귀 테스트. 블록 트리는 구조가 크고 수기 비교가 어려워
// JSON 스냅샷으로 고정. 의도된 변경 시 UPDATE_SNAPSHOTS=1 로 재기록.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.join(__dirname, '__snapshots__');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

function matchSnapshot(name, actual) {
  const file = path.join(SNAPSHOT_DIR, `${name}.snap.json`);
  const serialized = JSON.stringify(actual, null, 2);
  if (UPDATE || !fs.existsSync(file)) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(file, serialized + '\n', 'utf-8');
    return;
  }
  const expected = fs.readFileSync(file, 'utf-8').replace(/\n$/, '');
  assert.equal(serialized, expected, `snapshot mismatch — set UPDATE_SNAPSHOTS=1 if intended: ${file}`);
}

// ── 샘플 데이터 ────────────────────────────────────────────────────
// 신 schema (decisions/todos/discussion.points 가 { text, sourceQuote })
const evidencedData = {
  title: '전투 시스템 리뷰',
  topic: '피격 판정 개선 방향',
  meetingType: '정기',
  labels: ['전투', '시스템'],
  agenda: [
    { title: '현황 공유', items: ['지난 주 이슈', '신규 리포트'] },
    { title: '개선안 토론', items: [] },
  ],
  discussion: [
    {
      topic: '히트박스',
      points: [
        { text: '현재 히트박스가 시각적 범위보다 크다', sourceQuote: '눈으로 보기에 박스가 너무 넓어요' },
        { text: '근거 없는 추정', sourceQuote: '' },
      ],
    },
    {
      topic: '데미지 수식',
      points: [
        { text: '기본 데미지 공식 재검토 필요', sourceQuote: '공식을 다시 봐야 할 것 같아요' },
      ],
    },
  ],
  decisions: [
    { text: '히트박스를 10% 축소', sourceQuote: '10% 정도 줄이는 방향으로 합시다' },
    { text: '근거 없는 결정', sourceQuote: '' },
  ],
  todos: [
    { text: '프로토 구현 (홍길동)', sourceQuote: '홍길동님이 프로토 만들어 주세요' },
  ],
};

// 구 schema (string 배열) 호환
const legacyData = {
  title: '긴급 핫픽스 회의',
  topic: '',
  meetingType: '긴급',
  labels: [],
  agenda: [],
  discussion: [
    { topic: '원인', points: ['서버 재시작 필요'] },
  ],
  decisions: ['핫픽스 즉시 배포'],
  todos: ['배포 후 모니터링'],
};

// ── 스냅샷 테스트 ──────────────────────────────────────────────────

test('buildMeetingPageBlocks: 전체 메타+본문+진단 토글 (transcript 업로드 포함)', () => {
  const blocks = buildMeetingPageBlocks(evidencedData, { id: 'upl_123', charCount: 12345 });
  matchSnapshot('evidenced-with-transcript', blocks);
});

test('buildMeetingPageBlocks: transcript 업로드 없음 (진단 토글은 근거 섹션만)', () => {
  const blocks = buildMeetingPageBlocks(evidencedData, null);
  matchSnapshot('evidenced-no-transcript', blocks);
});

test('buildMeetingPageBlocks: 구 schema (plain string 항목) 호환', () => {
  const blocks = buildMeetingPageBlocks(legacyData, null);
  matchSnapshot('legacy-string-items', blocks);
});

test('buildMeetingPageBlocks: 완전히 빈 회의 (플레이스홀더 블록)', () => {
  const blocks = buildMeetingPageBlocks({
    title: '빈 회의',
    topic: '',
    meetingType: '정기',
    labels: [],
    agenda: [],
    discussion: [],
    decisions: [],
    todos: [],
  }, null);
  matchSnapshot('empty-meeting', blocks);
});

// ── 구조 검증 (스냅샷 외 명시적 불변식) ────────────────────────────

test('buildMeetingPageBlocks: 최상위 블록 순서 (column_list → divider → heading_2 × 4 → to_do → [divider + toggle])', () => {
  const blocks = buildMeetingPageBlocks(evidencedData, { id: 'x', charCount: 1 });
  const types = blocks.map((b) => b.type);
  // 앞부분 고정 순서
  assert.equal(types[0], 'column_list');
  assert.equal(types[1], 'divider');
  // heading_2 네 섹션 (아젠다, 논의, 결정, To-do)
  const h2Titles = blocks
    .filter((b) => b.type === 'heading_2')
    .map((b) => b.heading_2.rich_text[0].text.content);
  assert.deepEqual(h2Titles, ['📌 아젠다', '💬 논의 사항', '🎯 결정 사항', '✅ To-do']);
  // 진단 토글이 마지막
  assert.equal(types.at(-1), 'toggle');
  assert.equal(types.at(-2), 'divider');
});

test('buildMeetingPageBlocks: todos 비어있으면 빈 체크박스 하나 생성', () => {
  const blocks = buildMeetingPageBlocks({
    title: 't', topic: '', meetingType: '정기', labels: [],
    agenda: [], discussion: [], decisions: [], todos: [],
  }, null);
  const todoBlocks = blocks.filter((b) => b.type === 'to_do');
  assert.equal(todoBlocks.length, 1);
  assert.equal(todoBlocks[0].to_do.rich_text[0].text.content, '');
  assert.equal(todoBlocks[0].to_do.checked, false);
});

test('buildMeetingPageBlocks: 아젠다/논의/결정 비어있으면 "(...없음)" 플레이스홀더', () => {
  const blocks = buildMeetingPageBlocks({
    title: 't', topic: '', meetingType: '정기', labels: [],
    agenda: [], discussion: [], decisions: [], todos: [],
  }, null);
  const bullets = blocks.filter((b) => b.type === 'bulleted_list_item');
  const contents = bullets.map((b) => b.bulleted_list_item.rich_text[0].text.content);
  assert.ok(contents.includes('(명시된 아젠다 없음)'));
  assert.ok(contents.includes('(논의 내용 없음)'));
  assert.ok(contents.includes('(결정된 사항 없음)'));
});

test('buildMeetingPageBlocks: 전부 비어있으면 진단 토글 자체가 생략', () => {
  const blocks = buildMeetingPageBlocks({
    title: 't', topic: '', meetingType: '정기', labels: [],
    agenda: [], discussion: [], decisions: [], todos: [],
  }, null);
  assert.equal(blocks.some((b) => b.type === 'toggle'), false);
});

test('buildEvidenceBlocks: sourceQuote 있으면 회색 이탤릭, 없으면 빨간 ⚠️', () => {
  const blocks = buildEvidenceBlocks({
    agenda: [], discussion: [],
    decisions: [
      { text: 'with quote', sourceQuote: '근거 인용' },
      { text: 'no quote', sourceQuote: '' },
    ],
    todos: [],
  }, null);
  // heading3 + 두 개의 bullet
  const bulletBlocks = blocks.filter((b) => b.type === 'bulleted_list_item');
  assert.equal(bulletBlocks.length, 2);
  const withQuote = bulletBlocks[0].bulleted_list_item.rich_text;
  assert.equal(withQuote[1].annotations.color, 'gray');
  assert.ok(withQuote[1].text.content.includes('「근거 인용」'));
  const noQuote = bulletBlocks[1].bulleted_list_item.rich_text;
  assert.equal(noQuote[1].annotations.color, 'red');
  assert.ok(noQuote[1].text.content.includes('⚠️ 근거 없음'));
});

test('buildEvidenceBlocks: 100자 초과 인용은 말줄임표로 절단', () => {
  const longQuote = '가'.repeat(150);
  const blocks = buildEvidenceBlocks({
    agenda: [], discussion: [],
    decisions: [{ text: 'x', sourceQuote: longQuote }],
    todos: [],
  }, null);
  const rich = blocks.find((b) => b.type === 'bulleted_list_item').bulleted_list_item.rich_text;
  const quotePart = rich[1].text.content;
  assert.ok(quotePart.endsWith('…」'));
  // 「 + 100자 + … + 」 + 선행 공백 2개
  assert.equal(quotePart.length, '  「'.length + 100 + 1 + 1);
});

test('buildEvidenceBlocks: transcriptUpload 주면 file block 이 맨 앞', () => {
  const blocks = buildEvidenceBlocks({
    agenda: [], discussion: [],
    decisions: [{ text: 'x', sourceQuote: 'y' }],
    todos: [],
  }, { id: 'upl_abc', charCount: 9876 });
  assert.equal(blocks[0].type, 'file');
  assert.equal(blocks[0].file.file_upload.id, 'upl_abc');
  assert.ok(blocks[0].file.caption[0].text.content.includes('9,876자'));
});

test('buildEvidenceBlocks: 빈 데이터 + transcript 없음 → 빈 배열', () => {
  const blocks = buildEvidenceBlocks({
    agenda: [], discussion: [], decisions: [], todos: [],
  }, null);
  assert.deepEqual(blocks, []);
});
