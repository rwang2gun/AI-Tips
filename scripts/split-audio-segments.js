// ============================================================
// 긴 오디오를 5분 세그먼트로 분할 (Gemini 2.5 Flash 전사 안전 기준)
// ============================================================
//
// [배경]
// - Flash는 10분 오디오도 "긴 입력" 판정으로 503 거절 발생
// - 긴 단일 오디오 전사 시 generation loop (같은 문장 반복) 발생
// - 5분 세그먼트가 실전 안정 기준치
//
// [사용법]
//   node --env-file=.env scripts/split-audio-segments.js <input.webm> [--segment-seconds=300]
//
//   예:
//     node --env-file=.env scripts/split-audio-segments.js recovered-79d6ce87.webm
//     node --env-file=.env scripts/split-audio-segments.js recovered-79d6ce87.webm --segment-seconds=240
//
// [결과]
//   recovered-79d6ce87.part01.webm ~ recovered-79d6ce87.partNN.webm
//   (webm/opus는 재인코딩 없이 stream copy로 분할 → 빠르고 품질 보존)
//
// [환경변수]
//   FFMPEG_PATH   ffmpeg.exe 절대 경로 (선택. 없으면 PATH의 ffmpeg 사용)
//   FFPROBE_PATH  ffprobe.exe 절대 경로 (선택)
// ============================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const inputPath = process.argv[2];
const segmentArg = process.argv.find((a) => a.startsWith('--segment-seconds='));
const segmentSeconds = segmentArg ? parseInt(segmentArg.split('=')[1], 10) : 300;

if (!inputPath) {
  console.error('Usage: node scripts/split-audio-segments.js <input.webm> [--segment-seconds=300]');
  process.exit(1);
}

if (!segmentSeconds || segmentSeconds < 30 || segmentSeconds > 3600) {
  console.error(`ERROR: --segment-seconds must be between 30 and 3600 (got ${segmentSeconds})`);
  process.exit(1);
}

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';

// 입력 파일 확인
try {
  const stat = await fs.stat(inputPath);
  console.log(`Input:  ${path.resolve(inputPath)}  (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
} catch {
  console.error(`ERROR: Cannot read ${inputPath}`);
  process.exit(1);
}

// 재생 시간 측정 (브라우저 MediaRecorder webm은 duration 메타 없어서 N/A 나올 수 있음 — 무시하고 진행)
let duration = null;
try {
  duration = await probeDuration(inputPath);
  console.log(`Duration: ${Math.floor(duration / 60)}m ${Math.round(duration % 60)}s (${duration.toFixed(1)}s)`);
  const segmentCount = Math.ceil(duration / segmentSeconds);
  console.log(`Segments: ${segmentCount} × ${segmentSeconds}s = ${Math.ceil(segmentCount * segmentSeconds / 60)}m`);
} catch (e) {
  console.log(`Duration: (unknown — ${e.message.split('\n')[0]})`);
  console.log(`         → 분할은 패킷 단위로 진행됨. 생성된 파일 수로 세그먼트 확인.`);
}
console.log('');

// 출력 경로: recovered-79d6ce87.webm -> recovered-79d6ce87.part%02d.webm
const ext = path.extname(inputPath);
const base = inputPath.slice(0, -ext.length);
const outputPattern = `${base}.part%02d${ext}`;

console.log(`ffmpeg: ${ffmpegPath}`);
console.log(`Output pattern: ${outputPattern}`);
console.log('');
console.log('Splitting (stream copy, no re-encoding)...');

// ffmpeg 세그먼트 분할
// -c copy로 재인코딩 없이 분할 (빠르고 품질 보존)
// -reset_timestamps 1: 각 세그먼트 타임스탬프 0부터
await runFfmpeg([
  '-hide_banner',
  '-y',
  '-i', inputPath,
  '-f', 'segment',
  '-segment_time', String(segmentSeconds),
  '-reset_timestamps', '1',
  '-c', 'copy',
  outputPattern,
]);

// 생성된 파일 확인 (최대 100개까지 스캔)
const outputs = [];
for (let i = 0; i < 100; i++) {
  const candidate = `${base}.part${String(i).padStart(2, '0')}${ext}`;
  try {
    const stat = await fs.stat(candidate);
    outputs.push({ path: candidate, size: stat.size });
  } catch {
    // 연속으로 끊기면 중단
    if (outputs.length > 0) break;
  }
}

if (!outputs.length) {
  console.error('ERROR: No output files found. ffmpeg may have failed silently.');
  process.exit(1);
}

console.log('');
console.log(`Created ${outputs.length} segment(s):`);
for (const o of outputs) {
  console.log(`  ${o.path}  (${(o.size / 1024 / 1024).toFixed(2)} MB)`);
}
console.log('');
console.log('Next step:');
console.log('  Each segment is safe to feed into Gemini 2.5 Flash transcribe (thinking OFF).');

// ---------- helpers ----------

function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${err}`));
      const sec = parseFloat(out.trim());
      if (!Number.isFinite(sec)) return reject(new Error(`Unexpected ffprobe output: ${out}`));
      resolve(sec);
    });
    p.on('error', reject);
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}`));
      resolve();
    });
    p.on('error', reject);
  });
}
