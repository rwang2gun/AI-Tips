import { createGeminiClient } from '../../lib/clients/gemini.js';
import { list } from '../../lib/clients/blob.js';
import { concatBlobChunks } from '../../lib/audio/chunking.js';
import { readJsonBody, jsonResponse } from '../../lib/http/body-parser.js';
import { withRetry } from '../../lib/http/retry.js';

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
  const { blobs } = await list({ prefix: segPrefix });
  if (!blobs.length) {
    return jsonResponse(res, 400, { error: `No chunks found for segment ${segmentIndex}` });
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
