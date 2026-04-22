import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCleanupTarget, summarizeBlobs } from '../../../lib/storage/usage.js';

// ─── isCleanupTarget ──────────────────────────────────────────────────────────

test('isCleanupTarget: 화이트리스트 3종 패턴 true', () => {
  assert.equal(isCleanupTarget('meetings/sid/seg-00/chunk-0000.bin'), true);
  assert.equal(isCleanupTarget('meetings/sid/seg-123/chunk-9999.bin'), true);
  assert.equal(isCleanupTarget('meetings/sid/transcript-00.raw.txt'), true);
  assert.equal(isCleanupTarget('meetings/sid/transcript-13.raw.txt'), true);
  assert.equal(isCleanupTarget('meetings/sid/transcript-00.meta.json'), true);
});

test('isCleanupTarget: 회복 경로 파생 파일은 false (절대 삭제 금지)', () => {
  assert.equal(isCleanupTarget('meetings/sid/transcript.txt'), false);
  assert.equal(isCleanupTarget('meetings/sid/transcript-00.txt'), false);
  assert.equal(isCleanupTarget('meetings/sid/transcript-99.txt'), false);
  assert.equal(isCleanupTarget('meetings/sid/result.json'), false);
});

test('isCleanupTarget: 우발 매칭 방어 (유사 이름)', () => {
  assert.equal(isCleanupTarget('meetings/sid/transcript-00.rawX.txt'), false);
  assert.equal(isCleanupTarget('meetings/sid/transcript-00.meta.json.bak'), false);
  assert.equal(isCleanupTarget('meetings/sid/seg-00/chunk-0000.binX'), false);
});

// ─── summarizeBlobs ───────────────────────────────────────────────────────────

const FIXED_NOW = Date.UTC(2026, 3, 23, 12, 0, 0); // 2026-04-23 12:00 UTC
const CUTOFF = FIXED_NOW - 24 * 60 * 60 * 1000;
const SID_A = '11111111-1111-1111-1111-111111111111';
const SID_B = '22222222-2222-2222-2222-222222222222';

function blob(pathname, { size = 100, uploadedAt = null, url } = {}) {
  return { pathname, size, uploadedAt, url: url ?? `http://x/${pathname}` };
}

test('summarizeBlobs: 빈 입력 → 모든 합계 0', () => {
  const out = summarizeBlobs([], { nowMs: FIXED_NOW, cutoffMs: CUTOFF });
  assert.equal(out.totalBytes, 0);
  assert.equal(out.totalFiles, 0);
  assert.equal(out.deletableBytes, 0);
  assert.equal(out.stuckBytes, 0);
  assert.deepEqual(out.sessions, []);
  assert.equal(out.cutoffIso, new Date(CUTOFF).toISOString());
});

test('summarizeBlobs: 진행 중(< 24h) 세션은 ageExceeds24h=false, deletable=0', () => {
  const recent = new Date(FIXED_NOW - 60 * 60 * 1000).toISOString(); // 1h ago
  const blobs = [
    blob(`meetings/${SID_A}/seg-00/chunk-0000.bin`, { size: 1000, uploadedAt: recent }),
    blob(`meetings/${SID_A}/transcript-00.meta.json`, { size: 300, uploadedAt: recent }),
    blob(`meetings/${SID_A}/transcript-00.txt`, { size: 500, uploadedAt: recent }),
  ];
  const out = summarizeBlobs(blobs, { nowMs: FIXED_NOW, cutoffMs: CUTOFF });
  assert.equal(out.sessions.length, 1);
  const s = out.sessions[0];
  assert.equal(s.ageExceeds24h, false);
  assert.equal(s.deletableBytes, 0);
  assert.equal(s.stuckBytes, 500); // transcript-00.txt가 화이트리스트 밖
  assert.equal(s.stuck, true);
  assert.equal(out.deletableBytes, 0);
  assert.equal(out.stuckBytes, 500);
});

