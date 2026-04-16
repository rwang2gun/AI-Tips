// ============================================================
// 로컬에서 검수한 회의록 JSON을 Notion 페이지로 저장
// ============================================================
//
// [목적]
//   process-recording-locally.js가 생성한 result.json을 검수/편집한
//   뒤 Notion "자동 회의록 DB"에 페이지로 생성.
//
// [사용법]
//   node --env-file=.env scripts/upload-to-notion.js <result-json-path>
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
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

// ------- CLI 인자 -------

const resultPath = process.argv[2];

if (!resultPath) {
  console.error('Usage: node scripts/upload-to-notion.js <result-json-path>');
  process.exit(1);
}

if (!existsSync(resultPath)) {
  console.error(`ERROR: result json not found: ${resultPath}`);
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
console.log('');
console.log('Creating Notion page...');

// ------- Notion 페이지 생성 -------

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

const children = buildBlocks(meetingData);

const page = await notion.pages.create({
  parent: { database_id: databaseId },
  properties,
  children,
});

console.log('');
console.log(`Created: ${page.url}`);

// ------- Notion 블록 빌더 (api/process-meeting.js와 동기화 필요) -------

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
