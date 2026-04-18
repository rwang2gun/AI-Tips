// Notion 회의록 페이지 블록 빌더 (api/scripts 공통).
//
// meetingData(스키마: lib/schemas/meeting.js)를 받아 Notion pages.create의
// `children` 배열로 변환한다. 진단 토글이 포함된 단일 구현 — 이전에 api/와
// scripts/ 양쪽에 중복돼 "동기화 필요" 주석으로 관리하던 buildBlocks를 대체.
//
// transcriptUpload / manifestUpload 는 각각 { id, charCount } 형태. null/undefined면
// 해당 file block 만 생략되고 나머지 근거 인용 섹션은 그대로 생성된다.
// manifestUpload 는 진행 로그(diagnostic manifest) 전용 — 서버 Blob 상태, 세그먼트
// 개수/누락, 녹음 시각 등을 영구 보존해 사후 진단에 사용.
// (로컬 경로에서 넘기던 filename 필드는 버전 간 차이가 있었지만 블록 본문엔
//  사용되지 않아 입력 스키마에서 제외.)

// 항목 형태 호환 헬퍼: 신 schema는 { text, sourceQuote } 객체, 구 schema는 plain string
function itemText(x) { return typeof x === 'string' ? x : (x?.text || ''); }
function itemQuote(x) { return typeof x === 'string' ? '' : (x?.sourceQuote || ''); }

function text(s) { return [{ type: 'text', text: { content: s } }]; }
function bold(s) { return [{ type: 'text', text: { content: s }, annotations: { bold: true } }]; }

function bullet(richText, children) {
  const b = {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: richText },
  };
  if (children?.length) b.bulleted_list_item.children = children;
  return b;
}

function bullets(items) {
  return items.map((s) => bullet(text(s)));
}

function heading2(emoji, title) {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: text(`${emoji} ${title}`) },
  };
}

function heading3(content) {
  return {
    object: 'block',
    type: 'heading_3',
    heading_3: { rich_text: text(content) },
  };
}

// 회의록 서식 구조에 맞춰 Notion 블록 구성.
export function buildMeetingPageBlocks(data, transcriptUpload = null, manifestUpload = null) {
  const blocks = [];

  // ===== 메타 영역: 2단 컬럼 × 회색 콜아웃 (수동 편집 영역) =====
  blocks.push({
    object: 'block',
    type: 'column_list',
    column_list: {
      children: [
        {
          object: 'block',
          type: 'column',
          column: {
            children: [{
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
            }],
          },
        },
        {
          object: 'block',
          type: 'column',
          column: {
            children: [{
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
            }],
          },
        },
      ],
    },
  });

  blocks.push({ object: 'block', type: 'divider', divider: {} });

  // ===== 본문: heading_2 섹션 × 4 (sourceQuote는 진단 토글에서만 노출) =====

  blocks.push(heading2('📌', '아젠다'));
  if ((data.agenda || []).length === 0) {
    blocks.push(bullet(text('(명시된 아젠다 없음)')));
  } else {
    for (const a of data.agenda) {
      blocks.push(bullet(bold(a.title), bullets(a.items || [])));
    }
  }

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

  blocks.push(heading2('🎯', '결정 사항'));
  if ((data.decisions || []).length === 0) {
    blocks.push(bullet(text('(결정된 사항 없음)')));
  } else {
    for (const d of data.decisions) {
      blocks.push(bullet(text(itemText(d))));
    }
  }

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

  // ===== 진단 토글: 전사 원문 + 진행 로그 + 항목별 근거 인용 매핑 =====
  const evidenceChildren = buildEvidenceBlocks(data, transcriptUpload, manifestUpload);
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

// 진단 토글 안에 들어갈 블록들: 전사 파일 + 진행 로그 파일 + 항목별 (text — 인용/⚠️ 근거 없음).
// 외부에서 토글 없이 근거 섹션만 쓰고 싶을 때를 대비해 별도 export.
export function buildEvidenceBlocks(data, transcriptUpload = null, manifestUpload = null) {
  // 본문 텍스트 + sourceQuote(있으면 회색 이탤릭, 없으면 빨간 ⚠️)를 한 줄에 묶음
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

  if (transcriptUpload) {
    blocks.push({
      object: 'block', type: 'file',
      file: {
        type: 'file_upload',
        file_upload: { id: transcriptUpload.id },
        caption: [{
          type: 'text',
          text: { content: `회의 전사 원문 (${transcriptUpload.charCount.toLocaleString()}자)` },
        }],
      },
    });
  }

  if (manifestUpload) {
    blocks.push({
      object: 'block', type: 'file',
      file: {
        type: 'file_upload',
        file_upload: { id: manifestUpload.id },
        caption: [{
          type: 'text',
          text: { content: `진행 로그 (세그먼트/전사 목록, 녹음 시각 — 사후 진단용)` },
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
