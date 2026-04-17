// ============================================================
// 회의록 자동 생성 — 서버리스 함수
// ============================================================
//
// [흐름 — segment 기반 파이프라인]
//   클라이언트(meeting-notes/app.js)가 5분 단위로 녹음을 분할하여
//   segment 하나당 독립 webm 파일을 만들고 다음 액션들을 호출:
//
//   세그먼트별 (S = 세그먼트 인덱스):
//     1. upload-chunk         (X-Segment-Index: S)
//        → 세그먼트 S의 오디오 청크(3.5MB 이하)를
//          meetings/<sid>/seg-NN/chunk-NNNN.bin 로 저장
//     2. prepare-segment      ({ sessionId, segmentIndex: S, mimeType })
//        → 세그먼트 S의 청크 결합 → Gemini Files API 업로드
//        → 파일 URI 반환 (ACTIVE 대기는 클라이언트에서 폴링)
//     3. check-file           (Gemini 파일 ACTIVE 상태 폴링)
//     4. transcribe-segment   ({ sessionId, segmentIndex: S, fileUri, ... })
//        → 세그먼트 S 한국어 전사 → meetings/<sid>/transcript-NN.txt
//
//   모든 세그먼트 처리 후:
//     5. merge-transcripts    ({ sessionId, totalSegments })
//        → transcript-NN.txt 전체를 시간순 정렬·결합 → transcript.txt
//     6. summarize            (전사문 → 구조화 JSON → result.json)
//     7. finalize-notion      (Notion 페이지 생성 + 세션 폴더 정리)
//
// [세그먼트 분할 이유]
//   Vercel Hobby 함수 60초 한도 내에서 긴 회의를 처리하려면 단일 Gemini
//   호출의 입력 오디오 길이를 짧게 유지해야 함. 30분 이상 단일 오디오는
//   transcribe 호출이 60초 초과 + Flash가 긴 단일 오디오에서 generation
//   loop(같은 문장 반복) 일으킴. 5분이 실전 안정 기준치.
//   ※ Gemini Files API의 videoMetadata.startOffset/endOffset은 audio에
//     silently ignored — 서버단 가상 분할 불가, 클라이언트단 실제 분할 필요.
//
// [legacy 액션]
//   prepare / transcribe (단일 파일 처리)는 meeting-notes/recover.html의
//   기존 실패 세션(seg-NN 폴더 없는 경우) 복구용으로 보존. 신규 녹음은
//   항상 segment 경로를 사용함.
//
// [핵심 설계 결정]
//   - 청크 3.5MB 분할: Vercel Hobby 4.5MB 본문 한도 때문
//   - Gemini Files API: 큰 오디오를 업로드 후 URI로 참조
//   - responseSchema: JSON 구조를 강제해서 안정적 파싱
//   - 용어집(fetchGlossary): Notion DB에서 활성 용어 조회 → 프롬프트에 삽입
//     → Notion에서 용어 추가/편집하면 코드 수정 없이 즉시 반영
//
// [Notion DB 정보]
//   - 자동 회의록 DB (NOTION_DATABASE_ID)
//     속성: 이름(title), 회의 날짜(date), 회의 유형(select),
//           레이블(multi_select: 전투/시스템/밸런스/UI),
//           참석자(person, 수동), 회의록 작성자(person, 수동)
//     페이지 서식: 기본 정보 / 후속 진행 업무 / 아젠다 / 논의 사항 / 결정 사항 / To-do
//   - 용어집 DB (NOTION_GLOSSARY_DB_ID)
//     속성: 용어(title), 설명(text), 카테고리(select), 활성(checkbox)
//
// [Enterprise 전환 시 변경 포인트]
//   - Gemini → Claude API (오디오 직접 입력 지원)
//   - Notion API 직접 호출 → MCP 커넥터로 대체
//   - Vercel Blob → 불필요 (서버리스 자체가 불필요할 수 있음)
//   - fetchGlossary() → Claude가 MCP로 용어집 DB 직접 조회
//   - buildBlocks() → MCP가 Notion 마크다운으로 직접 생성
//
// [환경변수]
//   GEMINI_API_KEY          — Google AI Studio에서 발급
//   NOTION_TOKEN            — Notion Integration 토큰
//   NOTION_DATABASE_ID      — 자동 회의록 DB ID
//   NOTION_GLOSSARY_DB_ID   — 용어집 DB ID
//   BLOB_READ_WRITE_TOKEN   — Vercel Blob 활성화 시 자동 등록
// ============================================================

