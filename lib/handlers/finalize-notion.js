import { createNotionClient } from '../clients/notion.js';
import {
  fetchBlobText,
  fetchBlobJson,
  listAllBlobs,
  del,
} from '../clients/blob.js';
import {
  uploadFileToNotion,
  buildTranscriptFilename,
} from '../notion/file-upload.js';
import { createMeetingNotionPage } from '../notion/page-create.js';
import { buildManifest, buildManifestFilename } from '../notion/manifest.js';
import { readJsonBody, jsonResponse } from '../http/body-parser.js';
import { isCleanupTarget } from '../storage/usage.js';

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
  try {
    const resultJsonSize = JSON.stringify(resultJson).length;
    const { text: manifestText } = await buildManifest({
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

  // 파생 결과물만 삭제. 오디오/raw/meta는 모두 보존 — 24h 이상 경과한 뒤 결과 UI의
  // 수동 cleanup 버튼(cleanup-old-audio action)으로 정리됨.
  // isCleanupTarget=true인 pathname은 보존, false면 삭제 (즉 화이트리스트 역전).
  // 보존 (화이트리스트):
  //   seg-*/chunk-*.bin, transcript-*.raw.txt, transcript-*.meta.json
  // 삭제 (Notion에 박제됨):
  //   transcript.txt, transcript-NN.txt, result.json
  try {
    const all = await listAllBlobs(prefix);
    const toDelete = all.filter((b) => !isCleanupTarget(b.pathname)).map((b) => b.url);
    if (toDelete.length) {
      await del(toDelete);
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
