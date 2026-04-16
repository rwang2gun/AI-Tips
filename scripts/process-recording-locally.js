// ============================================================
// 로컬에서 회의 녹음을 전사 + 요약 (Notion 저장은 별도 스크립트)
// ============================================================
//
// [목적]
//   Vercel 60초 한도 때문에 PWA에서 실패한 긴 회의를 로컬에서 직접
//   처리. 중간 산출물(transcript, result)을 파일로 남겨 사용자가
//   검수/편집한 뒤 Notion에 올릴 수 있게 한다.
//
// [사용법]
//   1) .env 또는 환경변수에 필요한 값 세팅:
//        GEMINI_API_KEY=...
//        NOTION_TOKEN=...              (용어집 조회용, 없어도 됨)
//        NOTION_GLOSSARY_DB_ID=...     (없으면 용어집 없이 요약)
//
//   2) 실행:
//        node --env-file=.env scripts/process-recording-locally.js <audio-file> [--title "..."] [--type "킥오프|내부 논의|실무 논의|기타"]
//
//      또는:
//        export GEMINI_API_KEY=... NOTION_TOKEN=... NOTION_GLOSSARY_DB_ID=...
//        node scripts/process-recording-locally.js <audio-file>
//
//   3) 출력:
//        <input>.transcript.txt   — 전사문 (검수/편집 가능)
//        <input>.result.json      — 구조화 요약 JSON (검수/편집 가능)
//
//   4) 검수 후 Notion 저장:
//        node --env-file=.env scripts/upload-to-notion.js <input>.result.json
//
// [재실행 동작]
//   - transcript.txt가 이미 있으면: 전사 건너뛰고 summarize만 실행
//   - result.json이 이미 있으면: summarize도 건너뜀
//   - 강제 재실행:
//        --force-retranscribe : 전사 다시
//        --force-resummarize  : 요약 다시
//
// [로컬 vs 서버 차이]
//   - 타임아웃 없음: Gemini가 몇 분 걸려도 OK
//   - API 직접 호출: Vercel 함수 경로 우회
//   - 산출물 검수 가능: 자동 Notion 저장 X (별도 upload-to-notion.js)
// ============================================================

import { GoogleGenAI, createUserContent, createPartFromUri } from '@google/genai';
import { Client as NotionClient } from '@notionhq/client';
import { Agent, setGlobalDispatcher } from 'undici';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// 긴 오디오 전사 시 Gemini 응답이 5분을 넘을 수 있어 undici 기본
// headersTimeout(5분)에 걸림. 로컬 CLI라 무제한으로 설정.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

// ------- CLI 인자 파싱 -------

const args = process.argv.slice(2);
const audioPath = args.find((a) => !a.startsWith('--'));
const flags = new Set(args.filter((a) => a.startsWith('--') && !a.includes('=')));
const kwargs = Object.fromEntries(
  args
    .filter((a) => a.startsWith('--') && a.includes('='))
    .map((a) => a.slice(2).split('=', 2))
);

if (!audioPath) {
  console.error('Usage: node scripts/process-recording-locally.js <audio-file> [--title="..."] [--type="..."] [--force-retranscribe] [--force-resummarize]');
  process.exit(1);
}

if (!existsSync(audioPath)) {
  console.error(`ERROR: audio file not found: ${audioPath}`);
  process.exit(1);
}

if (!process.env.GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY not set. Load .env with `node --env-file=.env ...` or export the var.');
  process.exit(1);
}

const requestedTitle = kwargs.title || null;
const requestedMeetingType = kwargs.type || null;

const baseOut = audioPath.replace(/\.[^.]+$/, ''); // 확장자 제거
const transcriptPath = `${baseOut}.transcript.txt`;
const resultPath = `${baseOut}.result.json`;

console.log(`Input:       ${audioPath}`);
console.log(`Transcript:  ${transcriptPath}`);
console.log(`Result JSON: ${resultPath}`);
if (requestedTitle) console.log(`Title:       ${requestedTitle}`);
if (requestedMeetingType) console.log(`Type:        ${requestedMeetingType}`);
console.log('');

// ------- MIME 타입 추정 -------

