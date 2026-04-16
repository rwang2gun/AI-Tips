// 회의록 자동 생성 — 서버리스 함수
// 두 가지 액션:
//   X-Action: upload-chunk → 오디오 청크를 Vercel Blob에 임시 저장
//   X-Action: process      → 모든 청크를 결합 → Gemini로 전사/요약 → Notion 페이지 생성

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
    if (action === 'process') {
      return await handleProcess(req, res);
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

  if (!sessionId || chunkIndex == null || !totalChunks) {
    return jsonResponse(res, 400, { error: 'Missing session/chunk headers' });
  }

  // sessionId 화이트리스트 — UUID v4 형식만 허용 (path traversal 방지)
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return jsonResponse(res, 400, { error: 'Invalid session id' });
  }

  const buffer = await readRawBody(req);
  const key = `meetings/${sessionId}/chunk-${String(chunkIndex).padStart(4, '0')}.bin`;

  await put(key, buffer, {
    access: 'public', // Vercel Blob 정책상 필요. 키가 추측 불가능한 UUID라 사실상 비공개
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  return jsonResponse(res, 200, { ok: true, chunkIndex: Number(chunkIndex) });
}

// ------- 전사 + 요약 + Notion 생성 -------

async function handleProcess(req, res) {
  const body = await readJsonBody(req);
  const { sessionId, title, meetingType, mimeType, durationSec } = body;

  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return jsonResponse(res, 400, { error: 'Invalid session id' });
  }

  // 1. Vercel Blob에서 모든 청크 가져와 결합
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

  // 2. Gemini Files API에 업로드
  const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const audioBlob = new Blob([audioBuffer], { type: mimeType || 'audio/webm' });

  let uploaded = await genAI.files.upload({
    file: audioBlob,
    config: { mimeType: mimeType || 'audio/webm' },
  });

  // 처리 완료까지 폴링
  let fileInfo = uploaded;
  const maxWait = 50; // 최대 50초 대기
  for (let i = 0; i < maxWait && fileInfo.state === 'PROCESSING'; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    fileInfo = await genAI.files.get({ name: uploaded.name });
  }

  if (fileInfo.state !== 'ACTIVE') {
    await cleanupChunks(prefix);
    return jsonResponse(res, 500, { error: `Gemini file state: ${fileInfo.state}` });
  }

  // 3. Notion 용어집 조회
  const glossaryText = await fetchGlossary();

  // 4. Gemini 호출 — 구조화된 JSON으로 회의록 추출
  const today = new Date().toISOString().slice(0, 10);
  const meetingMeta = {
    requestedTitle: title,
    requestedMeetingType: meetingType,
    durationSec,
    date: today,
  };

  const promptText = `당신은 게임 기획 회의록 정리 전문가입니다. 첨부된 한국어 회의 녹음을 듣고 회의록을 작성하세요.

[메타 정보]
${JSON.stringify(meetingMeta, null, 2)}
${glossaryText}
[작성 규칙]
1. 모든 응답은 한국어로 작성
2. 발언자 구분은 하지 않고 내용 중심으로 정리
3. 게임 기획 관련 회의일 가능성이 높음 (전투, 시스템, 밸런스, UI 등의 용어 자주 등장)
4. 위 용어집에 있는 단어가 음성에서 들리면 반드시 해당 표기를 사용할 것
5. requestedTitle이 있으면 그것을 title로 사용. 없으면 회의 내용을 요약한 30자 이내 제목 생성
6. requestedMeetingType이 있으면 그것을 meetingType으로 사용. 없으면 내용에 맞게 선택
7. labels는 회의에서 다룬 주제에 해당하는 것만 (없으면 빈 배열)
8. agenda: 회의 시작 시 명시적으로 다룬 안건. 없으면 빈 배열
9. discussion: 실제 오간 논의 (가장 중요)
10. decisions: 명확히 합의/결정된 사항만
11. todos: 누가 무엇을 언제까지 할지 명시된 액션 아이템`;

  const result = await genAI.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      createUserContent([
        promptText,
        createPartFromUri(fileInfo.uri, fileInfo.mimeType),
      ]),
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: meetingSchema(),
    },
  });

  const meetingData = JSON.parse(result.text);

  // 5. Notion 페이지 생성
  const notionUrl = await createNotionPage(meetingData, today);

  // 6. 청크 정리 (Gemini 파일은 48시간 후 자동 삭제됨)
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
