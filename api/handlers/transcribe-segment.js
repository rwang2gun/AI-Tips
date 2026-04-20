import { createUserContent, createPartFromUri } from '@google/genai';
import { buildSegmentTranscribePrompt } from '../../lib/prompts/transcribe.js';
import { createGeminiClient } from '../../lib/clients/gemini.js';
import { putPublic } from '../../lib/clients/blob.js';
import { readJsonBody, jsonResponse } from '../../lib/http/body-parser.js';
import { withRetry } from '../../lib/http/retry.js';
import { fetchSynonyms, buildTranscribeSynonymHint } from '../../lib/synonyms.js';
import { applySynonymReplacements } from '../../lib/transcript/post-process.js';

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
      model: 'gemini-2.5-flash',
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

  const { text: transcript, applied } = applySynonymReplacements(rawTranscript, synonyms);
  if (applied.length) {
    console.log(`[transcribe-segment ${segmentIndex}] synonym replacements:`, applied);
  }

  const key = `meetings/${sessionId}/transcript-${String(segmentIndex).padStart(2, '0')}.txt`;
  await putPublic(key, transcript, { contentType: 'text/plain; charset=utf-8' });

  return jsonResponse(res, 200, {
    ok: true,
    segmentIndex,
    transcriptLength: transcript.length,
  });
}
