// 스토리지 사용량 집계 + cleanup 화이트리스트 정의 — 순수 함수, 외부 의존성 없음.
//
// 단일 소스(single source of truth) 원칙:
//   - api/handlers/storage-usage.js 가 집계 숫자를 반환할 때도
//   - api/handlers/cleanup-old-audio.js 가 실제 삭제 대상을 고를 때도
//   같은 isCleanupTarget()을 쓴다. 드리프트 방지 + cleanup 실행 후
//   remainingTotalBytes == prev.totalBytes - prev.deletableBytes 불변식 보장.

// cleanup-old-audio가 삭제 가능한 blob 경로 패턴(세션 24h 초과 전제).
// 아래에 매칭되지 않는 파일(transcript.txt, transcript-NN.txt, result.json 등)은
// Notion 생성 실패 시 복구 경로를 위해 절대 건드리지 않는다.
const CLEANUP_WHITELIST = [
  /\/seg-\d+\/chunk-\d+\.bin$/,        // 오디오 청크
  /\/transcript-\d+\.raw\.txt$/,        // flagged 세그먼트의 raw 전사 (flagged만 존재)
  /\/transcript-\d+\.meta\.json$/,      // per-segment 진단 메타데이터
];

const SESSION_RE = /^meetings\/([0-9a-f-]{36})\//;

export function isCleanupTarget(pathname) {
  return CLEANUP_WHITELIST.some((re) => re.test(pathname));
}

// blob[] 를 세션별로 집계해 storage-usage 응답 shape으로 반환.
//
// 입력:
//   blobs: [{ pathname, size?, url?, uploadedAt? }] — Vercel Blob list() 결과
//   opts:
//     nowMs    — 기준 현재 시각 (ms since epoch). 테스트에서 고정값 주입 가능.
//     cutoffMs — 24h 경계 (보통 nowMs - 24*60*60*1000). blob.uploadedAt이
//                이 값 이하인 세션을 ageExceeds24h로 판정.
//
// 반환 shape:
//   {
//     totalBytes, totalFiles,
//     deletableBytes, deletableFiles,   // 화이트리스트 파일 × 24h+ 세션
//     stuckBytes, stuckFiles,           // 비-화이트리스트 파일 × 모든 세션 (failed-finalize 잔존물)
//     cutoffIso,
//     sessions: [{ sessionId, totalBytes, deletableBytes, stuckBytes,
//                  files, oldestUploadedAtIso, newestUploadedAtIso,
//                  ageExceeds24h, stuck }],
//   }
export function summarizeBlobs(blobs, { nowMs, cutoffMs }) {
  const sessions = new Map();
  for (const b of blobs || []) {
    const m = (b.pathname || '').match(SESSION_RE);
    if (!m) continue;
    const sid = m[1];
    if (!sessions.has(sid)) {
      sessions.set(sid, {
        sessionId: sid,
        totalBytes: 0,
        files: 0,
        _whitelistBytes: 0,
        _whitelistFiles: 0,
        _stuckBytes: 0,
        _stuckFiles: 0,
        _oldestMs: null,
        _newestMs: null,
      });
    }
    const s = sessions.get(sid);
    s.files += 1;
    const size = b.size || 0;
    s.totalBytes += size;
    if (isCleanupTarget(b.pathname)) {
      s._whitelistBytes += size;
      s._whitelistFiles += 1;
    } else {
      s._stuckBytes += size;
      s._stuckFiles += 1;
    }
    const t = parseUploadedAt(b.uploadedAt);
    if (t != null) {
      if (s._oldestMs == null || t < s._oldestMs) s._oldestMs = t;
      if (s._newestMs == null || t > s._newestMs) s._newestMs = t;
    }
  }

  let totalBytes = 0;
  let totalFiles = 0;
  let deletableBytes = 0;
  let deletableFiles = 0;
  let stuckBytes = 0;
  let stuckFiles = 0;
  const sessionsOut = [];
  // 응답 안정성을 위해 newestUploadedAt 최신순으로 정렬 (null은 뒤로).
  const sortedSessions = [...sessions.values()].sort((a, b) => {
    const am = a._newestMs ?? -Infinity;
    const bm = b._newestMs ?? -Infinity;
    return bm - am;
  });
  for (const s of sortedSessions) {
    // uploadedAt이 하나도 없는 세션은 보수적으로 ageExceeds24h=false 처리
    // (진행 중인 것으로 간주) — deletable에서 빠지고 cleanup 대상 아님.
    const ageExceeds24h = s._newestMs != null && s._newestMs <= cutoffMs;
    const sessionDeletableBytes = ageExceeds24h ? s._whitelistBytes : 0;
    const sessionDeletableFiles = ageExceeds24h ? s._whitelistFiles : 0;
    const stuck = s._stuckBytes > 0;

    totalBytes += s.totalBytes;
    totalFiles += s.files;
    deletableBytes += sessionDeletableBytes;
    deletableFiles += sessionDeletableFiles;
    stuckBytes += s._stuckBytes;
    stuckFiles += s._stuckFiles;

    sessionsOut.push({
      sessionId: s.sessionId,
      totalBytes: s.totalBytes,
      deletableBytes: sessionDeletableBytes,
      stuckBytes: s._stuckBytes,
      files: s.files,
      oldestUploadedAtIso: s._oldestMs != null ? new Date(s._oldestMs).toISOString() : null,
      newestUploadedAtIso: s._newestMs != null ? new Date(s._newestMs).toISOString() : null,
      ageExceeds24h,
      stuck,
    });
  }

  return {
    totalBytes,
    totalFiles,
    deletableBytes,
    deletableFiles,
    stuckBytes,
    stuckFiles,
    cutoffIso: new Date(cutoffMs).toISOString(),
    sessions: sessionsOut,
  };
}

function parseUploadedAt(v) {
  if (v == null) return null;
  const t = new Date(v).getTime();
  return isNaN(t) ? null : t;
}
