// 회의록 작성 가이드 Notion 페이지 로드 → 평문(markdown-like) 변환.
// 사용자가 Notion에서 페이지만 수정하면 다음 회의록부터 자동 반영됨.
// 실패 시 빈 문자열 반환 — 요약 중단하지 않음.
// Phase B에서 NotionClient 주입 가능하도록 리팩터 예정.
import { Client as NotionClient } from '@notionhq/client';

export async function fetchGuide() {
  const pageId = process.env.NOTION_GUIDE_PAGE_ID;
  if (!pageId || !process.env.NOTION_TOKEN) return '';

  try {
    const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
    const lines = await renderPageBlocks(notion, pageId);
    const body = lines.join('\n').trim();
    if (!body) return '';
    return `\n[회의록 작성 가이드]\n${body}\n`;
  } catch (e) {
    console.warn(`[fetchGuide] failed: ${e?.message}`);
    return '';
  }
}

// Notion 페이지 children 을 markdown-like 평문으로 렌더.
// heading/paragraph/list/quote/divider/callout/table 지원, 그 외 블록은 조용히 스킵.
export async function renderPageBlocks(notion, blockId) {
  const res = await notion.blocks.children.list({ block_id: blockId, page_size: 100 });
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
