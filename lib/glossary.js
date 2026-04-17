// 용어집(Notion DB) 조회 → 요약 프롬프트에 주입할 문자열 반환.
// 실패 시 빈 문자열 반환 — 요약 자체는 중단하지 않음.
import { createNotionClient } from './clients/notion.js';

// api/scripts 각각의 기존 인트로 문구를 그대로 보존하기 위해 header 파라미터를 노출.
// 기본값은 로컬(scripts/process-recording-locally.js)의 문구.
export async function fetchGlossary({
  header = '[용어집 — 아래 용어가 전사문에 있으면 정확한 표기를 사용하세요]',
} = {}) {
  const glossaryDbId = process.env.NOTION_GLOSSARY_DB_ID;
  if (!glossaryDbId || !process.env.NOTION_TOKEN) return '';

  try {
    const notion = await createNotionClient();
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

    return `\n${header}\n${terms.join('\n')}\n`;
  } catch (e) {
    console.warn(`[fetchGlossary] failed: ${e?.message}`);
    return '';
  }
}