import { createUserContent, createPartFromUri } from '@google/genai';
import { meetingSchema } from '../lib/schemas/meeting.js';
import {
  buildLegacyTranscribePrompt,
  buildSegmentTranscribePrompt,
} from '../lib/prompts/transcribe.js';
import { buildSummarizePrompt, buildRefineTopicPrompt } from '../lib/prompts/summarize.js';
import { fetchGlossary } from '../lib/glossary.js';
import { fetchGuide } from '../lib/guide.js';
import { createGeminiClient } from '../lib/clients/gemini.js';
import { createNotionClient } from '../lib/clients/notion.js';
import {
  putPublic,
  list,
  fetchBlobText,
  fetchBlobJson,
  findBlob,
  deleteByPrefix,
} from '../lib/clients/blob.js';
import {
  concatBlobChunks,
  mergeSegmentTranscripts,
  selectSegmentTranscriptBlobs,
} from '../lib/audio/chunking.js';
import {
  uploadFileToNotion,
  buildTranscriptFilename,
} from '../lib/notion/file-upload.js';
import { buildMeetingPageBlocks } from '../lib/notion/page-builder.js';
import { readJsonBody, jsonResponse } from '../lib/http/body-parser.js';
import { withRetry } from '../lib/http/retry.js';
import handleUploadChunk from './handlers/upload-chunk.js';
import handleCheckFile from './handlers/check-file.js';
import handlePrepareSegment from './handlers/prepare-segment.js';
import handleTranscribeSegment from './handlers/transcribe-segment.js';
import handleMergeTranscripts from './handlers/merge-transcripts.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

// ------- 메인 핸들러 -------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return jsonResponse(res, 405, { error: 'Method not allowed' });
  }

  const action = req.headers['x-action'];

  try {
    if (action === 'upload-chunk') {
      return await handleUploadChunk(req, res);
    }
    if (action === 'prepare-segment') {
      return await handlePrepareSegment(req, res);
    }
    if (action === 'transcribe-segment') {
      return await handleTranscribeSegment(req, res);
    }
    if (action === 'merge-transcripts') {
      return await handleMergeTranscripts(req, res);
    }
    if (action === 'check-file') {
      return await handleCheckFile(req, res);
    }
    if (action === 'summarize') {
      return await handleSummarize(req, res);
    }
    if (action === 'finalize-notion') {
      return await handleFinalizeNotion(req, res);
    }
    // legacy — recover.html에서 단일 파일 세션 복구 시 사용
    if (action === 'prepare') {
      return await handlePrepare(req, res);
    }
    if (action === 'transcribe') {
      return await handleTranscribe(req, res);
    }
    return jsonResponse(res, 400, { error: 'Unknown X-Action' });
  } catch (err) {
    console.error('[process-meeting] error:', err);
    return jsonResponse(res, 500, {
      error: err?.message || 'Internal server error',
      stack: process.env.NODE_ENV === 'development' ? err?.stack : undefined,
    });
  }
}

// ------- 1단계: 청크 결합 + Gemini Files API 업로드 -------

async function handlePrepare(req, res) {
  const body = await readJsonBody(req);
  const { sessionId, mimeType } = body;

  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return jsonResponse(res, 400, { error: 'Invalid session id' });
  }

  const prefix = `meetings/${sessionId}/`;
  const { blobs } = await list({ prefix });
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

// ------- 3단계: Gemini 오디오 → 한국어 전사문 -------

async function handleTranscribe(req, res) {
  const body = await readJsonBody(req);
  const { sessionId, fileUri, fileMimeType } = body;

  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return jsonResponse(res, 400, { error: 'Invalid session id' });
  }
  if (!fileUri || !fileMimeType) {
    return jsonResponse(res, 400, { error: 'Missing fileUri/fileMimeType' });
  }

  const genAI = createGeminiClient();

  const promptText = buildLegacyTranscribePrompt();

  const result = await genAI.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      createUserContent([
        promptText,
        createPartFromUri(fileUri, fileMimeType),
      ]),
    ],
  });

  const transcript = result.text || '';
  if (!transcript.trim()) {
    return jsonResponse(res, 500, { error: 'Empty transcript from Gemini' });
  }

  // 전사문을 Blob에 저장 (다음 단계 summarize에서 읽음)
  await putPublic(`meetings/${sessionId}/transcript.txt`, transcript, {
    contentType: 'text/plain; charset=utf-8',
  });

  return jsonResponse(res, 200, {
    ok: true,
    transcriptLength: transcript.length,
  });
}

// ------- 4단계: 전사문 → 구조화 JSON 요약 -------

