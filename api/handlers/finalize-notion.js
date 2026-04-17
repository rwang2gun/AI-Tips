import { createNotionClient } from '../../lib/clients/notion.js';
import { fetchBlobText, fetchBlobJson, deleteByPrefix } from '../../lib/clients/blob.js';
import {
  uploadFileToNotion,
  buildTranscriptFilename,
} from '../../lib/notion/file-upload.js';
import { createMeetingNotionPage } from '../../lib/notion/page-create.js';
import { readJsonBody, jsonResponse } from '../../lib/http/body-parser.js';

// Notion 페이지 생성 + 세션 폴더 정리
export default async function handleFinalizeNotion(req, res) {
  const body = await readJsonBody(req);
  const { sessionId } = body;

  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return jsonResponse(res, 400, { error: 'Invalid session id' });
  }

  const prefix = `meetings/${sessionId}/`;
  const resultJson = await fetchBlobJson(`meetings/${sessionId}/result.json`);
  if (!resultJson) {
    return jsonResponse(res, 400, { error: 'No summary result found — run summarize first' });
  }
  const { meetingData, date } = resultJson;

  // 전사 원문을 Notion에 업로드 (실패해도 페이지 생성은 진행)
  // Blob을 청소하기 직전에 끌어올려 진단 자료로 영구 보존.
  let transcriptUpload = null;
  try {
    const transcriptText = await fetchBlobText(`meetings/${sessionId}/transcript.txt`);
    if (transcriptText != null) {
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

  // Notion 페이지 생성 (진단 토글 안에 transcript 첨부 + sourceQuote 매핑 포함)
  const notion = await createNotionClient();
  const page = await createMeetingNotionPage({
    notion,
    databaseId: process.env.NOTION_DATABASE_ID,
    meetingData,
    date,
    transcriptUpload,
  });

  // 청크 + 전사 + 결과 파일 모두 정리 (전사는 이미 Notion에 첨부됐고, Gemini 파일은 48시간 후 자동 삭제)
  try {
    await deleteByPrefix(prefix);
  } catch (e) {
    console.warn('[cleanup] failed:', e?.message);
  }

  return jsonResponse(res, 200, {
    ok: true,
    title: meetingData.title,
    notionUrl: page.url,
  });
}
