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
import { Agent, setGlobalDispatcher } from 'undici';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { meetingSchema } from '../lib/schemas/meeting.js';
import { buildLocalTranscribePrompt } from '../lib/prompts/transcribe.js';
import { buildSummarizePrompt, buildRefineTopicPrompt } from '../lib/prompts/summarize.js';
import { fetchGlossary } from '../lib/glossary.js';
import {
  fetchSynonyms,
  buildTranscribeSynonymHint,
  buildSummarizeSynonymHint,
} from '../lib/synonyms.js';
import { fetchGuide } from '../lib/guide.js';

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
  const transcribePrompt = buildLocalTranscribePrompt({ synonymHint });

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
  const summarizePrompt = buildSummarizePrompt({
    meetingMeta,
    transcript,
    glossaryText,
    guideText,
    synonymHint: summarizeSynonymHint,
  });

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
  const prompt = buildRefineTopicPrompt({ meetingData });

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