async function handleSummarize(req, res) {
  const body = await readJsonBody(req);
  const { sessionId, title, meetingType, durationSec } = body;

  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return jsonResponse(res, 400, { error: 'Invalid session id' });
  }

  // Blob에서 전사문 가져오기
  const transcript = await fetchBlobText(`meetings/${sessionId}/transcript.txt`);
  if (transcript == null) {
    return jsonResponse(res, 400, { error: 'No transcript found — run transcribe first' });
  }
  if (!transcript.trim()) {
    return jsonResponse(res, 400, { error: 'Empty transcript' });
  }

  // Notion 용어집 + 작성 가이드 조회 (가이드 없으면 빈 문자열로 프롬프트에서 생략됨)
  // header는 기존 api 프롬프트에 사용되던 문구 그대로 유지.
  const glossaryText = await fetchGlossary({
    header: '[용어집 — 아래 용어가 음성에서 들리면 정확한 표기를 사용하세요]',
  });
  const guideText = await fetchGuide();

  const genAI = createGeminiClient();
  const today = new Date().toISOString().slice(0, 10);
  const meetingMeta = {
    requestedTitle: title,
    requestedMeetingType: meetingType,
    durationSec,
    date: today,
  };

  const promptText = buildSummarizePrompt({
    meetingMeta,
    transcript,
    glossaryText,
    guideText,
  });

  const result = await withRetry(() =>
    genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [createUserContent([promptText])],
      config: {
        responseMimeType: 'application/json',
        responseSchema: meetingSchema(),
      },
    })
  );

  const meetingData = JSON.parse(result.text);

  // 1차 topic이 50자 초과면 Pro로 한 번 더 압축. 입력이 작아 빠르고 503 위험 적음.
  // 실패 시 1차 topic 유지 (요약 자체는 이미 성공).
  if (meetingData.topic && meetingData.topic.length > 50) {
    try {
      const refined = await withRetry(() => refineTopic(genAI, meetingData));
      if (refined && refined.length > 0 && refined.length < meetingData.topic.length) {
        console.log(`[refine-topic] ${meetingData.topic.length} → ${refined.length} chars`);
        meetingData.topic = refined;
      }
    } catch (e) {
      console.warn('[refine-topic] failed (1차 topic 유지):', e?.message);
    }
  }

  // 결과 JSON을 Blob에 저장 (다음 단계 finalize-notion에서 읽음)
  const payload = { meetingData, date: today };
  await putPublic(`meetings/${sessionId}/result.json`, JSON.stringify(payload), {
    contentType: 'application/json',
  });

  return jsonResponse(res, 200, {
    ok: true,
    title: meetingData.title,
  });
}

// ------- 5단계: Notion 페이지 생성 + 세션 폴더 정리 -------

async function handleFinalizeNotion(req, res) {
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
  const notionUrl = await createNotionPage(meetingData, date, transcriptUpload);

  // 청크 + 전사 + 결과 파일 모두 정리 (전사는 이미 Notion에 첨부됐고, Gemini 파일은 48시간 후 자동 삭제)
  try {
    await deleteByPrefix(prefix);
  } catch (e) {
    console.warn('[cleanup] failed:', e?.message);
  }

  return jsonResponse(res, 200, {
    ok: true,
    title: meetingData.title,
    notionUrl,
  });
}

// ------- 1차 topic 재압축 (Pro) -------

// 1차 요약(Flash) 결과의 topic이 50자 초과일 때 Pro로 한 번 더 짧게 압축.
// 입력은 title + 1차 topic + agenda 제목들로 매우 작아서 빠르게 끝남.
async function refineTopic(genAI, meetingData) {
  const prompt = buildRefineTopicPrompt({ meetingData });

  const result = await genAI.models.generateContent({
    model: 'gemini-2.5-pro',
    contents: [createUserContent([prompt])],
    config: { maxOutputTokens: 256 },
  });

  let text = (result.text || '').trim();
  text = text.split('\n')[0].trim();
  text = text.replace(/^["'`「『\[(](.*)["'`」』\])]$/s, '$1').trim();
  text = text.replace(/^[Tt]opic\s*[:：]\s*/, '').trim();
  return text;
}

// ------- Notion 페이지 생성 -------

async function createNotionPage(data, dateStr, transcriptUpload = null) {
  const notion = await createNotionClient();
  const databaseId = process.env.NOTION_DATABASE_ID;

  const properties = {
    '이름': { title: [{ text: { content: data.title } }] },
    '회의 날짜': { date: { start: dateStr } },
    '회의 유형': { select: { name: data.meetingType } },
  };
  if (data.labels?.length) {
    properties['레이블'] = { multi_select: data.labels.map((name) => ({ name })) };
  }

  const children = buildMeetingPageBlocks(data, transcriptUpload);

  const page = await notion.pages.create({
    parent: { database_id: databaseId },
    properties,
    children,
  });

  return page.url;
}

