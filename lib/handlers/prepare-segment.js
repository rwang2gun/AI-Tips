import { createGeminiClient, getGeminiBackend } from '../clients/gemini.js';
import { isBillingDepleted } from '../http/gemini-error.js';
import { listAllBlobs } from '../clients/blob.js';
import { concatBlobChunks } from '../audio/chunking.js';
import { readJsonBody, jsonResponse } from '../http/body-parser.js';
import { withRetry } from '../http/retry.js';

// segment 단계 1: 한 세그먼트 청크 결합 + Gemini Files API 업로드
//
// 백엔드별:
//   - vertex: Files API 미지원 → 업로드 없이 ACTIVE 마커만 반환(transcribe가 인라인 전송)
//   - aistudio: 청크 결합 → Files API 업로드 → fileUri 반환
//   - auto: aistudio 업로드를 시도하고, 선불 크레딧 소진 시 vertex 마커로 폴백
//           → transcribe가 fileUri 없음을 보고 인라인(Vertex)으로 처리
//
// vertex 마커: fileName/fileUri 없음 + state='ACTIVE'. 클라이언트(app.js)는 ACTIVE를 받으면
// check-file 폴링을 건너뛰고 곧장 transcribe를 호출하므로 클라이언트 변경이 필요 없다.
function vertexMarker(res, segmentIndex, mimeType) {
  return jsonResponse(res, 200, {
    ok: true,
    segmentIndex,
    state: 'ACTIVE',
    fileMimeType: mimeType || 'audio/webm',
    backend: 'vertex',
  });
}

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

  const mode = getGeminiBackend();
  if (mode === 'vertex') {
    return vertexMarker(res, segmentIndex, mimeType);
  }

  // aistudio 또는 auto: Files API 업로드 시도.
  const audioBuffer = await concatBlobChunks(blobs);
  const genAI = createGeminiClient({ backend: 'aistudio' });
  const audioBlob = new Blob([audioBuffer], { type: mimeType || 'audio/webm' });
  try {
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
  } catch (err) {
    // auto 모드에서 선불 소진 → Vertex 인라인 경로로 폴백(앱 무중단).
    if (mode === 'auto' && isBillingDepleted(err)) {
      console.warn(`[prepare-segment ${segmentIndex}] AI Studio 선불 소진 → Vertex 인라인으로 폴백`);
      return vertexMarker(res, segmentIndex, mimeType);
    }
    throw err;
  }
}
