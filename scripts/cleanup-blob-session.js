// Vercel Blob 세션 폴더 정리 스크립트.
//
// 용도: finalize-notion이 중단되어 meetings/<sid>/ 폴더가 정리되지 않은
//       고아 세션을 수동 삭제. 장시간 테스트 후 남는 134-세그먼트 세션 등.
//
// 사용:
//   # dry-run (기본, 삭제 안 함. 파일 목록만 표시)
//   node --env-file=.env scripts/cleanup-blob-session.js <sessionId> [<sessionId> ...]
//
//   # 실제 삭제
//   node --env-file=.env scripts/cleanup-blob-session.js --confirm <sessionId> [<sessionId> ...]
//
// 안전장치:
//   - 기본 dry-run. --confirm 없이는 절대 삭제 안 함
//   - sessionId는 UUID v4 형식만 허용 (prefix 실수로 전 블롭 삭제 방지)

import { list, del } from '@vercel/blob';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const sessionIds = args.filter((a) => a !== '--confirm');

  if (!sessionIds.length) {
    console.error('Usage: cleanup-blob-session.js [--confirm] <sessionId> [<sessionId> ...]');
    process.exit(1);
  }

  for (const sid of sessionIds) {
    if (!UUID_RE.test(sid)) {
      console.error(`✗ "${sid}" is not a valid UUID. Skipped.`);
      continue;
    }

    const prefix = `meetings/${sid}/`;
    console.log(`\n=== ${sid} ===`);

    // cursor 페이지네이션으로 전부 수집
    const all = [];
    let cursor;
    do {
      const page = await list({ prefix, cursor });
      all.push(...page.blobs);
      cursor = page.cursor;
    } while (cursor);

    if (!all.length) {
      console.log(`  (비어있음 — 이미 정리됨)`);
      continue;
    }

    // 파일 패턴별 집계
    const groups = { transcript: 0, audioChunk: 0, other: 0 };
    let totalBytes = 0;
    for (const b of all) {
      totalBytes += b.size;
      if (/\/transcript-\d+\.txt$/.test(b.pathname)) groups.transcript++;
      else if (/\/seg-\d+\/chunk-\d+\.bin$/.test(b.pathname)) groups.audioChunk++;
      else groups.other++;
    }

    console.log(`  파일 ${all.length}개, ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`    transcript-NN.txt: ${groups.transcript}`);
    console.log(`    seg-NN/chunk-*.bin: ${groups.audioChunk}`);
    console.log(`    기타 (transcript.txt / result.json 등): ${groups.other}`);

    if (!confirm) {
      console.log(`  [dry-run] --confirm 플래그 넣으면 실제 삭제`);
      continue;
    }

    // 실제 삭제
    await del(all.map((b) => b.url));
    console.log(`  ✓ ${all.length}개 삭제 완료`);
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