const mimeMap = {
  '.webm': 'audio/webm;codecs=opus',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.mp4': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
};
const ext = path.extname(audioPath).toLowerCase();
const mimeType = kwargs.mime || mimeMap[ext] || 'audio/webm';
console.log(`MIME type:   ${mimeType}`);

// ------- Gemini 클라이언트 -------

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ------- Step 1: 전사 -------

let transcript;
if (existsSync(transcriptPath) && !flags.has('--force-retranscribe')) {
  transcript = await fs.readFile(transcriptPath, 'utf-8');
  console.log(`\n[1/3] Skip transcribe — ${transcriptPath} already exists (${transcript.length} chars).`);
  console.log(`      Re-run with --force-retranscribe to redo.`);
} else {
  console.log('\n[1/3] Uploading audio to Gemini Files API...');
  const fileBuffer = await fs.readFile(audioPath);
  const audioBlob = new Blob([fileBuffer], { type: mimeType });

  const uploaded = await genAI.files.upload({
    file: audioBlob,
    config: { mimeType },
  });
  console.log(`      Uploaded as ${uploaded.name}, state: ${uploaded.state}`);

  // ACTIVE 대기
  let fileInfo = uploaded;
  while (fileInfo.state === 'PROCESSING') {
    process.stdout.write('      Waiting for ACTIVE...\r');
    await new Promise((r) => setTimeout(r, 2000));
    fileInfo = await genAI.files.get({ name: uploaded.name });
  }
  console.log(`      File state: ${fileInfo.state}                         `);

  if (fileInfo.state !== 'ACTIVE') {
    console.error(`ERROR: Gemini file failed to become ACTIVE (state: ${fileInfo.state})`);
    process.exit(1);
  }

  console.log('      Generating transcript (this can take several minutes for long audio)...');
  const transcribePrompt = `첨부된 한국어 회의 녹음을 정확히 전사하세요.

[규칙]
1. 들리는 내용을 누락 없이 옮겨 쓸 것
2. 발언자 구분은 하지 말고 발언 순서대로 작성
3. "음", "어" 같은 군더더기는 생략하되 실제 의미 있는 말은 모두 포함
4. 잘 안 들리는 구간은 [불분명] 으로 표시
5. 문장 단위로 줄바꿈하여 가독성 확보
6. 해설이나 요약 없이 들은 말만 옮겨 쓸 것`;

  const transcribeStart = Date.now();
  const transcribeResult = await genAI.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      createUserContent([
        transcribePrompt,
        createPartFromUri(fileInfo.uri, fileInfo.mimeType),
      ]),
    ],
    config: {
      // 60분 전사는 수만 토큰 나올 수 있어서 기본 8K 한도면 MAX_TOKENS로 잘림.
      maxOutputTokens: 65536,
      // Gemini 2.5 Flash는 기본으로 thinking 모드 ON. thinking이 출력 토큰을
      // 먹어치워 실제 전사 텍스트가 0 토큰으로 끝남 (finishReason=MAX_TOKENS).
      // 전사는 단순 작업이라 thinking 끄고 전체 토큰을 실제 출력에 할당.
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  const transcribeElapsed = ((Date.now() - transcribeStart) / 1000).toFixed(1);

  transcript = transcribeResult.text || '';
  if (!transcript.trim()) {
    console.error('ERROR: Empty transcript returned by Gemini.');
    console.error('');
    console.error('--- Diagnostic info ---');
    const cand = transcribeResult.candidates?.[0];
    console.error(`finishReason:       ${cand?.finishReason ?? '(unknown)'}`);
    console.error(`safetyRatings:      ${JSON.stringify(cand?.safetyRatings ?? [], null, 2)}`);
    console.error(`promptFeedback:     ${JSON.stringify(transcribeResult.promptFeedback ?? null, null, 2)}`);
    console.error(`usageMetadata:      ${JSON.stringify(transcribeResult.usageMetadata ?? null, null, 2)}`);
    console.error(`raw candidates[0]:  ${JSON.stringify(cand ?? null, null, 2)?.slice(0, 1500)}`);
    console.error('-----------------------');
    console.error('');
    console.error('가능한 원인:');
    console.error('  1. SAFETY — finishReason이 SAFETY면 안전필터 차단. 회의 내용에 민감 키워드 있음.');
    console.error('  2. MAX_TOKENS — 출력 토큰 한도 초과. 프롬프트에 maxOutputTokens 명시 필요.');
    console.error('  3. RECITATION — 저작권/학습 데이터 리사이테이션 차단.');
    console.error('  4. 파일 문제 — 오디오 디코딩 실패. 파일을 직접 재생해서 소리 나는지 확인.');
    console.error('');
    console.error('참고: recovered-*.webm을 Windows Media Player/VLC로 열어서 재생되는지 확인하세요.');
    process.exit(1);
  }

  await fs.writeFile(transcriptPath, transcript, 'utf-8');
  console.log(`      Saved ${transcript.length} chars to ${transcriptPath} (${transcribeElapsed}s)`);
}

