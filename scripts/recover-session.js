// ============================================================
// 실패한 세그먼트 세션 복구
// ============================================================
//
// [목적]
//   업로드가 중간에 실패한 세션(meetings/<sid>/seg-NN/chunk-NNNN.bin)에서
//   Vercel Blob에 올라간 세그먼트까지만 받아와 하나의 webm으로 병합.
//   병합된 파일은 process-recording-locally.js 입력으로 바로 사용 가능.
//
// [사용법]
//   export BLOB_READ_WRITE_TOKEN="vercel_blob_rw_..."
//   node scripts/recover-session.js <sessionId>
//
// [출력]
//   recovered-<prefix>.seg-00.webm ... seg-NN.webm   (세그먼트별)
//   recovered-<prefix>.webm                          (ffmpeg 병합본)
//
// [다음 단계]
//   node --env-file=.env scripts/process-recording-locally.js recovered-<prefix>.webm
// ============================================================

import { list } from '@vercel/blob';
import ffmpegStatic from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';

const sessionId = process.argv[2];

if (!sessionId) {
  console.error('Usage: node scripts/recover-session.js <sessionId>');
  process.exit(1);
}
if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
  console.error(`ERROR: Invalid sessionId: ${sessionId}`);
  process.exit(1);
}
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('ERROR: BLOB_READ_WRITE_TOKEN not set.');
  console.error('  Vercel Dashboard → Storage → meeting-audio → .env.local 탭에서 복사');
  process.exit(1);
}

const prefix = `meetings/${sessionId}/`;
console.log(`Listing blobs under ${prefix} ...`);
const { blobs } = await list({ prefix });

if (!blobs.length) {
  console.error(`No blobs found under ${prefix}`);
  process.exit(1);
}

// seg-NN/chunk-NNNN.bin 구조로 그룹화
const segMap = new Map();
const legacyChunks = [];
for (const b of blobs) {
  const segMatch = b.pathname.match(/\/seg-(\d{2})\/chunk-(\d{4})\.bin$/);
  if (segMatch) {
    const segIdx = parseInt(segMatch[1], 10);
    const chunkIdx = parseInt(segMatch[2], 10);
    if (!segMap.has(segIdx)) segMap.set(segIdx, []);
    segMap.get(segIdx).push({ chunkIdx, blob: b });
  } else if (/\/chunk-\d{4}\.bin$/.test(b.pathname)) {
    legacyChunks.push(b);
  }
}

if (segMap.size === 0) {
  if (legacyChunks.length) {
    console.error('Legacy (단일 파일) 레이아웃입니다. scripts/download-session-audio.js를 사용하세요.');
  } else {
    console.error('청크 파일을 찾지 못했습니다. 전체 Blob 목록:');
    blobs.forEach((b) => console.error(`  - ${b.pathname}`));
  }
  process.exit(1);
}

const sidPrefix = sessionId.slice(0, 8);
const segments = [...segMap.entries()].sort((a, b) => a[0] - b[0]);
console.log(`${segments.length}개 세그먼트 발견 (seg-${String(segments[0][0]).padStart(2, '0')} ~ seg-${String(segments[segments.length - 1][0]).padStart(2, '0')})`);
console.log('');

// 각 세그먼트의 청크를 받아 병합해 webm 파일로 저장
const segFiles = [];
for (const [segIdx, chunks] of segments) {
  chunks.sort((a, b) => a.chunkIdx - b.chunkIdx);
  const segLabel = `seg-${String(segIdx).padStart(2, '0')}`;
  process.stdout.write(`[${segLabel}] downloading ${chunks.length} chunk(s)... `);

  const buffers = [];
  for (const { blob } of chunks) {
    const res = await fetch(blob.url);
    if (!res.ok) {
      console.error(`\nERROR: ${blob.pathname} HTTP ${res.status}`);
      process.exit(1);
    }
    buffers.push(Buffer.from(await res.arrayBuffer()));
  }
  const segBuf = Buffer.concat(buffers);
  const segPath = path.resolve(process.cwd(), `recovered-${sidPrefix}.${segLabel}.webm`);
  await fs.writeFile(segPath, segBuf);
  segFiles.push(segPath);
  console.log(`${(segBuf.length / 1024 / 1024).toFixed(2)} MB → ${path.basename(segPath)}`);
}

console.log('');
console.log('ffmpeg concat으로 병합 중...');

// concat demuxer용 list 파일 생성 (POSIX 경로 사용, 따옴표 escape)
const listPath = path.resolve(process.cwd(), `recovered-${sidPrefix}.concat.txt`);
const listContent = segFiles
  .map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
  .join('\n') + '\n';
await fs.writeFile(listPath, listContent);

const outputPath = path.resolve(process.cwd(), `recovered-${sidPrefix}.webm`);

async function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegStatic, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    proc.on('error', reject);
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

try {
  // 1차: stream copy (빠름)
  await runFFmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0',
    '-i', listPath,
    '-c', 'copy',
    outputPath,
  ]);
} catch (err) {
  console.warn(`stream copy 실패: ${err.message}`);
  console.log('re-encode fallback으로 재시도...');
  // 2차: 재인코딩 (느리지만 안전)
  const inputArgs = segFiles.flatMap((f) => ['-i', f]);
  const filterComplex = segFiles.map((_, i) => `[${i}:a]`).join('') + `concat=n=${segFiles.length}:v=0:a=1[a]`;
  await runFFmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[a]',
    '-c:a', 'libopus', '-b:a', '32k',
    outputPath,
  ]);
}

await fs.unlink(listPath);

const stat = await fs.stat(outputPath);
console.log('');
console.log(`✓ 병합 완료: ${path.basename(outputPath)} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
console.log('');
console.log('다음 단계:');
console.log(`  node --env-file=.env scripts/process-recording-locally.js ${path.basename(outputPath)}`);
console.log('');
console.log('요약 후 Notion 업로드:');
console.log(`  node --env-file=.env scripts/upload-to-notion.js ${path.basename(outputPath)}.result.json --transcript=${path.basename(outputPath)}.transcript.txt`);
