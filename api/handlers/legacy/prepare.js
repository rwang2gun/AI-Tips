// recover.html 호환용 legacy 핸들러 — 단일 파일(세그먼트 분할 전) 세션 복구에만 사용.
// 신규 녹음은 prepare-segment 경로를 쓴다.
import { createGeminiClient } from '../../../lib/clients/gemini.js';
import { listAllBlobs } from '../../../lib/clients/blob.js';
import { concatBlobChunks } from '../../../lib/audio/chunking.js';
import { readJsonBody, jsonResponse } from '../../../lib/http/body-parser.js';

// 청크 결합 + Gemini Files API 업로드 (단일 파일)
export default async function handlePrepare(req, res) {
  const body = await readJsonBody(req);
  const { sessionId, mimeType } = body;

  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return jsonResponse(res, 400, { error: 'Invalid session id' });
  }

  const prefix = `meetings/${sessionId}/`;
  const blobs = await listAllBlobs(prefix);
  if (!blobs.length) {
    return jsonResponse(res, 400, { error: 'No audio chunks found for session' });
  }
  const audioBuffer = await concatBlobChunks(blobs);

  // Gemini Files API에 업로드 — PROCESSING 상태 대기는 클라이언트에서 check-file로 폴링
  const genAI = createGeminiClient();
  const audioBlob = new Blob([audioBuffer], { type: mimeType || 'audio/webm' });

  const uploaded = await genAI.files.upload({
    file: audioBlob,
    config: { mimeType: mimeType || 'audio/webm' },
  });

  return jsonResponse(res, 200, {
    ok: true,
    fileName: uploaded.name,
    fileUri: uploaded.uri,
    fileMimeType: uploaded.mimeType,
    state: uploaded.state,
  });
}
