// ============================================================
// Vercel Blob에서 회의 녹음 청크 다운로드 → 하나의 오디오 파일로 저장
// ============================================================
//
// [사용법]
//   1. Vercel Dashboard → Storage → meeting-audio → .env.local 탭에서
//      BLOB_READ_WRITE_TOKEN 복사
//   2. 터미널에서 실행:
//        export BLOB_READ_WRITE_TOKEN="vercel_blob_rw_..."
//        node scripts/download-session-audio.js <sessionId> [output-path]
//
//   예:
//     node scripts/download-session-audio.js 79d6ce87-b802-4384-977f-48ff191ac3b3
//     node scripts/download-session-audio.js 79d6ce87-b802-4384-977f-48ff191ac3b3 ./meeting.webm
//
// [결과]
//   chunk-0000.bin ~ chunk-NNNN.bin을 순서대로 합쳐 하나의 webm 파일로 저장.
//   기본 출력 경로: ./recovered-<sessionId-앞8자>.webm
// ============================================================

import { list } from '../lib/clients/blob.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';

const sessionId = process.argv[2];
const outputPath = process.argv[3] || `./recovered-${(sessionId || '').slice(0, 8)}.webm`;

if (!sessionId) {
  console.error('Usage: node scripts/download-session-audio.js <sessionId> [output-path]');
  process.exit(1);
}

if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
  console.error(`ERROR: Invalid sessionId format: ${sessionId}`);
  console.error(`       Must be UUID (36 chars, hex + dashes).`);
  process.exit(1);
}

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('ERROR: BLOB_READ_WRITE_TOKEN environment variable not set.');
  console.error('');
  console.error('Get it from:');
  console.error('  Vercel Dashboard → Storage → meeting-audio → .env.local tab');
  console.error('');
  console.error('Then run:');
  console.error('  export BLOB_READ_WRITE_TOKEN="vercel_blob_rw_..."');
  console.error('  node scripts/download-session-audio.js <sessionId>');
  process.exit(1);
}

console.log(`Session ID: ${sessionId}`);
console.log(`Output:     ${path.resolve(outputPath)}`);
console.log('');
console.log('Listing blobs...');

const prefix = `meetings/${sessionId}/`;
const { blobs } = await list({ prefix });

if (!blobs.length) {
  console.error(`ERROR: No blobs found under prefix "${prefix}"`);
  process.exit(1);
}

// chunk-NNNN.bin만 선별 (transcript-*.txt, result.json 같은 다른 파일 제외)
const chunks = blobs
  .filter((b) => /\/chunk-\d{4}\.bin$/.test(b.pathname))
  .sort((a, b) => a.pathname.localeCompare(b.pathname));

if (!chunks.length) {
  console.error(`ERROR: No chunk-XXXX.bin files found.`);
  console.error(`All blobs under ${prefix}:`);
  blobs.forEach((b) => console.error(`  - ${b.pathname} (${b.size} bytes)`));
  process.exit(1);
}

const totalSize = chunks.reduce((sum, b) => sum + b.size, 0);
console.log(`Found ${chunks.length} chunk(s), total ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
console.log('');
console.log('Downloading...');

const buffers = [];
for (const [i, b] of chunks.entries()) {
  const res = await fetch(b.url);
  if (!res.ok) {
    console.error(`ERROR: Failed to fetch ${b.pathname} (HTTP ${res.status})`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  buffers.push(buf);
  console.log(`  [${i + 1}/${chunks.length}] ${b.pathname}  (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
}

const combined = Buffer.concat(buffers);
await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
await fs.writeFile(outputPath, combined);

// 32kbps(앱 기본) 기준 대략적 재생 시간 추정
const estimatedMinutes = Math.round(combined.length * 8 / 32000 / 60);

console.log('');
console.log(`Saved ${(combined.length / 1024 / 1024).toFixed(2)} MB to ${path.resolve(outputPath)}`);
console.log(`Estimated duration at 32kbps: ~${estimatedMinutes} minutes`);
console.log('');
console.log('Next steps:');
console.log(`  - Play to verify: open "${outputPath}" in any audio player`);
console.log(`  - See meeting-notes/docs/RECOVERY-PLAN.md for next processing steps`);
