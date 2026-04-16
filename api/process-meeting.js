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

import { GoogleGenAI, createUserContent, createPartFromUri } from '@google/genai';
import { Client as NotionClient } from '@notionhq/client';
import { put, list, del } from '@vercel/blob';

export const config = {
  api: {
    bodyParser: false,
  },
};

// ------- 유틸 -------

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readRawBody(req);
  return JSON.parse(buf.toString('utf-8'));
}

function jsonResponse(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

// Gemini 503/429/일시적 거절을 지수 백오프로 재시도.
// Vercel 60초 한도 안에 끝나도록 maxAttempts/maxDelay 보수적으로 설정.
async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 2000, maxDelayMs = 8000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.status || err?.response?.status;
      const msg = err?.message || '';
      const retriable =
        status === 429 || status === 500 || status === 503 ||
        /overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED|503|429/i.test(msg);
      if (!retriable || attempt === maxAttempts) throw err;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      console.warn(`[withRetry] attempt ${attempt}/${maxAttempts} failed (${status || 'unknown'}): ${msg.slice(0, 120)}; retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

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

// ------- 청크 업로드 -------

async function handleUploadChunk(req, res) {
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
  await put(key, buffer, {
    access: 'public', // Vercel Blob 정책상 필요. 키가 추측 불가능한 UUID라 사실상 비공개
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  return jsonResponse(res, 200, { ok: true, chunkIndex: Number(chunkIndex) });
}

// ------- 1단계: 청크 결합 + Gemini Files API 업로드 -------

async function handlePrepare(req, res) {
  const body = await readJsonBody(req);
  const { sessionId, mimeType } = body;

  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return jsonResponse(res, 400, { error: 'Invalid session id' });
  }

  // Vercel Blob에서 모든 청크 가져와 결합
  const prefix = `meetings/${sessionId}/`;
  const { blobs } = await list({ prefix });
  if (!blobs.length) {
    return jsonResponse(res, 400, { error: 'No audio chunks found for session' });
  }
  blobs.sort((a, b) => a.pathname.localeCompare(b.pathname));

  const chunkBuffers = await Promise.all(
    blobs.map(async (b) => {
      const r = await fetch(b.url);
      const buf = await r.arrayBuffer();
      return Buffer.from(buf);
    })
  );
  const audioBuffer = Buffer.concat(chunkBuffers);

  // Gemini Files API에 업로드 — PROCESSING 상태 대기는 클라이언트에서 check-file로 폴링
  const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
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

// ------- 2단계: Gemini 파일 처리 상태 확인 (클라이언트가 폴링) -------

async function handleCheckFile(req, res) {
  const body = await readJsonBody(req);
  const { fileName } = body;

  if (!fileName || typeof fileName !== 'string' || !fileName.startsWith('files/')) {
    return jsonResponse(res, 400, { error: 'Invalid fileName' });
  }

  const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const fileInfo = await genAI.files.get({ name: fileName });

  return jsonResponse(res, 200, {
    ok: true,
    state: fileInfo.state,
    fileUri: fileInfo.uri,
    fileMimeType: fileInfo.mimeType,
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

  const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const promptText = `첨부된 한국어 회의 녹음을 정확히 전사하세요.

[규칙]
1. 들리는 내용을 누락 없이 옮겨 쓸 것
2. 발언자 구분은 하지 말고 발언 순서대로 작성
3. "음", "어" 같은 군더더기는 생략하되 실제 의미 있는 말은 모두 포함
4. 잘 안 들리는 구간은 [불분명] 으로 표시
5. 문장 단위로 줄바꿈하여 가독성 확보
6. 해설이나 요약 없이 들은 말만 옮겨 쓸 것`;

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
  await put(`meetings/${sessionId}/transcript.txt`, transcript, {
    access: 'public',
    contentType: 'text/plain; charset=utf-8',
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  return jsonResponse(res, 200, {
    ok: true,
    transcriptLength: transcript.length,
  });
}

// ------- segment 단계 1: 한 세그먼트 청크 결합 + Gemini Files API 업로드 -------

async function handlePrepareSegment(req, res) {
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
  blobs.sort((a, b) => a.pathname.localeCompare(b.pathname));

  const chunkBuffers = await Promise.all(
    blobs.map(async (b) => {
      const r = await fetch(b.url);
      return Buffer.from(await r.arrayBuffer());
    })
  );
  const audioBuffer = Buffer.concat(chunkBuffers);

  const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
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

// ------- segment 단계 2: 한 세그먼트 전사 → transcript-NN.txt -------

async function handleTranscribeSegment(req, res) {
  const body = await readJsonBody(req);
  const { sessionId, segmentIndex, fileUri, fileMimeType, totalSegments } = body;

  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return jsonResponse(res, 400, { error: 'Invalid session id' });
  }
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex > 999) {
    return jsonResponse(res, 400, { error: 'Invalid segment index' });
  }
  if (!fileUri || !fileMimeType) {
    return jsonResponse(res, 400, { error: 'Missing fileUri/fileMimeType' });
  }

  const part = totalSegments
    ? `이 오디오는 전체 회의 중 ${segmentIndex + 1}/${totalSegments} 번째 5분 구간입니다.`
    : `이 오디오는 전체 회의의 한 구간입니다.`;

  const promptText = `${part} 앞뒤 구간은 별도로 처리되니 이 구간만 정확히 한국어로 전사하세요.

[규칙]
1. 들리는 내용을 누락 없이 옮겨 쓸 것
2. 발언자 구분은 하지 말고 발언 순서대로 작성
3. "음", "어" 같은 군더더기는 생략하되 실제 의미 있는 말은 모두 포함
4. 잘 안 들리는 구간은 [불분명] 으로 표시
5. 문장 단위로 줄바꿈하여 가독성 확보
6. 해설이나 요약 없이 들은 말만 옮겨 쓸 것
7. 구간 시작/끝에 별도 표시(타임스탬프 등) 추가하지 말 것 — 본문만 출력`;

  const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const result = await withRetry(() =>
    genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        createUserContent([
          promptText,
          createPartFromUri(fileUri, fileMimeType),
        ]),
      ],
      // thinking OFF — Flash가 단순 전사에서 thinking에 출력 토큰 소비 후 MAX_TOKENS로 빈 응답 반환하는 이슈 회피 (PR #8 참고)
      config: {
        maxOutputTokens: 65536,
        thinkingConfig: { thinkingBudget: 0 },
      },
    })
  );

  const transcript = result.text || '';
  if (!transcript.trim()) {
    return jsonResponse(res, 500, { error: `Empty transcript for segment ${segmentIndex}` });
  }

  const key = `meetings/${sessionId}/transcript-${String(segmentIndex).padStart(2, '0')}.txt`;
  await put(key, transcript, {
    access: 'public',
    contentType: 'text/plain; charset=utf-8',
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  return jsonResponse(res, 200, {
    ok: true,
    segmentIndex,
    transcriptLength: transcript.length,
  });
}

// ------- segment 단계 3: transcript-NN.txt 전체 결합 → transcript.txt -------

async function handleMergeTranscripts(req, res) {
  const body = await readJsonBody(req);
  const { sessionId, totalSegments } = body;

  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return jsonResponse(res, 400, { error: 'Invalid session id' });
  }

  const prefix = `meetings/${sessionId}/transcript-`;
  const { blobs } = await list({ prefix });
  const segmentBlobs = blobs
    .filter((b) => /\/transcript-\d{2}\.txt$/.test(b.pathname))
    .sort((a, b) => a.pathname.localeCompare(b.pathname));

  if (!segmentBlobs.length) {
    return jsonResponse(res, 400, { error: 'No segment transcripts found' });
  }
  if (totalSegments && segmentBlobs.length !== totalSegments) {
    return jsonResponse(res, 400, {
      error: `Segment count mismatch: expected ${totalSegments}, got ${segmentBlobs.length}`,
    });
  }

  const SEGMENT_MINUTES = 5;
  const parts = await Promise.all(
    segmentBlobs.map(async (b, i) => {
      const r = await fetch(b.url);
      const text = (await r.text()).trim();
      const startMin = i * SEGMENT_MINUTES;
      const endMin = startMin + SEGMENT_MINUTES;
      return `--- [${startMin}:00 ~ ${endMin}:00] ---\n${text}`;
    })
  );
  const merged = parts.join('\n\n');

  await put(`meetings/${sessionId}/transcript.txt`, merged, {
    access: 'public',
    contentType: 'text/plain; charset=utf-8',
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  return jsonResponse(res, 200, {
    ok: true,
    segmentCount: segmentBlobs.length,
    transcriptLength: merged.length,
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
  const transcriptKey = `meetings/${sessionId}/transcript.txt`;
  const { blobs } = await list({ prefix: transcriptKey });
  const transcriptBlob = blobs.find((b) => b.pathname === transcriptKey);
  if (!transcriptBlob) {
    return jsonResponse(res, 400, { error: 'No transcript found — run transcribe first' });
  }

  const transcriptRes = await fetch(transcriptBlob.url);
  const transcript = await transcriptRes.text();

  if (!transcript.trim()) {
    return jsonResponse(res, 400, { error: 'Empty transcript' });
  }

  // Notion 용어집 조회
  const glossaryText = await fetchGlossary();

  const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const today = new Date().toISOString().slice(0, 10);
  const meetingMeta = {
    requestedTitle: title,
    requestedMeetingType: meetingType,
    durationSec,
    date: today,
  };

  const promptText = `당신은 게임 기획 회의록 정리 전문가입니다. 아래 한국어 회의 전사문을 바탕으로 회의록을 작성하세요.

[메타 정보]
${JSON.stringify(meetingMeta, null, 2)}
${glossaryText}
[전사문]
${transcript}

[작성 규칙]
1. 모든 응답은 한국어로 작성
2. 발언자 구분은 하지 않고 내용 중심으로 정리
3. 게임 기획 관련 회의일 가능성이 높음 (전투, 시스템, 밸런스, UI 등의 용어 자주 등장)
4. 위 용어집에 있는 단어가 전사문에 있으면 반드시 해당 표기를 사용할 것
5. requestedTitle이 있으면 그것을 title로 사용. 없으면 전사문을 요약한 30자 이내 제목 생성
6. requestedMeetingType이 있으면 그것을 meetingType으로 사용. 없으면 내용에 맞게 선택
7. labels는 회의에서 다룬 주제에 해당하는 것만 (없으면 빈 배열)
8. agenda: 회의 시작 시 명시적으로 다룬 안건. 없으면 빈 배열
9. discussion: 실제 오간 논의 (가장 중요)
10. decisions: 명확히 합의/결정된 사항만
11. todos: 누가 무엇을 언제까지 할지 명시된 액션 아이템`;

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

  // 결과 JSON을 Blob에 저장 (다음 단계 finalize-notion에서 읽음)
  const payload = { meetingData, date: today };
  await put(`meetings/${sessionId}/result.json`, JSON.stringify(payload), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
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
  const resultKey = `meetings/${sessionId}/result.json`;
  const { blobs } = await list({ prefix: resultKey });
  const resultBlob = blobs.find((b) => b.pathname === resultKey);
  if (!resultBlob) {
    return jsonResponse(res, 400, { error: 'No summary result found — run summarize first' });
  }

  const r = await fetch(resultBlob.url);
  const { meetingData, date } = await r.json();

  // Notion 페이지 생성
  const notionUrl = await createNotionPage(meetingData, date);

  // 청크 + 전사 + 결과 파일 모두 정리 (Gemini 파일은 48시간 후 자동 삭제됨)
  await cleanupChunks(prefix);

  return jsonResponse(res, 200, {
    ok: true,
    title: meetingData.title,
    notionUrl,
  });
}

// ------- Gemini 응답 스키마 -------

function meetingSchema() {
  return {
    type: 'object',
    properties: {
      title: { type: 'string', description: '회의 제목 (30자 이내)' },
      topic: { type: 'string', description: '회의 주제 한 문장' },
      meetingType: {
        type: 'string',
        enum: ['킥오프', '내부 논의', '실무 논의', '기타'],
      },
      labels: {
        type: 'array',
        items: { type: 'string', enum: ['전투', '시스템', '밸런스', 'UI'] },
      },
      agenda: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            items: { type: 'array', items: { type: 'string' } },
          },
          required: ['title', 'items'],
        },
      },
      discussion: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            topic: { type: 'string' },
            points: { type: 'array', items: { type: 'string' } },
          },
          required: ['topic', 'points'],
        },
      },
      decisions: { type: 'array', items: { type: 'string' } },
      todos: { type: 'array', items: { type: 'string' } },
    },
    required: ['title', 'topic', 'meetingType', 'labels', 'agenda', 'discussion', 'decisions', 'todos'],
  };
}

// ------- Notion 페이지 생성 -------

async function createNotionPage(data, dateStr) {
  const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
  const databaseId = process.env.NOTION_DATABASE_ID;

  const properties = {
    '이름': { title: [{ text: { content: data.title } }] },
    '회의 날짜': { date: { start: dateStr } },
    '회의 유형': { select: { name: data.meetingType } },
  };
  if (data.labels?.length) {
    properties['레이블'] = { multi_select: data.labels.map((name) => ({ name })) };
  }

  const children = buildBlocks(data);

  const page = await notion.pages.create({
    parent: { database_id: databaseId },
    properties,
    children,
  });

  return page.url;
}

// 회의록 서식 구조에 맞춰 Notion 블록 구성
function buildBlocks(data) {
  const text = (s) => [{ type: 'text', text: { content: s } }];
  const bold = (s) => [{ type: 'text', text: { content: s }, annotations: { bold: true } }];

  const bullets = (items) =>
    items.map((s) => ({
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: text(s) },
    }));

  const blocks = [];

  // 컬럼 레이아웃 (기본 정보 / 후속 진행 업무)
  blocks.push({
    object: 'block',
    type: 'column_list',
    column_list: {
      children: [
        {
          object: 'block',
          type: 'column',
          column: {
            children: [
              {
                object: 'block',
                type: 'callout',
                callout: {
                  icon: { type: 'emoji', emoji: '✅' },
                  color: 'blue_background',
                  rich_text: bold('기본 정보'),
                  children: [
                    {
                      object: 'block',
                      type: 'bulleted_list_item',
                      bulleted_list_item: {
                        rich_text: [
                          { type: 'text', text: { content: '회의 주제: ' }, annotations: { bold: true } },
                          { type: 'text', text: { content: data.topic || '' } },
                        ],
                      },
                    },
                    {
                      object: 'block',
                      type: 'bulleted_list_item',
                      bulleted_list_item: { rich_text: bold('회의 자료:') },
                    },
                    {
                      object: 'block',
                      type: 'bulleted_list_item',
                      bulleted_list_item: { rich_text: bold('관련 일감:') },
                    },
                  ],
                },
              },
            ],
          },
        },
        {
          object: 'block',
          type: 'column',
          column: {
            children: [
              {
                object: 'block',
                type: 'callout',
                callout: {
                  icon: { type: 'emoji', emoji: '🚩' },
                  color: 'blue_background',
                  rich_text: bold('후속 진행 업무'),
                  children: [
                    {
                      object: 'block',
                      type: 'bulleted_list_item',
                      bulleted_list_item: {
                        rich_text: [{ type: 'text', text: { content: 'Jira 일감 복사' }, annotations: { italic: true, color: 'yellow' } }],
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  });

  blocks.push({ object: 'block', type: 'divider', divider: {} });

  // 아젠다
  const agendaChildren = [];
  for (const a of data.agenda || []) {
    agendaChildren.push({
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: bold(a.title),
        children: bullets(a.items || []),
      },
    });
  }
  if (agendaChildren.length === 0) {
    agendaChildren.push({
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: text('(명시된 아젠다 없음)') },
    });
  }
  blocks.push({
    object: 'block',
    type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji: '📌' },
      color: 'blue_background',
      rich_text: bold('아젠다'),
      children: agendaChildren,
    },
  });

  // 논의 사항
  const discussionChildren = [];
  for (const d of data.discussion || []) {
    discussionChildren.push({
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: bold(d.topic),
        children: bullets(d.points || []),
      },
    });
  }
  blocks.push({
    object: 'block',
    type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji: '💬' },
      color: 'blue_background',
      rich_text: bold('논의 사항'),
      children: discussionChildren.length ? discussionChildren : [{
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: text('(논의 내용 없음)') },
      }],
    },
  });

  // 결정 사항
  blocks.push({
    object: 'block',
    type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji: '🎯' },
      color: 'blue_background',
      rich_text: bold('결정 사항'),
      children: (data.decisions || []).length
        ? bullets(data.decisions)
        : [{
            object: 'block',
            type: 'bulleted_list_item',
            bulleted_list_item: { rich_text: text('(결정된 사항 없음)') },
          }],
    },
  });

  // To-do
  blocks.push({
    object: 'block',
    type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji: '✅' },
      color: 'blue_background',
      rich_text: bold('To-do'),
      children: (data.todos || []).length
        ? data.todos.map((s) => ({
            object: 'block',
            type: 'to_do',
            to_do: { rich_text: text(s), checked: false },
          }))
        : [{
            object: 'block',
            type: 'to_do',
            to_do: { rich_text: text(''), checked: false },
          }],
    },
  });

  return blocks;
}

// ------- 용어집 조회 -------

async function fetchGlossary() {
  const glossaryDbId = process.env.NOTION_GLOSSARY_DB_ID;
  if (!glossaryDbId) return '';

  try {
    const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
    const response = await notion.databases.query({
      database_id: glossaryDbId,
      filter: {
        property: '활성',
        checkbox: { equals: true },
      },
      sorts: [{ property: '카테고리', direction: 'ascending' }],
    });

    if (!response.results.length) return '';

    const terms = response.results.map((page) => {
      const p = page.properties;
      const term = p['용어']?.title?.[0]?.plain_text || '';
      const desc = p['설명']?.rich_text?.[0]?.plain_text || '';
      const cat = p['카테고리']?.select?.name || '';
      return `- ${term}: ${desc}${cat ? ` [${cat}]` : ''}`;
    });

    return `\n[용어집 — 아래 용어가 음성에서 들리면 정확한 표기를 사용하세요]\n${terms.join('\n')}\n`;
  } catch (e) {
    console.warn('[fetchGlossary] failed:', e?.message);
    return '';
  }
}

// ------- 청크 정리 -------

async function cleanupChunks(prefix) {
  try {
    const { blobs } = await list({ prefix });
    if (blobs.length) {
      await del(blobs.map((b) => b.url));
    }
  } catch (e) {
    console.warn('[cleanup] failed:', e?.message);
  }
}
