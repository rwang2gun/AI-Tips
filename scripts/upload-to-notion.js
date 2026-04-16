// ============================================================
// 로컬에서 검수한 회의록 JSON을 Notion 페이지로 저장
// ============================================================
//
// [목적]
//   process-recording-locally.js가 생성한 result.json을 검수/편집한
//   뒤 Notion "자동 회의록 DB"에 페이지로 생성.
//
// [사용법]
//   node --env-file=.env scripts/upload-to-notion.js <result-json-path> [--transcript=<path>]
//
//   --transcript: 전사 원문 txt 파일 경로. 지정하면 페이지 하단에 file block으로
//                 첨부되며, Notion UI에서 📎 "전사원문_{date}_{title}.txt" 형태로 보임.
//                 생략 시 첨부 없이 요약만 업로드.
//
// [환경변수]
//   NOTION_TOKEN         — Notion Integration 토큰
//   NOTION_DATABASE_ID   — 자동 회의록 DB ID
//
// [result.json 포맷]
//   {
//     "meetingData": { title, topic, meetingType, labels, agenda, discussion, decisions, todos },
//     "date": "YYYY-MM-DD"
//   }
//
//   meetingData 스키마는 api/process-meeting.js의 meetingSchema() 참고.
//   수동 편집 시 required 필드(title, topic, meetingType, labels, agenda,
//   discussion, decisions, todos)를 유지해야 함.
// ============================================================

import { Client as NotionClient } from '@notionhq/client';
import { Agent, setGlobalDispatcher } from 'undici';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Notion File Upload API 사용 시 헤더 버전
const NOTION_VERSION = '2022-06-28';

// process-recording-locally.js와 동일하게 undici 타임아웃 제거.
// Notion children 많을 때 응답이 느려질 수 있어 안전하게 무제한.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

// ------- CLI 인자 -------

const args = process.argv.slice(2);
const resultPath = args.find((a) => !a.startsWith('--'));
const kwargs = Object.fromEntries(
  args
    .filter((a) => a.startsWith('--') && a.includes('='))
    .map((a) => a.slice(2).split('=', 2))
);

if (!resultPath) {
  console.error('Usage: node scripts/upload-to-notion.js <result-json-path> [--transcript=<path>]');
  process.exit(1);
}

if (!existsSync(resultPath)) {
  console.error(`ERROR: result json not found: ${resultPath}`);
  process.exit(1);
}

const transcriptPath = kwargs.transcript || null;
if (transcriptPath && !existsSync(transcriptPath)) {
  console.error(`ERROR: transcript file not found: ${transcriptPath}`);
  process.exit(1);
}

if (!process.env.NOTION_TOKEN) {
  console.error('ERROR: NOTION_TOKEN not set.');
  process.exit(1);
}

if (!process.env.NOTION_DATABASE_ID) {
  console.error('ERROR: NOTION_DATABASE_ID not set.');
  process.exit(1);
}

// ------- JSON 로드 + 검증 -------

const raw = await fs.readFile(resultPath, 'utf-8');
const payload = JSON.parse(raw);
const { meetingData, date } = payload;

const requiredFields = ['title', 'topic', 'meetingType', 'labels', 'agenda', 'discussion', 'decisions', 'todos'];
for (const f of requiredFields) {
  if (meetingData[f] == null) {
    console.error(`ERROR: meetingData.${f} is missing in ${resultPath}`);
    process.exit(1);
  }
}
if (!date) {
  console.error(`ERROR: date is missing in ${resultPath}`);
  process.exit(1);
}

console.log(`Meeting:      ${meetingData.title}`);
console.log(`Type:         ${meetingData.meetingType}`);
console.log(`Date:         ${date}`);
console.log(`Labels:       ${meetingData.labels.join(', ') || '(none)'}`);
console.log(`Agenda:       ${meetingData.agenda.length} items`);
console.log(`Discussion:   ${meetingData.discussion.length} topics`);
console.log(`Decisions:    ${meetingData.decisions.length}`);
console.log(`Todos:        ${meetingData.todos.length}`);
if (transcriptPath) {
  const transcriptPreview = await fs.readFile(transcriptPath, 'utf-8');
  console.log(`Transcript:   ${transcriptPath} (${transcriptPreview.length.toLocaleString()}자)`);
}
console.log('');

