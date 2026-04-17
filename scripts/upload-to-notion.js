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

import { Agent, setGlobalDispatcher } from 'undici';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createNotionClient } from '../lib/clients/notion.js';
import {
  uploadFileToNotion,
  buildTranscriptFilename,
} from '../lib/notion/file-upload.js';

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
  // 기존 로컬 경로는 Blob 본문에 charset 명시 없이 'text/plain' 만 사용 — 동작 보존.
  const fileUploadId = await uploadFileToNotion({
    body: fileBuffer,
    filename: safeFilename,
    contentType: 'text/plain',
    blobContentType: 'text/plain',
  });
  transcriptFileUpload = { id: fileUploadId, filename: safeFilename, charCount };
  console.log(`      Uploaded as "${safeFilename}" (id: ${fileUploadId}, ${charCount.toLocaleString()}자)`);
  console.log('');
}

// ------- Notion 페이지 생성 -------

console.log('Creating Notion page...');

const notion = await createNotionClient();
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

// ------- Notion 블록 빌더 (api/process-meeting.js와 동기화 필요) -------

// 항목 호환 헬퍼: 신 schema는 {text, sourceQuote}, 구 schema는 plain string
function itemText(x) { return typeof x === 'string' ? x : (x?.text || ''); }
function itemQuote(x) { return typeof x === 'string' ? '' : (x?.sourceQuote || ''); }

function buildBlocks(data, transcriptFileUpload = null) {
  const text = (s) => [{ type: 'text', text: { content: s } }];
  const bold = (s) => [{ type: 'text', text: { content: s }, annotations: { bold: true } }];

  const bullet = (richText, children) => {
    const b = {
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: richText },
    };
    if (children && children.length) b.bulleted_list_item.children = children;
    return b;
  };
  const bullets = (items) => items.map((s) => bullet(text(s)));

  const heading2 = (emoji, title) => ({
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: text(`${emoji} ${title}`) },
  });
  const heading3 = (content) => ({
    object: 'block',
    type: 'heading_3',
    heading_3: { rich_text: text(content) },
  });

  const blocks = [];

  // ===== 메타 영역: 2단 컬럼 × 연한 회색 콜아웃 =====
  // (템플릿성 수동 편집 영역 — 본문과 시각적으로 구분)
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
                  color: 'gray_background',
                  rich_text: bold('기본 정보'),
                  children: [
                    bullet([
                      { type: 'text', text: { content: '회의 주제: ' }, annotations: { bold: true } },
                      { type: 'text', text: { content: data.topic || '' } },
                    ]),
                    bullet(bold('회의 자료:')),
                    bullet(bold('관련 일감:')),
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
                  color: 'gray_background',
                  rich_text: bold('후속 진행 업무'),
                  children: [
                    bullet([{
                      type: 'text',
                      text: { content: 'Jira 일감 복사' },
                      annotations: { italic: true, color: 'yellow' },
                    }]),
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

  // ===== 본문: heading_2 섹션 × 4 (sourceQuote는 진단 토글에서만 노출) =====

  // 📌 아젠다
  blocks.push(heading2('📌', '아젠다'));
  if ((data.agenda || []).length === 0) {
    blocks.push(bullet(text('(명시된 아젠다 없음)')));
  } else {
    for (const a of data.agenda) {
      blocks.push(bullet(bold(a.title), bullets(a.items || [])));
    }
  }

  // 💬 논의 사항 — 토픽은 heading_3로 승격, 포인트는 평평한 bullets
  blocks.push(heading2('💬', '논의 사항'));
  if ((data.discussion || []).length === 0) {
    blocks.push(bullet(text('(논의 내용 없음)')));
  } else {
    for (const d of data.discussion) {
      blocks.push(heading3(d.topic));
      for (const p of d.points || []) {
        blocks.push(bullet(text(itemText(p))));
      }
    }
  }

  // 🎯 결정 사항
  blocks.push(heading2('🎯', '결정 사항'));
  if ((data.decisions || []).length === 0) {
    blocks.push(bullet(text('(결정된 사항 없음)')));
  } else {
    for (const d of data.decisions) {
      blocks.push(bullet(text(itemText(d))));
    }
  }

  // ✅ To-do
  blocks.push(heading2('✅', 'To-do'));
  const todoItems = (data.todos || []).length
    ? data.todos.map((t) => ({
        object: 'block',
        type: 'to_do',
        to_do: { rich_text: text(itemText(t)), checked: false },
      }))
    : [{
        object: 'block',
        type: 'to_do',
        to_do: { rich_text: text(''), checked: false },
      }];
  blocks.push(...todoItems);

  // ===== 진단 토글: 전사 원문 + 항목별 근거 인용 매핑 =====
  const evidenceChildren = buildEvidenceBlocks(data, transcriptFileUpload);
  if (evidenceChildren.length) {
    blocks.push({ object: 'block', type: 'divider', divider: {} });
    blocks.push({
      object: 'block',
      type: 'toggle',
      toggle: {
        rich_text: [{
          type: 'text',
          text: { content: '🔍 검토 자료 (전사 원문 + 항목별 근거 인용)' },
          annotations: { color: 'gray' },
        }],
        children: evidenceChildren,
      },
    });
  }

  return blocks;
}

// 진단 토글 안에 들어갈 블록들: 전사 파일 + 항목별 (text — 인용/⚠️ 근거 없음)
function buildEvidenceBlocks(data, transcriptFileUpload) {
  const text = (s) => [{ type: 'text', text: { content: s } }];
  const bold = (s) => [{ type: 'text', text: { content: s }, annotations: { bold: true } }];
  const heading3 = (content) => ({
    object: 'block', type: 'heading_3', heading_3: { rich_text: text(content) },
  });

  const evidenceBullet = (mainText, quote) => {
    const parts = [{ type: 'text', text: { content: mainText } }];
    if (quote && quote.trim()) {
      const truncated = quote.length > 100 ? quote.slice(0, 100) + '…' : quote;
      parts.push({
        type: 'text',
        text: { content: `  「${truncated}」` },
        annotations: { italic: true, color: 'gray' },
      });
    } else {
      parts.push({
        type: 'text',
        text: { content: '  ⚠️ 근거 없음 (환각/추정 의심)' },
        annotations: { italic: true, color: 'red' },
      });
    }
    return {
      object: 'block', type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: parts },
    };
  };

  const blocks = [];

  if (transcriptFileUpload) {
    blocks.push({
      object: 'block', type: 'file',
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

  if ((data.decisions || []).length) {
    blocks.push(heading3('🎯 결정 사항 — 근거 인용'));
    for (const d of data.decisions) {
      blocks.push(evidenceBullet(itemText(d), itemQuote(d)));
    }
  }

  if ((data.todos || []).length) {
    blocks.push(heading3('✅ To-do — 근거 인용'));
    for (const td of data.todos) {
      blocks.push(evidenceBullet(itemText(td), itemQuote(td)));
    }
  }

  if ((data.discussion || []).length) {
    blocks.push(heading3('💬 논의 사항 — 근거 인용'));
    for (const disc of data.discussion) {
      blocks.push({
        object: 'block', type: 'paragraph',
        paragraph: { rich_text: bold(disc.topic) },
      });
      for (const p of disc.points || []) {
        blocks.push(evidenceBullet(itemText(p), itemQuote(p)));
      }
    }
  }

  return blocks;
}