test('summarizeBlobs: 24h+ 정상 세션은 화이트리스트 파일만 deletable', () => {
  const old = new Date(FIXED_NOW - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
  const blobs = [
    blob(`meetings/${SID_A}/seg-00/chunk-0000.bin`, { size: 1000, uploadedAt: old }),
    blob(`meetings/${SID_A}/transcript-00.meta.json`, { size: 300, uploadedAt: old }),
  ];
  const out = summarizeBlobs(blobs, { nowMs: FIXED_NOW, cutoffMs: CUTOFF });
  const s = out.sessions[0];
  assert.equal(s.ageExceeds24h, true);
  assert.equal(s.deletableBytes, 1300);
  assert.equal(s.stuckBytes, 0);
  assert.equal(s.stuck, false);
  assert.equal(out.deletableBytes, 1300);
});

test('summarizeBlobs: 24h+ failed-finalize 세션은 whitelist는 deletable, result.json은 stuck', () => {
  // Notion 페이지 생성 실패로 result.json/transcript.txt가 남은 24h 경과 세션.
  const old = new Date(FIXED_NOW - 25 * 60 * 60 * 1000).toISOString();
  const blobs = [
    blob(`meetings/${SID_A}/seg-00/chunk-0000.bin`, { size: 1000, uploadedAt: old }),
    blob(`meetings/${SID_A}/transcript-00.meta.json`, { size: 300, uploadedAt: old }),
    blob(`meetings/${SID_A}/transcript.txt`, { size: 5000, uploadedAt: old }),
    blob(`meetings/${SID_A}/result.json`, { size: 2000, uploadedAt: old }),
  ];
  const out = summarizeBlobs(blobs, { nowMs: FIXED_NOW, cutoffMs: CUTOFF });
  const s = out.sessions[0];
  assert.equal(s.ageExceeds24h, true);
  // whitelist만 deletable
  assert.equal(s.deletableBytes, 1300);
  // transcript.txt + result.json이 stuck
  assert.equal(s.stuckBytes, 7000);
  assert.equal(s.stuck, true);
  assert.equal(s.totalBytes, 8300);

  // 전역 불변식: totalBytes == deletableBytes(24h+ whitelist) + stuckBytes(모든 비-whitelist) + 진행중 whitelist(여기선 0)
  assert.equal(out.totalBytes, 8300);
  assert.equal(out.deletableBytes, 1300);
  assert.equal(out.stuckBytes, 7000);
});

test('summarizeBlobs: 여러 세션 혼합 (진행중 + 24h+ 정상 + 24h+ failed)', () => {
  const recent = new Date(FIXED_NOW - 60 * 60 * 1000).toISOString();
  const old = new Date(FIXED_NOW - 25 * 60 * 60 * 1000).toISOString();
  const blobs = [
    // 진행중 세션 A — 아직 24h 안 됨, 정상 파이프라인 중
    blob(`meetings/${SID_A}/seg-00/chunk-0000.bin`, { size: 2000, uploadedAt: recent }),
    blob(`meetings/${SID_A}/transcript-00.txt`, { size: 500, uploadedAt: recent }),
    // 24h+ failed-finalize 세션 B
    blob(`meetings/${SID_B}/seg-00/chunk-0000.bin`, { size: 1000, uploadedAt: old }),
    blob(`meetings/${SID_B}/result.json`, { size: 2000, uploadedAt: old }),
  ];
  const out = summarizeBlobs(blobs, { nowMs: FIXED_NOW, cutoffMs: CUTOFF });
  assert.equal(out.totalBytes, 5500);
  assert.equal(out.totalFiles, 4);
  // B의 whitelist 1000만 deletable
  assert.equal(out.deletableBytes, 1000);
  // A의 transcript-00.txt 500 + B의 result.json 2000 = 2500 stuck
  assert.equal(out.stuckBytes, 2500);
  assert.equal(out.stuckFiles, 2);
  // 세션은 newestUploadedAt 최신순 → A가 먼저
  assert.equal(out.sessions[0].sessionId, SID_A);
  assert.equal(out.sessions[1].sessionId, SID_B);
});

test('summarizeBlobs: 경계값 — newestUploadedAt == cutoff 정확히 일치하면 deletable', () => {
  const boundary = new Date(CUTOFF).toISOString();
  const blobs = [
    blob(`meetings/${SID_A}/seg-00/chunk-0000.bin`, { size: 100, uploadedAt: boundary }),
  ];
  const out = summarizeBlobs(blobs, { nowMs: FIXED_NOW, cutoffMs: CUTOFF });
  assert.equal(out.sessions[0].ageExceeds24h, true);
  assert.equal(out.deletableBytes, 100);
});

test('summarizeBlobs: uploadedAt=null 인 세션은 보수적으로 ageExceeds24h=false', () => {
  // 실사용에서 거의 없는 케이스지만 SDK가 uploadedAt 누락 반환 시 방어.
  const blobs = [
    blob(`meetings/${SID_A}/seg-00/chunk-0000.bin`, { size: 100, uploadedAt: null }),
  ];
  const out = summarizeBlobs(blobs, { nowMs: FIXED_NOW, cutoffMs: CUTOFF });
  assert.equal(out.sessions[0].ageExceeds24h, false);
  assert.equal(out.sessions[0].deletableBytes, 0);
});

test('summarizeBlobs: meetings/ 밖의 blob은 무시 (defensive)', () => {
  const blobs = [
    blob('other/foo.txt', { size: 999 }),
    blob(`meetings/${SID_A}/seg-00/chunk-0000.bin`, { size: 100, uploadedAt: new Date(FIXED_NOW - 25 * 3600e3).toISOString() }),
  ];
  const out = summarizeBlobs(blobs, { nowMs: FIXED_NOW, cutoffMs: CUTOFF });
  assert.equal(out.totalBytes, 100);
  assert.equal(out.sessions.length, 1);
});

test('summarizeBlobs: 회귀 가드 — 24h+ failed-finalize가 deletable에 섞이지 않음', () => {
  // P1 리뷰 반영의 핵심 불변식. result.json만 남은 세션이 24h 지나도
  // cleanup이 지울 수 없으니 deletableBytes로 집계되면 UI 숫자가 cleanup 결과와
  // 불일치하게 된다.
  const old = new Date(FIXED_NOW - 48 * 3600e3).toISOString();
  const blobs = [
    blob(`meetings/${SID_A}/result.json`, { size: 3000, uploadedAt: old }),
    blob(`meetings/${SID_A}/transcript.txt`, { size: 5000, uploadedAt: old }),
  ];
  const out = summarizeBlobs(blobs, { nowMs: FIXED_NOW, cutoffMs: CUTOFF });
  assert.equal(out.deletableBytes, 0);
  assert.equal(out.stuckBytes, 8000);
  assert.equal(out.sessions[0].stuck, true);
});
