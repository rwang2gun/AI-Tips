// Vercel Blob에 남아있는 모든 세션 폴더 요약.
//
// 용도: 외부 접근 의심 시 "내가 모르는 세션이 있는지" 즉시 파악.
// 각 meetings/<sid>/ 폴더의 파일 구성 + 가장 최근 uploadedAt을 표시해
// 언제 녹음된 것인지 알 수 있게 함.
//
// 사용:
//   node --env-file=.env scripts/list-blob-sessions.js

import { list } from '@vercel/blob';

async function main() {
  // meetings/ 전체 listAll (cursor 페이지네이션)
  const all = [];
  let cursor;
  do {
    const page = await list({ prefix: 'meetings/', cursor });
    all.push(...page.blobs);
    cursor = page.cursor;
  } while (cursor);

  // sessionId별로 그룹핑
  const sessions = new Map();
  for (const b of all) {
    const m = b.pathname.match(/^meetings\/([0-9a-f-]{36})\//);
    if (!m) continue;
    const sid = m[1];
    if (!sessions.has(sid)) {
      sessions.set(sid, {
        files: 0,
        totalBytes: 0,
        transcripts: 0,
        audioChunks: 0,
        hasMergedTranscript: false,
        hasResult: false,
        firstUploadedAt: null,
        lastUploadedAt: null,
      });
    }
    const s = sessions.get(sid);
    s.files++;
    s.totalBytes += b.size || 0;
    if (/\/transcript-\d+\.txt$/.test(b.pathname)) s.transcripts++;
    else if (/\/seg-\d+\/chunk-\d+\.bin$/.test(b.pathname)) s.audioChunks++;
    else if (/\/transcript\.txt$/.test(b.pathname)) s.hasMergedTranscript = true;
    else if (/\/result\.json$/.test(b.pathname)) s.hasResult = true;

    const t = b.uploadedAt ? new Date(b.uploadedAt).getTime() : null;
    if (t != null) {
      if (s.firstUploadedAt == null || t < s.firstUploadedAt) s.firstUploadedAt = t;
      if (s.lastUploadedAt == null || t > s.lastUploadedAt) s.lastUploadedAt = t;
    }
  }

  if (sessions.size === 0) {
    console.log('세션 없음 — meetings/ 폴더 비어있음');
    return;
  }

  // lastUploadedAt 기준 최신순 정렬
  const sorted = [...sessions.entries()].sort(
    (a, b) => (b[1].lastUploadedAt || 0) - (a[1].lastUploadedAt || 0),
  );

  console.log(`=== 총 ${sessions.size}개 세션 ===\n`);
  const KST = 9 * 60 * 60 * 1000;
  for (const [sid, s] of sorted) {
    const firstKst = s.firstUploadedAt
      ? new Date(s.firstUploadedAt + KST).toISOString().replace('T', ' ').slice(0, 19)
      : '(unknown)';
    const lastKst = s.lastUploadedAt
      ? new Date(s.lastUploadedAt + KST).toISOString().replace('T', ' ').slice(0, 19)
      : '(unknown)';
    const mb = (s.totalBytes / 1024 / 1024).toFixed(2);
    const status = [
      s.hasMergedTranscript ? 'merged✓' : 'merged✗',
      s.hasResult ? 'summary✓' : 'summary✗',
    ].join(' ');
    console.log(`${sid}`);
    console.log(`  파일 ${s.files}개 / ${mb} MB  (transcript ${s.transcripts}, audio ${s.audioChunks}, ${status})`);
    console.log(`  KST ${firstKst} ~ ${lastKst}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
