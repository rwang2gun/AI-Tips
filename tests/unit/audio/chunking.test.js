import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  concatBlobChunks,
  mergeSegmentTranscripts,
  selectSegmentTranscriptBlobs,
} from '../../../lib/audio/chunking.js';

test('concatBlobChunks: pathname 기준 정렬 후 순서대로 결합', async () => {
  const blobs = [
    { url: 'u/c2', pathname: 'meetings/x/chunk-0002.bin' },
    { url: 'u/c0', pathname: 'meetings/x/chunk-0000.bin' },
    { url: 'u/c1', pathname: 'meetings/x/chunk-0001.bin' },
  ];
  const fetcher = async (url) => Buffer.from(url.split('/').pop()); // c0/c1/c2
  const out = await concatBlobChunks(blobs, fetcher);
  assert.equal(out.toString(), 'c0c1c2');
});

test('concatBlobChunks: 입력 배열은 변경되지 않음 (정렬은 사본에서)', async () => {
  const blobs = [
    { url: 'b', pathname: 'b' },
    { url: 'a', pathname: 'a' },
  ];
  const original = [...blobs];
  await concatBlobChunks(blobs, async () => Buffer.alloc(0));
  assert.deepEqual(blobs, original);
});

test('mergeSegmentTranscripts: 5분 마커 + 트림 + 빈 줄 결합', async () => {
  const segs = [
    { url: 'u/0', pathname: 'p/transcript-00.txt' },
    { url: 'u/1', pathname: 'p/transcript-01.txt' },
  ];
  const fetcher = async (url) => (url.endsWith('/0') ? '  안녕  ' : '\n다음 구간\n');
  const out = await mergeSegmentTranscripts(segs, fetcher);
  assert.equal(
    out,
    '--- [0:00 ~ 5:00] ---\n안녕\n\n--- [5:00 ~ 10:00] ---\n다음 구간',
  );
});

test('selectSegmentTranscriptBlobs: transcript-NN.txt 형식만 골라 정렬', () => {
  const blobs = [
    { pathname: 'meetings/x/transcript-02.txt' },
    { pathname: 'meetings/x/transcript-00.txt' },
    { pathname: 'meetings/x/transcript.txt' }, // 본 파일은 제외
    { pathname: 'meetings/x/transcript-01.txt' },
    { pathname: 'meetings/x/result.json' }, // 무관
  ];
  const out = selectSegmentTranscriptBlobs(blobs);
  assert.deepEqual(
    out.map((b) => b.pathname),
    [
      'meetings/x/transcript-00.txt',
      'meetings/x/transcript-01.txt',
      'meetings/x/transcript-02.txt',
    ],
  );
});

test('selectSegmentTranscriptBlobs: 100+ 세그먼트 숫자 정렬 (localeCompare 회귀 방지)', () => {
  const blobs = [
    { pathname: 'meetings/x/transcript-100.txt' },
    { pathname: 'meetings/x/transcript-02.txt' },
    { pathname: 'meetings/x/transcript-13.txt' },
    { pathname: 'meetings/x/transcript-99.txt' },
  ];
  const out = selectSegmentTranscriptBlobs(blobs);
  assert.deepEqual(
    out.map((b) => b.pathname),
    [
      'meetings/x/transcript-02.txt',
      'meetings/x/transcript-13.txt',
      'meetings/x/transcript-99.txt',
      'meetings/x/transcript-100.txt',
    ],
  );
});

test('selectSegmentTranscriptBlobs: raw.txt / meta.json sidecar 제외', () => {
  const blobs = [
    { pathname: 'meetings/x/transcript-00.txt' },
    { pathname: 'meetings/x/transcript-00.raw.txt' },
    { pathname: 'meetings/x/transcript-00.meta.json' },
    { pathname: 'meetings/x/transcript-01.txt' },
  ];
  const out = selectSegmentTranscriptBlobs(blobs);
  assert.deepEqual(
    out.map((b) => b.pathname),
    [
      'meetings/x/transcript-00.txt',
      'meetings/x/transcript-01.txt',
    ],
  );
});
