import { createNotionClient } from '../../lib/clients/notion.js';
import {
  fetchBlobText,
  fetchBlobJson,
  listAllBlobs,
  del,
} from '../../lib/clients/blob.js';
import {
  uploadFileToNotion,
  buildTranscriptFilename,
} from '../../lib/notion/file-upload.js';
import { createMeetingNotionPage } from '../../lib/notion/page-create.js';
import { buildManifest, buildManifestFilename } from '../../lib/notion/manifest.js';
import { readJsonBody, jsonResponse } from '../../lib/http/body-parser.js';

// 클라 SEGMENT_SECONDS와 보조를 맞춰야 하는 상수.
// (드리프트 방지: 같은 값을 meeting-notes/app.js 상단에서도 정의)
const SEGMENT_SECONDS = 300;

// Notion 페이지 생성 + 진행 로그/전사 첨부 + 세션 폴더 정리
export default async function handleFinalizeNotion(req, res) {
  const body = await readJsonBody(req);
  const { sessionId, startedAtIso, endedAtIso, durationSec } = body;

  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return jsonResponse(res, 400, { error: 'Invalid session id' });
  }

  const prefix = `meetings/${sessionId}/`;
  const resultJson = await fetchBlobJson(`meetings/${sessionId}/result.json`);
  if (!resultJson) {
    return jsonResponse(res, 400, { error: 'No summary result found — run summarize first' });
  }
  const { meetingData, date, model: summarizeModel } = resultJson;

  // 전사 원문을 Notion에 업로드 (실패해도 페이지 생성은 진행)
  // Blob을 청소하기 직전에 끌어올려 진단 자료로 영구 보존.
  let transcriptUpload = null;
  let transcriptMergedChars = null;
  try {
    const transcriptText = await fetchBlobText(`meetings/${sessionId}/transcript.txt`);
    if (transcriptText != null) {
      transcriptMergedChars = transcriptText.length;
      const filename = buildTranscriptFilename(meetingData.title, date);
      // 기존 api 경로는 Blob 본문에 charset=utf-8 을 명시해 왔음 — blobContentType으로 보존.
      const id = await uploadFileToNotion({
        body: transcriptText,
        filename,
        contentType: 'text/plain',
        blobContentType: 'text/plain;charset=utf-8',
      });
      transcriptUpload = { id, charCount: transcriptText.length };
    }
  } catch (e) {
    console.warn('[transcript-upload] failed (페이지는 첨부 없이 생성):', e?.message);
  }

  // 진행 로그(diagnostic manifest) 생성 + Notion 업로드.
  // cleanup 직전에 만들어 Blob 폴더의 "최종 상태"를 박제.
  // 실패해도 페이지 생성은 진행 (manifest가 없어도 요약/전사는 보존되므로).
  let manifestUpload = null;
  let retentionIndices = new Set();
  try {
    const resultJsonSize = JSON.stringify(resultJson).length;
    const {
      text: manifestText,
      retentionIndices: retained,
    } = await buildManifest({
      sessionId,
      title: meetingData.title,
      date,
      segmentSeconds: SEGMENT_SECONDS,
      summarizeModel,
      startedAtIso,
      endedAtIso,
      durationSec,
      transcriptMergedChars,
      resultJsonSize,
    });
    retentionIndices = retained || new Set();
    const filename = buildManifestFilename(meetingData.title, date);
    const id = await uploadFileToNotion({
      body: manifestText,
      filename,
      contentType: 'text/plain',
      blobContentType: 'text/plain;charset=utf-8',
    });
    manifestUpload = { id, charCount: manifestText.length };
  } catch (e) {
    console.warn('[manifest-upload] failed (페이지는 진행 로그 없이 생성):', e?.message);
  }

  // Notion 페이지 생성 (진단 토글 안에 transcript + manifest 첨부 + sourceQuote 매핑 포함)
  const notion = await createNotionClient();
  const page = await createMeetingNotionPage({
    notion,
    databaseId: process.env.NOTION_DATABASE_ID,
    meetingData,
    date,
    transcriptUpload,
    manifestUpload,
  });

  // 청크 + 전사 + 결과 파일 정리. 단, retentionIndices에 해당하는 세그먼트(loop/짧은 전사로
  // flag됐거나 raw.txt가 남아 있는 세그먼트)는 사후 재전사/오프라인 분석을 위해 오디오 청크와
  // raw.txt/meta.json을 보존.
  // - 보존 대상: meetings/<sid>/seg-NN/chunk-*.bin          (retentionIndices 포함 index)
  //             meetings/<sid>/transcript-NN.raw.txt        (retentionIndices 포함 index)
  //             meetings/<sid>/transcript-NN.meta.json      (retentionIndices 포함 index)
  // - 삭제 대상: 그 외 전체 (transcript.txt, transcript-NN.txt, result.json 포함 —
  //             Notion에 이미 요약/전사/진행로그가 박제됨)
  // retentionIndices는 manifest에서 `meta.flagged==true ∪ raw.txt 존재`로 계산되므로
  // meta.json 업로드가 실패한 flagged 세그먼트도 raw.txt만 있으면 보존됨.
  try {
    const all = await listAllBlobs(prefix);
    const toDelete = [];
    for (const b of all) {
      if (!retentionIndices.size) { toDelete.push(b.url); continue; }
      const segMatch = b.pathname.match(/\/seg-(\d+)\/chunk-\d+\.bin$/);
      const rawMatch = b.pathname.match(/\/transcript-(\d+)\.raw\.txt$/);
      const metaMatch = b.pathname.match(/\/transcript-(\d+)\.meta\.json$/);
      const retainedIdx = segMatch ? Number(segMatch[1])
        : rawMatch ? Number(rawMatch[1])
        : metaMatch ? Number(metaMatch[1])
        : null;
      if (retainedIdx != null && retentionIndices.has(retainedIdx)) continue;
      toDelete.push(b.url);
    }
    if (toDelete.length) {
      await del(toDelete);
    }
    if (retentionIndices.size) {
      console.log(`[cleanup] retained segments: ${[...retentionIndices].sort((a, b) => a - b).join(', ')}`);
    }
  } catch (e) {
    console.warn('[cleanup] failed:', e?.message);
  }

  return jsonResponse(res, 200, {
    ok: true,
    title: meetingData.title,
    notionUrl: page.url,
  });
}
