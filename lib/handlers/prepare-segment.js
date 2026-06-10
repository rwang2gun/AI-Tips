import { createGeminiClient, isVertexBackend } from '../clients/gemini.js';
import { listAllBlobs } from '../clients/blob.js';
import { concatBlobChunks } from '../audio/chunking.js';
import { readJsonBody, jsonResponse } from '../http/body-parser.js';
import { withRetry } from '../http/retry.js';

// segment 단계 1: 한 세그먼트 청크 결합 + Gemini Files API 업로드
export default async function handlePrepareSegment(req, res) {
  const body = await readJsonBody(req);
  const { sessionId, segmentIndex, mimeType } = body;

  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return jsonResponse(res, 400, { error: 'Invalid session id' });
  }
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex > 999) {
    return jsonResponse(res, 400, { error: 'Invalid segment index' });
  }

  const segPrefix = `meetings/${sessionId}/seg-${String(segmentIndex).padStart(2, '0')}/`;
  const blobs = await listAllBlobs(segPrefix);
  if (!blobs.length) {
    return jsonResponse(res, 400, { error: `No chunks found for segment ${segmentIndex}` });
  }

  // Vertex는 Files API 미지원 → 여기서 업로드하지 않고 청크 존재만 확인 후 ACTIVE를 반환.
  // 클라이언트(app.js)는 state='ACTIVE' + fileName 없음을 받으면 check-file 폴링을 건너뛰고
  // 곧장 transcribe-segment를 호출하며, transcribe가 청크를 다시 읽어 인라인(base64)으로 전송한다.
  // (클라이언트 변경 불필요 — pollFileActive가 PROCESSING이 아닐 때 즉시 통과하는 기존 로직 활용)
  if (isVertexBackend()) {
    return jsonResponse(res, 200, {
      ok: true,
      segmentIndex,
      state: 'ACTIVE',
      fileMimeType: mimeType || 'audio/webm',
      backend: 'vertex',
    });
  }

  const audioBuffer = await concatBlobChunks(blobs);

  const genAI = createGeminiClient();
  const audioBlob = new Blob([audioBuffer], { type: mimeType || 'audio/webm' });
  const uploaded = await withRetry(() =>
    genAI.files.upload({
      file: audioBlob,
      config: { mimeType: mimeType || 'audio/webm' },
    })
  );

  return jsonResponse(res, 200, {
    ok: true,
    segmentIndex,
    fileName: uploaded.name,
    fileUri: uploaded.uri,
    fileMimeType: uploaded.mimeType,
    state: uploaded.state,
  });
}
