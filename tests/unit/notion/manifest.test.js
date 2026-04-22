import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, buildManifestFilename } from '../../../lib/notion/manifest.js';

// buildManifest는 listBlobs / fetchImpl를 DI 파라미터로 받아 테스트 가능.
// (ES 모듈 namespace는 sealed라 모듈 export 몽키패치는 불가.)
function makeFetchImpl(urlMap) {
  return async (url) => {
    if (!(url in urlMap)) throw new Error(`unexpected fetch: ${url}`);
    const entry = urlMap[url];
    const body = typeof entry === 'string' ? entry : JSON.stringify(entry);
    return {
      ok: true,
      async text() { return body; },
      async json() { return typeof entry === 'object' ? entry : JSON.parse(body); },
    };
  };
}

const baseArgs = {
  sessionId: '12345678-1234-1234-1234-123456789012',
  title: '테스트 회의',
  date: '2026-04-22',
  segmentSeconds: 300,
  summarizeModel: 'gemini-2.5-pro',
  startedAtIso: '2026-04-22T10:00:00Z',
  endedAtIso: '2026-04-22T11:12:00Z',
  durationSec: 4320,
  finalizedAtIso: '2026-04-22T11:15:00Z',
  transcriptMergedChars: 24883,
  resultJsonSize: 4200,
};

test('buildManifest: 기본 출력 구조 + flagged 0이면 경고 섹션 생략', async () => {
  const blobs = [
    { pathname: `meetings/${baseArgs.sessionId}/transcript-00.txt`, url: 'http://t/0', size: 1200 },
    { pathname: `meetings/${baseArgs.sessionId}/transcript-01.txt`, url: 'http://t/1', size: 1300 },
    { pathname: `meetings/${baseArgs.sessionId}/result.json`, url: 'http://r/0', size: 4200 },
  ];
  const { text, flaggedSegments } = await buildManifest({
    ...baseArgs,
    listBlobs: async () => blobs,
    fetchImpl: makeFetchImpl({
      'http://t/0': '안녕하세요 회의를 시작하겠습니다.',
      'http://t/1': '두번째 구간 내용입니다.',
    }),
  });
  assert.ok(text.includes('# 회의록 파이프라인 진행 로그'));
  assert.ok(text.includes(`Session ID     : ${baseArgs.sessionId}`));
  assert.ok(text.includes('SEGMENT_SECONDS: 300'));
  assert.ok(text.includes('Summarize 모델 : gemini-2.5-pro'));
  assert.ok(text.includes('transcript-NN.txt (2개)'));
  assert.ok(text.includes('발견된 세그먼트: 2개'));
  assert.ok(text.includes('누락된 인덱스  : 없음'));
  assert.ok(text.includes('출력 transcript.txt: 24,883자'));
  assert.ok(!text.includes('## 전사 품질 경고'));
  assert.deepEqual(flaggedSegments, []);
});

test('buildManifest: flagged 세그먼트 있으면 경고 섹션 + flaggedSegments 반환', async () => {
  const sid = baseArgs.sessionId;
  const blobs = [
    { pathname: `meetings/${sid}/transcript-00.txt`, url: 'http://t/0', size: 1200 },
    { pathname: `meetings/${sid}/transcript-01.txt`, url: 'http://t/1', size: 50 },
    { pathname: `meetings/${sid}/transcript-01.raw.txt`, url: 'http://r/1', size: 50 },
    { pathname: `meetings/${sid}/transcript-01.meta.json`, url: 'http://m/1', size: 300 },
    { pathname: `meetings/${sid}/seg-01/chunk-0000.bin`, url: 'http://a/1', size: 1024 },
  ];
  const { text, flaggedSegments, retentionIndices } = await buildManifest({
    ...baseArgs,
    listBlobs: async () => blobs,
    fetchImpl: makeFetchImpl({
      'http://t/0': '정상 전사',
      'http://t/1': '짧음',
      'http://r/1': '짧음 raw',
      'http://m/1': {
        segmentIndex: 1,
        model: 'gemini-2.5-flash',
        finishReason: 'STOP',
        rawLength: 17,
        rawByteLength: 50,
        normalizedLength: 17,
        loopDetected: false,
        longestRun: null,
        flagged: true,
      },
    }),
  });
  assert.ok(text.includes('## 전사 품질 경고'));
  assert.ok(text.includes('flagged 세그먼트 1개'));
  assert.ok(text.includes('[01]'));
  assert.ok(text.includes('short rawBytes=50'));
  assert.ok(text.includes('retention: raw.txt, 오디오'));
  assert.equal(flaggedSegments.length, 1);
  assert.equal(flaggedSegments[0].index, 1);
  assert.equal(flaggedSegments[0].flagged, true);
  assert.ok(retentionIndices.has(1));
});

