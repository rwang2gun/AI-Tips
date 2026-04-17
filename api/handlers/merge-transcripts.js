import { putPublic, list } from '../../lib/clients/blob.js';
import {
  mergeSegmentTranscripts,
  selectSegmentTranscriptBlobs,
} from '../../lib/audio/chunking.js';
import { readJsonBody, jsonResponse } from '../../lib/http/body-parser.js';

// segment 단계 3: transcript-NN.txt 전체 결합 → transcript.txt
export default async function handleMergeTranscripts(req, res) {
  const body = await readJsonBody(req);
  const { sessionId, totalSegments } = body;

  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return jsonResponse(res, 400, { error: 'Invalid session id' });
  }

  const prefix = `meetings/${sessionId}/transcript-`;
  const { blobs } = await list({ prefix });
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
