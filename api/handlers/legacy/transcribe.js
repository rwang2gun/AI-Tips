// recover.html 호환용 legacy 핸들러 — 단일 파일(세그먼트 분할 전) 세션 복구에만 사용.
// 신규 녹음은 transcribe-segment 경로를 쓴다.
import { createUserContent, createPartFromUri } from '@google/genai';
import { buildLegacyTranscribePrompt } from '../../../lib/prompts/transcribe.js';
import { createGeminiClient } from '../../../lib/clients/gemini.js';
import { putPublic } from '../../../lib/clients/blob.js';
import { readJsonBody, jsonResponse } from '../../../lib/http/body-parser.js';

// Gemini 오디오 → 한국어 전사문 (단일 파일)
export default async function handleTranscribe(req, res) {
  const body = await readJsonBody(req);
  const { sessionId, fileUri, fileMimeType } = body;

  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return jsonResponse(res, 400, { error: 'Invalid session id' });
  }
  if (!fileUri || !fileMimeType) {
    return jsonResponse(res, 400, { error: 'Missing fileUri/fileMimeType' });
  }

  const genAI = createGeminiClient();

  const promptText = buildLegacyTranscribePrompt();

  const result = await genAI.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      createUserContent([
        promptText,
        createPartFromUri(fileUri, fileMimeType),
      ]),
    ],
  });

  const transcript = result.text || '';
  if (!transcript.trim()) {
    return jsonResponse(res, 500, { error: 'Empty transcript from Gemini' });
  }

  // 전사문을 Blob에 저장 (다음 단계 summarize에서 읽음)
  await putPublic(`meetings/${sessionId}/transcript.txt`, transcript, {
    contentType: 'text/plain; charset=utf-8',
  });

  return jsonResponse(res, 200, {
    ok: true,
    transcriptLength: transcript.length,
  });
}
