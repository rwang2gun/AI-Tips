import { listAllBlobs, del } from '../clients/blob.js';
import { summarizeBlobs, isCleanupTarget } from '../storage/usage.js';
import { readJsonBody, jsonResponse } from '../http/body-parser.js';

// 24h 이상 경과한 세션의 화이트리스트 파일만 삭제.
// result.json/transcript.txt/transcript-NN.txt는 isCleanupTarget=false이므로
// failed-finalize 세션에서도 보존됨 (회복 경로).
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export default async function handleCleanupOldAudio(req, res) {
  try {
    await readJsonBody(req);
  } catch {
    // 빈 body 허용
  }

  const prefix = 'meetings/';
  const blobs = await listAllBlobs(prefix);
  const now = Date.now();
  const cutoffMs = now - TWENTY_FOUR_HOURS_MS;

  // summarizeBlobs로 "24h 지난 세션" 식별 — storage-usage와 동일 규칙 재사용.
  const usage = summarizeBlobs(blobs, { nowMs: now, cutoffMs });
  const deletableSessionIds = new Set(
    usage.sessions.filter((s) => s.ageExceeds24h).map((s) => s.sessionId),
  );

  // 삭제 URL 수집 — 세션이 24h+ 이고 pathname이 화이트리스트 매칭인 blob만.
  const toDelete = [];
  let freedBytes = 0;
  const deletedSessionIds = new Set();
  for (const b of blobs) {
    const m = (b.pathname || '').match(/^meetings\/([0-9a-f-]{36})\//);
    if (!m) continue;
    if (!deletableSessionIds.has(m[1])) continue;
    if (!isCleanupTarget(b.pathname)) continue;
    toDelete.push(b.url);
    freedBytes += b.size || 0;
    deletedSessionIds.add(m[1]);
  }

  if (toDelete.length) {
    // Vercel Blob del() 는 URL 배열 일괄 삭제 지원. 이미 없는 URL 포함돼도 관대 —
    // 동시 호출/재시도의 idempotency 보장.
    await del(toDelete);
  }

  // 삭제 후 재스캔 — UI가 "정말 줄었는지" 즉시 확인 가능.
  const remaining = await listAllBlobs(prefix);
  const remainingTotalBytes = remaining.reduce((n, b) => n + (b.size || 0), 0);

  return jsonResponse(res, 200, {
    deletedSessions: deletedSessionIds.size,
    deletedFiles: toDelete.length,
    freedBytes,
    remainingTotalBytes,
  });
}