// ------- 전사 원문 업로드 (있으면) -------

let transcriptFileUpload = null; // { id, filename, charCount }
if (transcriptPath) {
  console.log('Uploading transcript to Notion...');
  const safeFilename = buildTranscriptFilename(meetingData.title, date);
  const fileBuffer = await fs.readFile(transcriptPath);
  const charCount = (await fs.readFile(transcriptPath, 'utf-8')).length;
  const fileUploadId = await uploadFileToNotion(fileBuffer, safeFilename);
  transcriptFileUpload = { id: fileUploadId, filename: safeFilename, charCount };
  console.log(`      Uploaded as "${safeFilename}" (id: ${fileUploadId}, ${charCount.toLocaleString()}자)`);
  console.log('');
}

// ------- Notion 페이지 생성 -------

console.log('Creating Notion page...');

const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
const databaseId = process.env.NOTION_DATABASE_ID;

const properties = {
  '이름': { title: [{ text: { content: meetingData.title } }] },
  '회의 날짜': { date: { start: date } },
  '회의 유형': { select: { name: meetingData.meetingType } },
};
if (meetingData.labels?.length) {
  properties['레이블'] = { multi_select: meetingData.labels.map((name) => ({ name })) };
}

const children = buildBlocks(meetingData, transcriptFileUpload);

const page = await notion.pages.create({
  parent: { database_id: databaseId },
  properties,
  children,
});

console.log('');
console.log(`Created: ${page.url}`);

// ------- 전사 원문 파일명 생성 -------
// 형식: 전사원문_{YYYY-MM-DD}_{safeTitle}.txt
// 제목에서 OS 금지 문자 제거 + 공백을 _ 로 치환, 한글은 그대로 허용
function buildTranscriptFilename(title, date) {
  const safe = (title || 'untitled')
    .replace(/[\\/:*?"<>|]/g, '') // Windows/Mac/Linux 공통 금지 문자
    .replace(/\s+/g, '_')
    .slice(0, 80); // 너무 긴 제목 방어
  return `전사원문_${date}_${safe}.txt`;
}

// ------- Notion File Upload API (3단계 중 create+send만 수행, attach는 block에서) -------
// Notion SDK 2.3.0은 file_upload를 감싸지 않으므로 fetch로 직접 호출.
// 검증: scripts/test-notion-file-upload.js
async function uploadFileToNotion(fileBuffer, filename) {
  const token = process.env.NOTION_TOKEN;

  // Step 1: create
  const createResp = await fetch('https://api.notion.com/v1/file_uploads', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      mode: 'single_part',
      filename,
      content_type: 'text/plain',
    }),
  });
  if (!createResp.ok) {
    const errText = await createResp.text();
    throw new Error(`Notion file_upload create failed (HTTP ${createResp.status}): ${errText.slice(0, 300)}`);
  }
  const createData = await createResp.json();

  // Step 2: send (multipart)
  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: 'text/plain' }), filename);

  const sendUrl = createData.upload_url || `https://api.notion.com/v1/file_uploads/${createData.id}/send`;
  const sendResp = await fetch(sendUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      // Content-Type은 FormData가 boundary 포함해서 자동 설정
    },
    body: form,
  });
  if (!sendResp.ok) {
    const errText = await sendResp.text();
    throw new Error(`Notion file_upload send failed (HTTP ${sendResp.status}): ${errText.slice(0, 300)}`);
  }

  return createData.id;
}

// ------- Notion 블록 빌더 (api/process-meeting.js와 동기화 필요) -------

function buildBlocks(data, transcriptFileUpload = null) {
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

  // 전사 원문 파일 (있을 때만 페이지 하단에 file block 추가)
  if (transcriptFileUpload) {
    blocks.push({ object: 'block', type: 'divider', divider: {} });
    blocks.push({
      object: 'block',
      type: 'file',
      file: {
        type: 'file_upload',
        file_upload: { id: transcriptFileUpload.id },
        caption: [{
          type: 'text',
          text: { content: `회의 전사 원문 (${transcriptFileUpload.charCount.toLocaleString()}자)` },
        }],
      },
    });
  }

  return blocks;
}
