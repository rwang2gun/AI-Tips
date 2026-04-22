import { putPublic } from '../clients/blob.js';
import { readRawBody, jsonResponse } from '../http/body-parser.js';

export default async function handleUploadChunk(req, res) {
  const sessionId = req.headers['x-session-id'];
  const chunkIndex = req.headers['x-chunk-index'];
  const totalChunks = req.headers['x-total-chunks'];
  const segmentIndex = req.headers['x-segment-index']; // 신규: segment 단위. 없으면 legacy 경로

  if (!sessionId || chunkIndex == null || !totalChunks) {
    return jsonResponse(res, 400, { error: 'Missing session/chunk headers' });
  }

  // sessionId 화이트리스트 — UUID v4 형식만 허용 (path traversal 방지)
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return jsonResponse(res, 400, { error: 'Invalid session id' });
  }

  let key;
  if (segmentIndex != null) {
    const segNum = Number(segmentIndex);
    if (!Number.isInteger(segNum) || segNum < 0 || segNum > 999) {
      return jsonResponse(res, 400, { error: 'Invalid segment index' });
    }
    key = `meetings/${sessionId}/seg-${String(segNum).padStart(2, '0')}/chunk-${String(chunkIndex).padStart(4, '0')}.bin`;
  } else {
    key = `meetings/${sessionId}/chunk-${String(chunkIndex).padStart(4, '0')}.bin`;
  }

  const buffer = await readRawBody(req);
  // putPublic 기본 옵션: access:'public' / addRandomSuffix:false / allowOverwrite:true.
  // public은 Vercel Blob 정책상 필요 — 키가 추측 불가능한 UUID라 사실상 비공개.
  await putPublic(key, buffer);

  return jsonResponse(res, 200, { ok: true, chunkIndex: Number(chunkIndex) });
}
