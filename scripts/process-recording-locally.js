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
//        node --env-file=.env scripts/process-recording-locally.js <audio-file> [--title "..."] [--type "킥오프|내부 논의|실무 논의|기타"] [--summarize-model=gemini-2.5-pro] [--transcribe-only]
//
//      --transcribe-only: 전사만 하고 요약 단계 스킵 (세그먼트별 순차 전사용)
//
//   [모델 전략]
//     - 전사 (Step 1): gemini-2.5-flash (저렴 + 단순 작업에 충분)
//     - 요약 (Step 2): gemini-2.5-pro (긴 입력 + structured output에서
//       Flash는 503 UNAVAILABLE 지속 반환하므로 Pro 기본값)
//     - --summarize-model=gemini-2.5-flash 로 요약도 Flash 강제 가능
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

// 503 (high demand), 429 (rate limit), 500 (internal) 대상 지수 백오프 재시도.
// 2s → 4s → 8s → 16s → 32s 대기, 최대 5회 재시도.
async function withRetry(label, fn, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.status ?? err?.response?.status ?? null;
      const msg = err?.message || String(err);
      const isRetryable = status === 503 || status === 429 || status === 500 ||
        /503|UNAVAILABLE|high demand|RESOURCE_EXHAUSTED|overloaded/i.test(msg);
      if (attempt === maxRetries || !isRetryable) {
        throw err;
      }
      const waitSec = Math.min(2 ** (attempt + 1), 32);
      console.error(`      [${label}] attempt ${attempt + 1}/${maxRetries + 1} failed (${status || 'network'}: ${msg.slice(0, 80)})`);
      console.error(`      Retrying in ${waitSec}s...`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
    }
  }
}

// ------- 유의어 사전 로드 (전사/요약 양쪽에서 사용) -------
// 한 번만 fetch해서 두 단계 모두에 주입. 실패해도 전사/요약은 계속 진행.
const synonyms = await fetchSynonyms();
if (synonyms.length) {
  const strict = synonyms.filter((s) => s.strategy === '무조건 치환').length;
  const conditional = synonyms.filter((s) => s.strategy === '맥락 조건부').length;
  const manual = synonyms.filter((s) => s.strategy === '수동 확인').length;
  console.log(`유의어 사전: 총 ${synonyms.length}개 (무조건=${strict}, 조건부=${conditional}, 수동=${manual})`);
}

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
  const synonymHint = buildTranscribeSynonymHint(synonyms);
  const transcribePrompt = `첨부된 한국어 회의 녹음을 정확히 전사하세요.

[규칙]
1. 들리는 내용을 누락 없이 옮겨 쓸 것
2. 발언자 구분은 하지 말고 발언 순서대로 작성
3. "음", "어" 같은 군더더기는 생략하되 실제 의미 있는 말은 모두 포함
4. 잘 안 들리는 구간은 [불분명] 으로 표시
5. **한 문장이 끝날 때마다 반드시 줄바꿈**. 마침표(.)·물음표(?)·느낌표(!)·말줄임표(…) 바로 뒤에서 개행(\\n)할 것
6. 한 줄이 100자를 넘지 않도록 유지
7. 해설이나 요약 없이 들은 말만 옮겨 쓸 것${synonymHint}`;

  const transcribeStart = Date.now();
  const transcribeResult = await withRetry('transcribe', () => genAI.models.generateContent({
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
  }));
  const transcribeElapsed = ((Date.now() - transcribeStart) / 1000).toFixed(1);

  transcript = transcribeResult.text || '';
  // 후처리: Gemini가 줄바꿈 규칙을 무시하고 한 문장으로 붙여서 반환하는 경우
  // 문장 끝 부호 뒤에서 강제로 개행 (숫자 목록 "1." "2." 오인 방지 위해 뒤에 한글/영문 올 때만)
  if (transcript.trim()) {
    transcript = enforceSentenceBreaks(transcript);
    // 유의어 사전의 "무조건 치환" 항목을 후처리로 교정 (오인식 → 정답 용어)
    const { text: corrected, applied } = applySynonymReplacements(transcript, synonyms);
    transcript = corrected;
    if (applied.length) {
      console.log(`      유의어 교정 ${applied.length}건: ${applied.slice(0, 5).map((a) => `${a.from}→${a.to}(${a.count})`).join(', ')}${applied.length > 5 ? ', ...' : ''}`);
    }
  }
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

