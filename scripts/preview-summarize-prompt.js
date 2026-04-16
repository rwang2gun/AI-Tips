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

import { Client as NotionClient } from '@notionhq/client';
import { Agent, setGlobalDispatcher } from 'undici';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

const transcriptPath = process.argv[2];
const transcript = transcriptPath && existsSync(transcriptPath)
  ? await fs.readFile(transcriptPath, 'utf-8')
  : '{{전사문 내용이 여기에 들어감}}';

// ----- process-recording-locally.js에서 복사한 로직 -----

async function fetchGlossary() {
  const id = process.env.NOTION_GLOSSARY_DB_ID;
  if (!id || !process.env.NOTION_TOKEN) return '';
  const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
  const res = await notion.databases.query({
    database_id: id,
    filter: { property: '활성', checkbox: { equals: true } },
    sorts: [{ property: '카테고리', direction: 'ascending' }],
  });
  if (!res.results.length) return '';
  const terms = res.results.map((page) => {
    const p = page.properties;
    const term = p['용어']?.title?.[0]?.plain_text || '';
    const desc = p['설명']?.rich_text?.[0]?.plain_text || '';
    const cat = p['카테고리']?.select?.name || '';
    return `- ${term}: ${desc}${cat ? ` [${cat}]` : ''}`;
  });
  return `\n[용어집 — 아래 용어가 전사문에 있으면 정확한 표기를 사용하세요]\n${terms.join('\n')}\n`;
}

async function fetchGuide() {
  const pageId = process.env.NOTION_GUIDE_PAGE_ID;
  if (!pageId || !process.env.NOTION_TOKEN) return '';
  const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
  try {
    const res = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });
    const getText = (rt) => (rt || []).map((t) => t.plain_text).join('');
    const lines = [];
    for (const b of res.results) {
      switch (b.type) {
        case 'heading_1': lines.push(`# ${getText(b.heading_1.rich_text)}`); break;
        case 'heading_2': lines.push(`## ${getText(b.heading_2.rich_text)}`); break;
        case 'heading_3': lines.push(`### ${getText(b.heading_3.rich_text)}`); break;
        case 'paragraph': lines.push(getText(b.paragraph.rich_text)); break;
        case 'bulleted_list_item': lines.push(`- ${getText(b.bulleted_list_item.rich_text)}`); break;
        case 'numbered_list_item': lines.push(`1. ${getText(b.numbered_list_item.rich_text)}`); break;
        case 'quote': lines.push(`> ${getText(b.quote.rich_text)}`); break;
        case 'divider': lines.push('---'); break;
        case 'callout': lines.push(`${b.callout.icon?.emoji || '💡'} ${getText(b.callout.rich_text)}`); break;
        case 'table': {
          if (b.has_children) {
            const rows = await notion.blocks.children.list({ block_id: b.id, page_size: 100 });
            for (const row of rows.results) {
              if (row.type !== 'table_row') continue;
              const cells = row.table_row.cells.map((c) => getText(c));
              lines.push(`| ${cells.join(' | ')} |`);
            }
          }
          break;
        }
      }
    }
    const body = lines.join('\n').trim();
    return body ? `\n[회의록 작성 가이드]\n${body}\n` : '';
  } catch {
    return '';
  }
}

async function fetchSynonyms() {
  const id = process.env.NOTION_SYNONYM_DB_ID;
  if (!id || !process.env.NOTION_TOKEN) return [];
  const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
  const res = await notion.databases.query({
    database_id: id,
    filter: { property: '활성', checkbox: { equals: true } },
    page_size: 200,
  });
  return res.results.map((page) => {
    const p = page.properties;
    const correct = p['정답 용어']?.title?.[0]?.plain_text?.trim() || '';
    const rawMisrec = p['오인식 표현']?.rich_text?.[0]?.plain_text || '';
    const misrecs = rawMisrec.split(/[,，]/).map((s) => s.trim()).filter((s) => s && s !== correct);
    const strategy = p['치환 전략']?.select?.name || '수동 확인';
    const category = p['카테고리']?.select?.name || '';
    const note = p['맥락 메모']?.rich_text?.[0]?.plain_text || '';
    return { correct, misrecs, strategy, category, note };
  }).filter((s) => s.correct && s.misrecs.length > 0);
}

function buildSummarizeSynonymHint(synonyms) {
  if (!synonyms.length) return '';
  const mappingLines = synonyms
    .filter((s) => s.misrecs.length > 0 && s.strategy !== '수동 확인')
    .map((s) => {
      const variants = s.misrecs.map((v) => `"${v}"`).join(', ');
      const cat = s.category ? ` [${s.category}]` : '';
      return `- ${variants} → **${s.correct}**${cat}`;
    });
  const noteLines = synonyms
    .filter((s) => s.note)
    .map((s) => `- ${s.correct}${s.category ? ` [${s.category}]` : ''}: ${s.note}`);
  const sections = [];
  if (mappingLines.length) {
    sections.push(`[전사 오류 보정 가이드 — 전사문에 아래 표기가 남아 있으면 괄호 안 정답 용어로 이해하고 요약에 반영]\n${mappingLines.join('\n')}`);
  }
  if (noteLines.length) {
    sections.push(`[유의어 맥락 메모]\n${noteLines.join('\n')}`);
  }
  if (!sections.length) return '';
  return `\n\n${sections.join('\n\n')}\n`;
}

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

const prompt = `당신은 게임 기획 회의록 정리 전문가입니다. 아래 한국어 회의 전사문을 바탕으로 회의록을 작성하세요.

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