// ------- Step 2: 요약 -------

let result;
if (existsSync(resultPath) && !flags.has('--force-resummarize')) {
  const raw = await fs.readFile(resultPath, 'utf-8');
  result = JSON.parse(raw);
  console.log(`\n[2/3] Skip summarize — ${resultPath} already exists.`);
  console.log(`      Re-run with --force-resummarize to redo.`);
} else {
  console.log('\n[2/3] Fetching glossary from Notion...');
  const glossaryText = await fetchGlossary();
  console.log(`      Glossary terms: ${glossaryText ? glossaryText.split('\n').filter((l) => l.startsWith('- ')).length : 0}`);

  console.log('      Generating structured summary...');
  const today = new Date().toISOString().slice(0, 10);
  const meetingMeta = {
    requestedTitle,
    requestedMeetingType,
    durationSec: null,
    date: today,
  };

  const summarizePrompt = `당신은 게임 기획 회의록 정리 전문가입니다. 아래 한국어 회의 전사문을 바탕으로 회의록을 작성하세요.

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

  const summarizeStart = Date.now();
  const summarizeResult = await genAI.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [createUserContent([summarizePrompt])],
    config: {
      responseMimeType: 'application/json',
      responseSchema: meetingSchema(),
      // 전사 단계와 동일한 이유로 토큰 한도 명시. 요약은 thinking을 켜두는
      // 게 구조화 품질에 도움됨 (긴 회의 요약이라 생각 단계가 유용).
      maxOutputTokens: 65536,
    },
  });
  const summarizeElapsed = ((Date.now() - summarizeStart) / 1000).toFixed(1);

  const meetingData = JSON.parse(summarizeResult.text);
  result = { meetingData, date: today };

  await fs.writeFile(resultPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`      Saved summary to ${resultPath} (${summarizeElapsed}s)`);
}

// ------- Step 3: 결과 요약 출력 -------

const { meetingData } = result;
console.log('\n[3/3] Summary preview:');
console.log(`      Title:        ${meetingData.title}`);
console.log(`      Topic:        ${meetingData.topic}`);
console.log(`      Meeting type: ${meetingData.meetingType}`);
console.log(`      Labels:       ${meetingData.labels.length ? meetingData.labels.join(', ') : '(없음)'}`);
console.log(`      Agenda:       ${meetingData.agenda.length} 항목`);
console.log(`      Discussion:   ${meetingData.discussion.length} 주제`);
console.log(`      Decisions:    ${meetingData.decisions.length} 개`);
console.log(`      Todos:        ${meetingData.todos.length} 개`);

console.log(`\nReview the files and edit if needed:`);
console.log(`   - ${transcriptPath}`);
console.log(`   - ${resultPath}`);
console.log(`\nWhen satisfied, create the Notion page:`);
console.log(`   node --env-file=.env scripts/upload-to-notion.js "${resultPath}"`);

// ------- Helpers -------

async function fetchGlossary() {
  const glossaryDbId = process.env.NOTION_GLOSSARY_DB_ID;
  if (!glossaryDbId || !process.env.NOTION_TOKEN) return '';

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

    return `\n[용어집 — 아래 용어가 전사문에 있으면 정확한 표기를 사용하세요]\n${terms.join('\n')}\n`;
  } catch (e) {
    console.warn(`      [fetchGlossary] failed: ${e?.message}`);
    return '';
  }
}

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