test('buildManifest: meta 업로드 실패해도 raw.txt 있으면 retentionIndices 포함 (P1 회귀 방어)', async () => {
  const sid = baseArgs.sessionId;
  // meta.json은 누락, raw.txt만 남아 있는 시나리오 — sidecar upload 일부 실패 복구 경로.
  const blobs = [
    { pathname: `meetings/${sid}/transcript-00.txt`, url: 'http://t/0', size: 1200 },
    { pathname: `meetings/${sid}/transcript-00.raw.txt`, url: 'http://r/0', size: 1200 },
    { pathname: `meetings/${sid}/seg-00/chunk-0000.bin`, url: 'http://a/0', size: 1024 },
  ];
  const { text, flaggedSegments, retentionIndices } = await buildManifest({
    ...baseArgs,
    listBlobs: async () => blobs,
    fetchImpl: makeFetchImpl({
      'http://t/0': '...',
      'http://r/0': '...',
    }),
  });
  // meta가 없으니 flaggedSegments는 비어 있지만 retentionIndices는 raw.txt 기준으로 보존.
  assert.equal(flaggedSegments.length, 0);
  assert.ok(retentionIndices.has(0));
  // 경고 섹션은 flaggedSegments 기준이라 미출력 (운영상 허용 가능한 trade-off).
  assert.ok(!text.includes('## 전사 품질 경고'));
});

test('buildManifest: loop 탐지된 flagged 세그먼트는 longest run 요약 노출', async () => {
  const sid = baseArgs.sessionId;
  const blobs = [
    { pathname: `meetings/${sid}/transcript-00.txt`, url: 'http://t/0', size: 5000 },
    { pathname: `meetings/${sid}/transcript-00.raw.txt`, url: 'http://r/0', size: 5000 },
    { pathname: `meetings/${sid}/transcript-00.meta.json`, url: 'http://m/0', size: 400 },
  ];
  const { text, flaggedSegments } = await buildManifest({
    ...baseArgs,
    listBlobs: async () => blobs,
    fetchImpl: makeFetchImpl({
      'http://t/0': '첫 문장. ' + '그'.repeat(50),
      'http://r/0': '첫 문장. ' + '그'.repeat(50),
      'http://m/0': {
        segmentIndex: 0,
        model: 'gemini-2.5-flash',
        finishReason: 'STOP',
        rawLength: 5000,
        normalizedLength: 5000,
        loopDetected: true,
        longestRun: { token: '그', count: 50, start: 10, chars: 50 },
        flagged: true,
      },
    }),
  });
  assert.ok(text.includes('## 전사 품질 경고'));
  assert.ok(text.includes('loop (longest="그"×50, 50자)'));
  assert.equal(flaggedSegments[0].loopDetected, true);
});

test('buildManifest: transcript 없으면 merge 섹션 명시적 안내', async () => {
  const { text } = await buildManifest({
    ...baseArgs,
    listBlobs: async () => [],
    fetchImpl: makeFetchImpl({}),
  });
  assert.ok(text.includes('transcript-NN.txt 없음 — merge 실행 안 됐거나 전사 전부 실패'));
});

test('buildManifestFilename: 특수문자 제거 + 공백 → 언더스코어', () => {
  const out = buildManifestFilename('기획 회의/첫번째', '2026-04-22');
  assert.equal(out, '진행로그_2026-04-22_기획_회의첫번째.txt');
});
