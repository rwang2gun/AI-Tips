// 유의어 사전(Notion DB) 조회 + 전사/요약 프롬프트 힌트 빌더.
// 현재 로컬 스크립트에서만 사용 (scripts/process-recording-locally.js, preview-summarize-prompt.js).
// applySynonymReplacements 는 lib/transcript/post-process.js 로 분리됨.
//
// NotionClient 팩토리는 동적 import — 순수 힌트 빌더(buildTranscribeSynonymHint 등)는
// notion 의존성 없이 단위 테스트할 수 있어야 한다.

// 유의어 사전 DB 조회. 실패 시 빈 배열 반환.
// 반환 형태: [{ correct, misrecs[], strategy, category, note }, ...]
export async function fetchSynonyms() {
  const synonymDbId = process.env.NOTION_SYNONYM_DB_ID;
  if (!synonymDbId || !process.env.NOTION_TOKEN) return [];

  try {
    const { createNotionClient } = await import('./clients/notion.js');
    const notion = await createNotionClient();
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
      // 쉼표(또는 전각 쉼표) 구분, 공백 제거, 빈 항목 / 정답과 동일 항목 제외
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
// 따라서 "정답 용어"만 간단히 나열하고, 오인식 → 정답 변환은 후처리 regex에 맡김.
export function buildTranscribeSynonymHint(synonyms) {
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
export function buildSummarizeSynonymHint(synonyms) {
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
