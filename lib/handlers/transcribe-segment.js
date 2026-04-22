import { Buffer } from 'node:buffer';
import { createUserContent, createPartFromUri } from '@google/genai';
import { buildSegmentTranscribePrompt } from '../prompts/transcribe.js';
import { createGeminiClient } from '../clients/gemini.js';
import { putPublic } from '../clients/blob.js';
import { readJsonBody, jsonResponse } from '../http/body-parser.js';
import { withRetry } from '../http/retry.js';
import { fetchSynonyms, buildTranscribeSynonymHint } from '../synonyms.js';
import { applySynonymReplacements, detectLoop } from '../transcript/post-process.js';

const TRANSCRIBE_MODEL = 'gemini-2.5-flash';
// 5분 세그먼트가 이보다 짧게 전사되면 품질 저하(발화 없는 구간 or 조기 종료)로 간주하고 flag.
// 단위는 UTF-8 byte (JS 문자열 length가 아님 — 한글은 length≈byte/3이라 문자 기준이면 정상 700~1500자 세그먼트가
// 전부 false-positive flag). 2026-04-22 세션 seg 13이 1,483 UTF-8 bytes로 비정상 케이스.
const SHORT_TRANSCRIPT_THRESHOLD_BYTES = 2000;

// segment 단계 2: 한 세그먼트 전사 → transcript-NN.txt
export default async function handleTranscribeSegment(req, res) {
  const body = await readJsonBody(req);
  const { sessionId, segmentIndex, fileUri, fileMimeType, totalSegments } = body;

  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return jsonResponse(res, 400, { error: 'Invalid session id' });
  }
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex > 999) {
    return jsonResponse(res, 400, { error: 'Invalid segment index' });
  }
  if (!fileUri || !fileMimeType) {
    return jsonResponse(res, 400, { error: 'Missing fileUri/fileMimeType' });
  }

  // 유의어 사전 조회 → 전사 프롬프트에 "정답 용어" 힌트 주입 + 후처리 regex 치환.
  // PR #12 설계: 전사 프롬프트엔 정답 용어만(프라이밍 역효과 회피), 오인식→정답 매핑은 regex/요약에서 처리.
  const synonyms = await fetchSynonyms();
  const synonymHint = buildTranscribeSynonymHint(synonyms);

  const promptText = buildSegmentTranscribePrompt({ segmentIndex, totalSegments, synonymHint });

  const genAI = createGeminiClient();
  const result = await withRetry(() =>
    genAI.models.generateContent({
      model: TRANSCRIBE_MODEL,
      contents: [
        createUserContent([
          promptText,
          createPartFromUri(fileUri, fileMimeType),
        ]),
      ],
      // thinking OFF — Flash가 단순 전사에서 thinking에 출력 토큰 소비 후 MAX_TOKENS로 빈 응답 반환하는 이슈 회피 (PR #8 참고)
      config: {
        maxOutputTokens: 65536,
        thinkingConfig: { thinkingBudget: 0 },
      },
    })
  );

  const rawTranscript = result.text || '';
  if (!rawTranscript.trim()) {
    return jsonResponse(res, 500, { error: `Empty transcript for segment ${segmentIndex}` });
  }

  // loop 탐지는 raw(치환 전)에 대해 수행. Flash가 직접 뱉은 반복이 유의어 치환 때문에 보이지 않게 되는 걸 방지.
  const loopReport = detectLoop(rawTranscript);

  const { text: transcript, applied } = applySynonymReplacements(rawTranscript, synonyms);
  if (applied.length) {
    console.log(`[transcribe-segment ${segmentIndex}] synonym replacements:`, applied);
  }

  const rawByteLength = Buffer.byteLength(rawTranscript, 'utf8');
  const flagged = loopReport.hasLoop || rawByteLength < SHORT_TRANSCRIPT_THRESHOLD_BYTES;
  if (flagged) {
    console.warn(`[transcribe-segment ${segmentIndex}] FLAGGED — loop=${loopReport.hasLoop} rawBytes=${rawByteLength}${loopReport.longestRun ? ` longestRun="${loopReport.longestRun.token}"×${loopReport.longestRun.count}` : ''}`);
  }

  const segKey = String(segmentIndex).padStart(2, '0');
  const baseKey = `meetings/${sessionId}/transcript-${segKey}`;
  await putPublic(`${baseKey}.txt`, transcript, { contentType: 'text/plain; charset=utf-8' });

  // Sidecar 저장 — flagged 세그먼트는 finalize cleanup의 retention 대상이므로 증거 손실 방어가 최우선.
  //
  // 쓰기 순서 중요: raw.txt 먼저, meta.json 나중.
  //   - finalize는 "meta.flagged==true OR raw.txt 존재" 합집합을 retention 대상으로 판정.
  //   - 따라서 meta.json 업로드가 실패해도 raw.txt만 있으면 오디오/raw가 cleanup에서 보존됨.
  //   - raw.txt는 flagged 세그먼트에서만 업로드되므로 존재 자체가 flag 신호.
  //
  // 비flagged 세그먼트의 meta.json 실패는 진단 품질만 떨어뜨리고 증거 손실은 없음 (retention 대상 아님).
  // 본 응답은 실패해도 200 유지 — 클라가 sidecar 때문에 전사 자체를 재시도하면 비용 낭비.
  const meta = {
    segmentIndex,
    model: TRANSCRIBE_MODEL,
    finishReason: result?.candidates?.[0]?.finishReason ?? null,
    usageMetadata: result?.usageMetadata ?? null,
    rawLength: rawTranscript.length,
    rawByteLength,
    normalizedLength: transcript.length,
    loopDetected: loopReport.hasLoop,
    longestRun: loopReport.longestRun,
    repeatedChars: loopReport.repeatedChars,
    synonymAppliedCount: applied.reduce((n, a) => n + a.count, 0),
    flagged,
    timestamp: new Date().toISOString(),
  };
  let rawSaved = false;
  let metaSaved = false;
  if (flagged) {
    try {
      await putPublic(`${baseKey}.raw.txt`, rawTranscript, {
        contentType: 'text/plain; charset=utf-8',
      });
      rawSaved = true;
    } catch (e) {
      console.warn(`[transcribe-segment ${segmentIndex}] raw.txt upload failed:`, e?.message);
    }
  }
  try {
    await putPublic(`${baseKey}.meta.json`, JSON.stringify(meta, null, 2), {
      contentType: 'application/json; charset=utf-8',
    });
    metaSaved = true;
  } catch (e) {
    console.warn(`[transcribe-segment ${segmentIndex}] meta.json upload failed:`, e?.message);
  }
  if (flagged && !rawSaved && !metaSaved) {
    // 양쪽 다 실패하면 retention 신호가 하나도 없음 — 경고 로그로 수동 개입 여지만 남김.
    console.error(`[transcribe-segment ${segmentIndex}] BOTH sidecars failed for flagged segment — evidence will be lost at cleanup`);
  }

  return jsonResponse(res, 200, {
    ok: true,
    segmentIndex,
    transcriptLength: transcript.length,
    flagged,
    loopDetected: loopReport.hasLoop,
  });
}
