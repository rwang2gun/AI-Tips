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
import { buildMeetingPageBlocks } from '../lib/notion/page-builder.js';

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

const children = buildMeetingPageBlocks(meetingData, transcriptFileUpload);

const page = await notion.pages.create({
  parent: { database_id: databaseId },
  properties,
  children,
});

console.log('');
console.log(`Created: ${page.url}`);