// --transcribe-only 플래그가 있으면 전사만 하고 종료 (세그먼트 분할 워크플로우용)
if (flags.has('--transcribe-only')) {
  console.log(`\n[done] Transcribe-only mode. Skipping summarize.`);
  console.log(`       Transcript saved to: ${transcriptPath}`);
  process.exit(0);
}

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

  const guideText = await fetchGuide();
  console.log(`      Guide loaded: ${guideText ? `${guideText.length} chars` : 'none'}`);

  console.log('      Generating structured summary...');
  const today = new Date().toISOString().slice(0, 10);
  const meetingMeta = {
    requestedTitle,
    requestedMeetingType,
    durationSec: null,
    date: today,
  };

  const summarizeSynonymHint = buildSummarizeSynonymHint(synonyms);
  const summarizePrompt = `당신은 게임 기획 회의록 정리 전문가입니다. 아래 한국어 회의 전사문을 바탕으로 회의록을 작성하세요.

[메타 정보]
${JSON.stringify(meetingMeta, null, 2)}
${glossaryText}${summarizeSynonymHint}${guideText}
[전사문]
${transcript}

[작성 규칙]
0. 위 [회의록 작성 가이드] 섹션이 있으면 이 규칙보다 우선합니다.
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
11. todos: 누가 무엇을 언제까지 할지 명시된 액션 아이템
12. **항목별 근거 인용 (sourceQuote)** — 사후 검토용 근거 자료, 본문에는 표시되지 않음
   - discussion.points / decisions / todos 각 항목에 sourceQuote 필드 작성
   - 인용은 전사문에서 그대로 가져온 10~80자 짧은 발췌 (변형/요약 금지)
   - 한 항목 본문이 여러 발언에 기반하면 가장 결정적인 한 문장 선택
   - 명시적 발언 없이 추정/유추로 작성한 항목은 sourceQuote를 빈 문자열로
     (환각 시그널이므로 정직하게 빈 문자열을 두는 것이 중요)`;

  // 요약은 gemini-2.5-pro 기본. Flash는 "긴 입력(100K+ chars) + structured
  // output" 조합에서 지속적 503 UNAVAILABLE 반환 (6회 지수백오프 재시도로도
  // 해결 안 됨). Pro는 별도 용량 풀이라 안정적 + 한국어 구조화 품질 우수.
  // 비용: Flash 대비 약 22배지만 절대금액 건당 100~150원 수준.
  // 전사는 Flash 유지 — 단순 작업이라 Flash로 충분.
  // --summarize-model 플래그로 오버라이드 가능 (예: 'gemini-2.5-flash').
  const summarizeModel = kwargs['summarize-model'] || 'gemini-2.5-pro';
  console.log(`      Model: ${summarizeModel}`);
  const summarizeStart = Date.now();
  const summarizeResult = await withRetry('summarize', () => genAI.models.generateContent({
    model: summarizeModel,
    contents: [createUserContent([summarizePrompt])],
    config: {
      responseMimeType: 'application/json',
      responseSchema: meetingSchema(),
      maxOutputTokens: 65536,
    },
  }));
  const summarizeElapsed = ((Date.now() - summarizeStart) / 1000).toFixed(1);

  const meetingData = JSON.parse(summarizeResult.text);

  // 1차 topic이 50자 초과면 Pro로 한 번 더 압축. 작은 입력만 보내서 빠르고
  // 503 위험 적음. 실패 시 1차 topic 그대로 유지 (요약 자체는 이미 성공).
  if (meetingData.topic && meetingData.topic.length > 50) {
    const before = meetingData.topic;
    console.log(`      Topic 50자 초과 (${before.length}자) — Pro로 재압축 시도...`);
    try {
      const refined = await withRetry('refine-topic', () => refineTopic(meetingData));
      if (refined && refined.length > 0 && refined.length < before.length) {
        meetingData.topic = refined;
        console.log(`      Topic 재압축: ${before.length}자 → ${refined.length}자`);
        console.log(`        before: ${before}`);
        console.log(`        after:  ${refined}`);
      } else {
        console.log(`      Topic 재압축 결과가 더 짧지 않아 1차 결과 유지 (refined=${refined?.length ?? 0}자).`);
      }
    } catch (e) {
      console.warn(`      [refine-topic] failed (1차 topic 유지): ${e?.message}`);
    }
  }

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

