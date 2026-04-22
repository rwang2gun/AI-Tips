import { putPublic, listAllBlobs } from '../clients/blob.js';
import {
  mergeSegmentTranscripts,
  selectSegmentTranscriptBlobs,
} from '../audio/chunking.js';
import { readJsonBody, jsonResponse } from '../http/body-parser.js';

// segment 단계 3: transcript-NN.txt 전체 결합 → transcript.txt
export default async function handleMergeTranscripts(req, res) {
  const body = await readJsonBody(req);
  const { sessionId, totalSegments } = body;

  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return jsonResponse(res, 400, { error: 'Invalid session id' });
  }

  const prefix = `meetings/${sessionId}/transcript-`;
  // list()는 페이지당 100~1000개만 반환하므로 cursor로 전부 가져와야 함.
  // 장시간 회의(예: 67분 × 30s 세그먼트 = 134개)에서 단일 호출은 잘림.
  const blobs = await listAllBlobs(prefix);
  const segmentBlobs = selectSegmentTranscriptBlobs(blobs);

  if (!segmentBlobs.length) {
    return jsonResponse(res, 400, { error: 'No segment transcripts found' });
  }
  if (totalSegments && segmentBlobs.length !== totalSegments) {
    return jsonResponse(res, 400, {
      error: `Segment count mismatch: expected ${totalSegments}, got ${segmentBlobs.length}`,
    });
  }

  const merged = await mergeSegmentTranscripts(segmentBlobs);

  await putPublic(`meetings/${sessionId}/transcript.txt`, merged, {
    contentType: 'text/plain; charset=utf-8',
  });

  return jsonResponse(res, 200, {
    ok: true,
    segmentCount: segmentBlobs.length,
    transcriptLength: merged.length,
  });
}
