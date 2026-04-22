import { createUserContent, createPartFromUri } from '@google/genai';
import { buildSegmentTranscribePrompt } from '../../lib/prompts/transcribe.js';
import { createGeminiClient } from '../../lib/clients/gemini.js';
import { putPublic } from '../../lib/clients/blob.js';
import { readJsonBody, jsonResponse } from '../../lib/http/body-parser.js';
import { withRetry } from '../../lib/http/retry.js';
import { fetchSynonyms, buildTranscribeSynonymHint } from '../../lib/synonyms.js';
import { applySynonymReplacements, detectLoop } from '../../lib/transcript/post-process.js';

const TRANSCRIBE_MODEL = 'gemini-2.5-flash';
// 5분 세그먼트가 이보다 짧게 전사되면 품질 저하(발화 없는 구간 or 조기 종료)로 간주하고 flag.
// 정상 5분 회의는 최소 수천 byte 단위 (2026-04-22 세션 seg 13이 1,483 bytes로 비정상 케이스).
const SHORT_TRANSCRIPT_THRESHOLD = 2000;

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

  const flagged = loopReport.hasLoop || rawTranscript.length < SHORT_TRANSCRIPT_THRESHOLD;
  if (flagged) {
    console.warn(`[transcribe-segment ${segmentIndex}] FLAGGED — loop=${loopReport.hasLoop} rawLen=${rawTranscript.length}${loopReport.longestRun ? ` longestRun="${loopReport.longestRun.token}"×${loopReport.longestRun.count}` : ''}`);
  }

  const segKey = String(segmentIndex).padStart(2, '0');
  const baseKey = `meetings/${sessionId}/transcript-${segKey}`;
  await putPublic(`${baseKey}.txt`, transcript, { contentType: 'text/plain; charset=utf-8' });

  // Sidecar 저장은 best-effort — 실패해도 transcript 업로드는 성공으로 처리.
  // retention/진단을 위한 것이라 본 경로를 깨뜨리지 않아야 함.
  const meta = {
    segmentIndex,
    model: TRANSCRIBE_MODEL,
    finishReason: result?.candidates?.[0]?.finishReason ?? null,
    usageMetadata: result?.usageMetadata ?? null,
    rawLength: rawTranscript.length,
    normalizedLength: transcript.length,
    loopDetected: loopReport.hasLoop,
    longestRun: loopReport.longestRun,
    repeatedChars: loopReport.repeatedChars,
    synonymAppliedCount: applied.reduce((n, a) => n + a.count, 0),
    flagged,
    timestamp: new Date().toISOString(),
  };
  try {
    await putPublic(`${baseKey}.meta.json`, JSON.stringify(meta, null, 2), {
      contentType: 'application/json; charset=utf-8',
    });
    // Raw는 flagged 세그먼트에서만 보존 — 정상 세그먼트에서는 normalized가 이미 충분한 증거.
    if (flagged) {
      await putPublic(`${baseKey}.raw.txt`, rawTranscript, {
        contentType: 'text/plain; charset=utf-8',
      });
    }
  } catch (e) {
    console.warn(`[transcribe-segment ${segmentIndex}] sidecar upload failed:`, e?.message);
  }

  return jsonResponse(res, 200, {
    ok: true,
    segmentIndex,
    transcriptLength: transcript.length,
    flagged,
    loopDetected: loopReport.hasLoop,
  });
}