// 1차 요약 결과에서 topic만 Pro로 한 번 더 압축. 입력이 매우 작아 빠르고 안정.
// 입력: title + 1차 topic + agenda 제목들 (회의 본질 파악에 충분한 메타)
// 출력: 50자 이내 한 줄 (Pro가 살짝 넘기는 경우 그대로 채택, 후처리에서 wrapper만 제거)
async function refineTopic(meetingData) {
  const agendaTitles = (meetingData.agenda || [])
    .map((a) => `- ${a.title}`)
    .filter((s) => s.length > 2)
    .join('\n');

  const prompt = `다음은 게임 기획 회의의 1차 요약 결과입니다. topic 필드가 길어서 한 줄로 다시 압축이 필요합니다.

[제목]
${meetingData.title || '(없음)'}

[현재 topic — ${meetingData.topic.length}자]
${meetingData.topic}

${agendaTitles ? `[아젠다 제목들]\n${agendaTitles}\n` : ''}
요구사항:
- 50자 이내 한 문장으로 회의의 본질적 주제만 표현
- 아젠다 항목을 나열하지 말 것 ("A, B, C 논의" 같은 형태 금지)
- 새로운 topic 한 줄만 출력. 따옴표/접두어/설명 없이 본문만.`;

  const result = await genAI.models.generateContent({
    model: 'gemini-2.5-pro',
    contents: [createUserContent([prompt])],
    config: { maxOutputTokens: 256 },
  });

  let text = (result.text || '').trim();
  // 가끔 모델이 따옴표/접두어 붙임 — 안전 장치
  text = text.split('\n')[0].trim();
  text = text.replace(/^["'`「『\[(](.*)["'`」』\])]$/s, '$1').trim();
  text = text.replace(/^[Tt]opic\s*[:：]\s*/, '').trim();
  return text;
}

// 유의어 사전 DB 조회 (Notion). 실패 시 빈 배열 반환.
// 반환 형태: [{ 정답용어, 오인식표현[], 치환전략, 카테고리, 맥락메모 }, ...]
async function fetchSynonyms() {
  const synonymDbId = process.env.NOTION_SYNONYM_DB_ID;
  if (!synonymDbId || !process.env.NOTION_TOKEN) return [];

  try {
    const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
    const response = await notion.databases.query({
      database_id: synonymDbId,
      filter: {
        property: '활성',
        checkbox: { equals: true },
      },
      page_size: 200,
    });

    const synonyms = response.results.map((page) => {
      const p = page.properties;
      const correct = p['정답 용어']?.title?.[0]?.plain_text?.trim() || '';
      const rawMisrec = p['오인식 표현']?.rich_text?.[0]?.plain_text || '';
      // 쉼표(또는 전각 쉼표) 구분, 공백 제거, 빈 항목 제외
      const misrecs = rawMisrec
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter((s) => s && s !== correct);
      const strategy = p['치환 전략']?.select?.name || '수동 확인';
      const category = p['카테고리']?.select?.name || '';
      const note = p['맥락 메모']?.rich_text?.[0]?.plain_text || '';
      return { correct, misrecs, strategy, category, note };
    }).filter((s) => s.correct && s.misrecs.length > 0);

    return synonyms;
  } catch (e) {
    console.warn(`      [fetchSynonyms] failed: ${e?.message}`);
    return [];
  }
}

// 전사 프롬프트에 주입할 유의어 힌트.
// 주의: 오인식 표현 예시를 프롬프트에 넣으면 프라이밍 효과로 Gemini가 그 표기를 따라 쓰는 역효과 발생.
// 따라서 "정답 용어"만 간단히 나열하고, 오인식 → 정답 변환은 후처리 regex에만 맡김.
function buildTranscribeSynonymHint(synonyms) {
  const relevant = synonyms.filter((s) => s.strategy === '무조건 치환' || s.strategy === '맥락 조건부');
  if (!relevant.length) return '';
  const terms = relevant.map((s) => s.correct).join(', ');
  return `

[고유 용어]
이 회의에는 다음 용어가 자주 등장합니다. 비슷하게 들리는 단어는 이 표기로 통일하세요:
${terms}`;
}

// 요약 프롬프트에 주입할 유의어 힌트. 두 섹션으로 구성:
//
// 1. [전사 오류 보정 가이드] — 오인식 표현 → 정답 용어 매핑 전체
//    전사 후처리(regex)가 놓친 표현(맥락 조건부 / 미등록 변형)을 요약 단계
//    Gemini가 맥락 기반으로 복구할 수 있게 매핑 정보 제공.
//    주의: 전사 프롬프트에서는 프라이밍 역효과 때문에 오인식 예시 넣지 않지만,
//    요약은 기존 텍스트 해석이라 역효과 거의 없음.
//
// 2. [유의어 맥락 메모] — 사람/AI가 판단하는 데 도움되는 추가 설명.
//    (치환 전략이 "수동 확인"이어도 맥락 파악엔 필요하므로 포함)
function buildSummarizeSynonymHint(synonyms) {
  if (!synonyms.length) return '';

  // 1. 오인식 → 정답 매핑 (맥락 조건부는 자동 치환 안 됐을 가능성 있음)
  const mappingLines = synonyms
    .filter((s) => s.misrecs.length > 0 && s.strategy !== '수동 확인')
    .map((s) => {
      const variants = s.misrecs.map((v) => `"${v}"`).join(', ');
      const cat = s.category ? ` [${s.category}]` : '';
      return `- ${variants} → **${s.correct}**${cat}`;
    });

  // 2. 맥락 메모
  const noteLines = synonyms
    .filter((s) => s.note)
    .map((s) => `- ${s.correct}${s.category ? ` [${s.category}]` : ''}: ${s.note}`);

  const sections = [];
  if (mappingLines.length) {
    sections.push(`[전사 오류 보정 가이드 — 전사문에 아래 표기가 남아 있으면 괄호 안 정답 용어로 이해하고 요약에 반영]
${mappingLines.join('\n')}`);
  }
  if (noteLines.length) {
    sections.push(`[유의어 맥락 메모]
${noteLines.join('\n')}`);
  }
  if (!sections.length) return '';
  return `\n\n${sections.join('\n\n')}\n`;
}

// 유의어 사전의 "무조건 치환" 전략 항목으로 전사문을 교정.
// 한글 단어 경계 근사: 앞뒤가 한글이면 매칭 제외 (부분매칭 방지).
// 반환: { text: 교정된 전문, applied: [{ from, to, count }, ...] }
function applySynonymReplacements(text, synonyms) {
  const strictOnes = synonyms.filter((s) => s.strategy === '무조건 치환');
  const applied = [];
  let result = text;
  for (const syn of strictOnes) {
    for (const variant of syn.misrecs) {
      if (!variant || variant === syn.correct) continue;
      // 한글 양옆 경계 + escape된 변형 단어 매칭
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![가-힣A-Za-z])${escaped}(?![가-힣A-Za-z])`, 'g');
      const matches = result.match(re);
      if (matches?.length) {
        result = result.replace(re, syn.correct);
        applied.push({ from: variant, to: syn.correct, count: matches.length });
      }
    }
  }
  return { text: result, applied };
}

// Gemini가 줄바꿈 규칙을 무시하고 한 덩어리로 반환하는 케이스 방어.
// 문장 끝 부호(. ! ? …) + 선택적 닫는 따옴표/괄호 뒤에 공백이 오고,
// 그 다음 문자가 한글/영문일 때만 줄바꿈 삽입.
// 숫자 목록("1. ", "2. ")은 뒤에 숫자가 오지 않으니 자연스럽게 제외됨.
function enforceSentenceBreaks(text) {
  return text
    .split('\n')
    .map((line) => {
      // 한 줄이 짧으면 그대로 유지 (이미 제대로 줄바꿈된 것)
      if (line.length < 80) return line;
      return line.replace(/([.!?…]["'」』)\]]?)[ \t]+(?=[가-힣A-Za-z])/g, '$1\n');
    })
    .join('\n');
}

// 회의록 작성 가이드 페이지를 Notion에서 로드하여 평문으로 변환.
// 사용자가 Notion에서 페이지만 수정하면 다음 회의록부터 자동 반영됨.
// 실패 시 빈 문자열 반환 (요약 중단하지 않음).
async function fetchGuide() {
  const pageId = process.env.NOTION_GUIDE_PAGE_ID;
  if (!pageId || !process.env.NOTION_TOKEN) return '';

  try {
    const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
    const lines = await renderPageBlocks(notion, pageId);
    const body = lines.join('\n').trim();
    if (!body) return '';
    return `\n[회의록 작성 가이드]\n${body}\n`;
  } catch (e) {
    console.warn(`      [fetchGuide] failed: ${e?.message}`);
    return '';
  }
}

// Notion 페이지 children을 markdown-like 평문으로 렌더.
// 테이블은 파이프 구분 문자열로, 나머지 주요 블록 타입만 지원.
async function renderPageBlocks(notion, blockId) {
  const res = await notion.blocks.children.list({ block_id: blockId, page_size: 100 });
  const getText = (rt) => (rt || []).map((t) => t.plain_text).join('');
  const lines = [];

  for (const b of res.results) {
    switch (b.type) {
      case 'heading_1': lines.push(`# ${getText(b.heading_1.rich_text)}`); break;
      case 'heading_2': lines.push(`## ${getText(b.heading_2.rich_text)}`); break;
      case 'heading_3': lines.push(`### ${getText(b.heading_3.rich_text)}`); break;
      case 'paragraph': {
        const t = getText(b.paragraph.rich_text);
        lines.push(t); // 빈 줄도 유지 (섹션 간격)
        break;
      }
      case 'bulleted_list_item': lines.push(`- ${getText(b.bulleted_list_item.rich_text)}`); break;
      case 'numbered_list_item': lines.push(`1. ${getText(b.numbered_list_item.rich_text)}`); break;
      case 'quote': lines.push(`> ${getText(b.quote.rich_text)}`); break;
      case 'divider': lines.push('---'); break;
      case 'callout': {
        const icon = b.callout.icon?.emoji || '💡';
        lines.push(`${icon} ${getText(b.callout.rich_text)}`);
        break;
      }
      case 'table': {
        if (b.has_children) {
          const rows = await notion.blocks.children.list({ block_id: b.id, page_size: 100 });
          for (const row of rows.results) {
            if (row.type !== 'table_row') continue;
            const cells = row.table_row.cells.map((cell) => getText(cell));
            lines.push(`| ${cells.join(' | ')} |`);
          }
        }
        break;
      }
      // 기타 블록은 조용히 스킵
    }
  }
  return lines;
}

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
  // 항목별 "근거 인용"을 함께 받는 재사용 타입.
  // sourceQuote가 빈 문자열이면 "명시적 발언 없음 = 환각/추정 의심" 신호로 활용.
  const evidenced = {
    type: 'object',
    properties: {
      text: { type: 'string', description: '항목 본문 (한국어)' },
      sourceQuote: {
        type: 'string',
        description:
          '이 항목의 근거가 된 전사문에서의 짧은 인용 (원문 그대로 10~80자). 명시적 발언 없이 추정/유추로 작성한 항목은 빈 문자열.',
      },
    },
    required: ['text', 'sourceQuote'],
  };

  return {
    type: 'object',
    properties: {
      title: { type: 'string', description: '회의 제목 (30자 이내)' },
      topic: { type: 'string', description: '회의 주제 한 줄 요약 (50자 이내). 아젠다를 나열하지 말고 핵심만 짧게.' },
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
            points: { type: 'array', items: evidenced },
          },
          required: ['topic', 'points'],
        },
      },
      decisions: { type: 'array', items: evidenced },
      todos: { type: 'array', items: evidenced },
    },
    required: ['title', 'topic', 'meetingType', 'labels', 'agenda', 'discussion', 'decisions', 'todos'],
  };
}
