// 회의록 처리 진행 로그(diagnostic manifest) 빌더.
//
// finalize-notion이 cleanup 직전에 meetings/<sid>/ 폴더를 listAll해서
// 서버 최종 상태를 인간 가독 텍스트로 고정. Notion에 별도 첨부 파일로
// 업로드해서 Blob 삭제 후에도 영구 보존. 사후 진단의 유일한 경로.
//
// 2026-04-18 세션 3abe5062 데이터 손실 사건 학습: 서버 Blob이 cleanup 후
// 사라지고 Vercel 로그도 1시간 제한으로 만료돼, 클라 UI가 "12 done"인데
// Notion 전사가 "4 섹션"인 원인을 영구 미제로 남긴 경험. manifest가 있었으면
// 즉시 확정 가능했을 진단 정보들을 이 모듈이 박제.
//
// 포맷 선택: JSON보다 plain text. diff/grep/눈으로 읽기 쉽고 Notion viewer에서
// 그대로 읽힘. 필드 순서는 "위기 시 위에서부터 훑어도 원인 판단 가능"하게 배치.

import { listAllBlobs } from '../clients/blob.js';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// ISO 문자열을 KST(+9) "YYYY-MM-DD HH:MM:SS" 로 변환. 타임존 라이브러리 없이도
// 수 줄로 가능해 추가 의존성 회피.
function toKst(iso) {
  if (!iso) return '(unknown)';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const kst = new Date(d.getTime() + KST_OFFSET_MS);
  return kst.toISOString().replace('T', ' ').slice(0, 19);
}

