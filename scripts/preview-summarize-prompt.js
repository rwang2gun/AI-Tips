// ============================================================
// 요약 프롬프트 구성 미리보기 (API 호출 없이 프롬프트만 출력)
// ============================================================
//
// [용도]
//   용어집·유의어 사전이 요약 프롬프트에 어떻게 주입되는지 확인용.
//   비용 0, 네트워크는 Notion DB 조회만.
//
// [사용법]
//   node --env-file=.env scripts/preview-summarize-prompt.js [<transcript-file>]
//
//   transcript-file 생략하면 placeholder로 전사문 대체 출력.
// ============================================================

import { Agent, setGlobalDispatcher } from 'undici';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { buildSummarizePrompt } from '../lib/prompts/summarize.js';
import { fetchGlossary } from '../lib/glossary.js';
import { fetchSynonyms, buildSummarizeSynonymHint } from '../lib/synonyms.js';
import { fetchGuide } from '../lib/guide.js';

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

const transcriptPath = process.argv[2];
const transcript = transcriptPath && existsSync(transcriptPath)
  ? await fs.readFile(transcriptPath, 'utf-8')
  : '{{전사문 내용이 여기에 들어감}}';

// ----- 실행 -----

const glossaryText = await fetchGlossary();
const synonyms = await fetchSynonyms();
const summarizeSynonymHint = buildSummarizeSynonymHint(synonyms);
const guideText = await fetchGuide();

const today = new Date().toISOString().slice(0, 10);
const meetingMeta = {
  requestedTitle: null,
  requestedMeetingType: null,
  durationSec: null,
  date: today,
};

const prompt = buildSummarizePrompt({
  meetingMeta,
  transcript,
  glossaryText,
  guideText,
  synonymHint: summarizeSynonymHint,
});

// 전사문 부분은 앞/뒤만 보여주고 중간 생략 (너무 길면 출력 복잡)
const TRANSCRIPT_PLACEHOLDER = '{{전사문 내용이 여기에 들어감}}';
let displayPrompt = prompt;
if (transcript.length > 500 && transcript !== TRANSCRIPT_PLACEHOLDER) {
  const head = transcript.slice(0, 200);
  const tail = transcript.slice(-200);
  const excerpt = `${head}\n\n... [${transcript.length - 400}자 생략] ...\n\n${tail}`;
  displayPrompt = prompt.replace(transcript, excerpt);
}

console.log('━'.repeat(72));
console.log('요약 프롬프트 미리보기');
console.log('━'.repeat(72));
console.log(displayPrompt);
console.log('━'.repeat(72));
console.log('');
console.log(`용어집 항목: ${glossaryText ? glossaryText.split('\n').filter((l) => l.startsWith('- ')).length : 0}개`);
console.log(`유의어 사전: ${synonyms.length}개 (무조건=${synonyms.filter((s) => s.strategy === '무조건 치환').length}, 조건부=${synonyms.filter((s) => s.strategy === '맥락 조건부').length}, 수동=${synonyms.filter((s) => s.strategy === '수동 확인').length})`);
console.log(`가이드 길이: ${guideText ? `${guideText.length} chars` : 'none'}`);
console.log(`전체 프롬프트 길이: ${prompt.length} chars (${transcript.length} chars transcript)`);