function formatDuration(sec) {
  if (sec == null || isNaN(sec)) return '(unknown)';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function categorize(blobs) {
  const transcripts = [];
  const rawTranscripts = [];
  const metas = [];
  const audio = [];
  const other = [];
  for (const b of blobs) {
    const normalMatch = b.pathname.match(/\/transcript-(\d+)\.txt$/);
    const rawMatch = b.pathname.match(/\/transcript-(\d+)\.raw\.txt$/);
    const metaMatch = b.pathname.match(/\/transcript-(\d+)\.meta\.json$/);
    if (rawMatch) rawTranscripts.push({ ...b, index: Number(rawMatch[1]) });
    else if (metaMatch) metas.push({ ...b, index: Number(metaMatch[1]) });
    else if (normalMatch) transcripts.push({ ...b, index: Number(normalMatch[1]) });
    else if (/\/seg-\d+\/chunk-\d+\.bin$/.test(b.pathname)) audio.push(b);
    else other.push(b);
  }
  transcripts.sort((a, b) => a.index - b.index);
  rawTranscripts.sort((a, b) => a.index - b.index);
  metas.sort((a, b) => a.index - b.index);
  return { transcripts, rawTranscripts, metas, audio, other };
}

async function fetchMeta(url, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function fetchPreview(url, maxChars = 60, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(url);
    const text = await r.text();
    // 줄바꿈/공백 정규화해서 한 줄로 — 프리뷰 가독성 + 빈 세그먼트 식별 용이
    const cleaned = text.replace(/\s+/g, ' ').trim();
    return cleaned.slice(0, maxChars) || '(빈 문자열)';
  } catch (e) {
    return `(fetch 실패: ${e?.message?.slice(0, 40) || 'unknown'})`;
  }
}

// 전사 원문과 분리된 두 번째 첨부 파일용 manifest 텍스트 생성.
// 반환값: { text, flaggedSegments, retentionIndices }
//   - text: Notion 첨부용 plain text
//   - flaggedSegments: meta.flagged==true 인 세그먼트 (UI/로깅용, meta 업로드 성공 케이스만 포함)
//   - retentionIndices: [DEPRECATED — 2026-04-23 스토리지 UI 도입으로 finalize cleanup이
//     isCleanupTarget 기반으로 전환되며 미사용] flaggedSegments ∪ (raw.txt 존재 세그먼트).
//     현재 호출자 없음. 다음 정리 타이밍에 완전 제거.
export async function buildManifest({
  sessionId,
  title,
  date,
  segmentSeconds,
  summarizeModel,
  startedAtIso,
  endedAtIso,
  durationSec,
  finalizedAtIso = new Date().toISOString(),
  transcriptMergedChars,
  resultJsonSize,
  // 테스트/훅 주입용 — 기본은 프로덕션 모듈. listBlobs는 prefix를 받아 blob 배열 반환.
  listBlobs = listAllBlobs,
  fetchImpl = fetch,
}) {
  const prefix = `meetings/${sessionId}/`;
  const blobs = await listBlobs(prefix);
  const { transcripts, rawTranscripts, metas, audio, other } = categorize(blobs);
  const totalBytes = blobs.reduce((n, b) => n + (b.size || 0), 0);

  const previews = await Promise.all(
    transcripts.map(async (b) => ({
      index: b.index,
      size: b.size,
      preview: await fetchPreview(b.url, 60, fetchImpl),
    })),
  );

  const metaById = new Map();
  await Promise.all(
    metas.map(async (b) => {
      const data = await fetchMeta(b.url, fetchImpl);
      if (data) metaById.set(b.index, data);
    }),
  );
  const flaggedSegments = [...metaById.entries()]
    .filter(([, m]) => m.flagged)
    .map(([index, m]) => ({ index, ...m }))
    .sort((a, b) => a.index - b.index);

  // 누락 인덱스 계산. transcript가 하나도 없으면 skip.
  let missing = [];
  if (transcripts.length > 0) {
    const maxIdx = Math.max(...transcripts.map((t) => t.index));
    const present = new Set(transcripts.map((t) => t.index));
    for (let i = 0; i <= maxIdx; i++) if (!present.has(i)) missing.push(i);
  }

  const L = [];
  L.push('# 회의록 파이프라인 진행 로그');
  L.push('');
  L.push('## 세션 정보');
  L.push(`Session ID     : ${sessionId}`);
  L.push(`Title          : ${title || '(없음)'}`);
  L.push(`Date           : ${date || '(없음)'}`);
  L.push(`SEGMENT_SECONDS: ${segmentSeconds ?? '(unknown)'}`);
  L.push(`Summarize 모델 : ${summarizeModel || '(unknown)'}`);
  L.push('');
  L.push('## 녹음 시간');
  L.push(`녹음 시작 (KST)          : ${toKst(startedAtIso)}`);
  L.push(`녹음 종료 (KST)          : ${toKst(endedAtIso)}`);
  L.push(`실제 녹음 (pause 제외)   : ${formatDuration(durationSec)}`);
  L.push(`Finalize 처리 시각 (KST) : ${toKst(finalizedAtIso)}`);
  L.push('');
  L.push('## 서버 Blob 상태 (cleanup 직전 listAll)');
  L.push(`총 ${blobs.length}개 파일 / ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  L.push('');
  L.push(`### transcript-NN.txt (${transcripts.length}개)`);
  if (previews.length === 0) {
    L.push('  (없음)');
  } else {
    for (const p of previews) {
      const idx = String(p.index).padStart(2, '0');
      const size = String(p.size).padStart(7);
      L.push(`  [${idx}] ${size} bytes  "${p.preview}"`);
    }
  }
  L.push('');
  L.push(`### 오디오 청크 seg-NN/chunk-*.bin: ${audio.length}개`);
  L.push('');
  L.push(`### 기타 (${other.length}개)`);
  if (other.length === 0) {
    L.push('  (없음)');
  } else {
    for (const b of other) {
      const relPath = b.pathname.replace(prefix, '');
      L.push(`  ${relPath}  ${b.size} bytes`);
    }
  }
  L.push('');
  L.push('## Merge 요약');
  if (transcripts.length === 0) {
    L.push('- transcript-NN.txt 없음 — merge 실행 안 됐거나 전사 전부 실패');
  } else {
    const minIdx = Math.min(...transcripts.map((t) => t.index));
    const maxIdx = Math.max(...transcripts.map((t) => t.index));
    L.push(`- 발견된 세그먼트: ${transcripts.length}개 (인덱스 ${minIdx}~${maxIdx})`);
    L.push(`- 누락된 인덱스  : ${missing.length ? missing.join(', ') : '없음'}`);
  }
  if (transcriptMergedChars != null) {
    L.push(`- 출력 transcript.txt: ${transcriptMergedChars.toLocaleString()}자`);
  }
  if (resultJsonSize != null) {
    L.push(`- 요약 result.json   : ${resultJsonSize.toLocaleString()} bytes`);
  }
  L.push('');

  // 전사 품질 경고 섹션 — flagged(loop 탐지 or short) 세그먼트만 나열.
  // flagged 0개면 섹션 자체 생략. raw/meta/오디오 retention 상태까지 함께 표시해
  // 사후 재전사 가능성을 한 눈에 판단 가능.
  if (flaggedSegments.length) {
    const rawIndices = new Set(rawTranscripts.map((r) => r.index));
    const audioIndicesBySeg = new Set(
      audio.map((a) => {
        const m = a.pathname.match(/\/seg-(\d+)\/chunk-\d+\.bin$/);
        return m ? Number(m[1]) : null;
      }).filter((n) => n !== null),
    );
    L.push('## 전사 품질 경고');
    L.push(`flagged 세그먼트 ${flaggedSegments.length}개 — loop 탐지 또는 비정상적으로 짧은 전사.`);
    L.push('');
    for (const s of flaggedSegments) {
      const idx = String(s.index).padStart(2, '0');
      const reasons = [];
      if (s.loopDetected) {
        const run = s.longestRun;
        reasons.push(`loop (longest="${run?.token}"×${run?.count}, ${run?.chars}자)`);
      }
      // rawByteLength가 있으면 UTF-8 byte 기준(새 sidecar), 없으면 rawLength(legacy)로 표시.
      // threshold는 transcribe-segment.js의 SHORT_TRANSCRIPT_THRESHOLD_BYTES와 동일.
      if (s.rawByteLength != null && s.rawByteLength < 2000) {
        reasons.push(`short rawBytes=${s.rawByteLength}`);
      } else if (s.rawByteLength == null && s.rawLength != null && s.rawLength < 2000) {
        reasons.push(`short rawLength=${s.rawLength}`);
      }
      L.push(`  [${idx}] ${reasons.join(' / ') || 'flagged'}`);
      L.push(`        model=${s.model} finishReason=${s.finishReason ?? '(null)'} normalized=${s.normalizedLength}자`);
      const retained = [];
      if (rawIndices.has(s.index)) retained.push('raw.txt');
      if (audioIndicesBySeg.has(s.index)) retained.push('오디오');
      L.push(`        retention: ${retained.length ? retained.join(', ') : '(없음)'}`);
    }
    L.push('');
  }

  // retention 합집합 — meta.json이 유실돼도 raw.txt만 있으면 retention 대상으로 인정.
  // transcribe-segment가 raw.txt를 flagged 세그먼트에서만 쓰므로 raw.txt 존재 = flag 증거.
  const retentionIndices = new Set([
    ...flaggedSegments.map((s) => s.index),
    ...rawTranscripts.map((r) => r.index),
  ]);

  return { text: L.join('\n'), flaggedSegments, retentionIndices };
}

export function buildManifestFilename(title, date) {
  const safe = (title || 'untitled')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return `진행로그_${date}_${safe}.txt`;
}
