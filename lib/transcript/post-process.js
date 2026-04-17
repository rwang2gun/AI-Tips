// 전사문(transcript) 후처리 유틸 — 순수 함수, 외부 의존성 없음.
// 현재 로컬 파이프라인(scripts/process-recording-locally.js)에서만 사용.

// Gemini가 줄바꿈 규칙을 무시하고 한 덩어리로 반환하는 케이스 방어.
// 문장 끝 부호(. ! ? …) + 선택적 닫는 따옴표/괄호 뒤에 공백이 오고,
// 그 다음 문자가 한글/영문일 때만 줄바꿈 삽입.
// 숫자 목록("1. ", "2. ")은 뒤에 숫자가 오니 자연스럽게 제외됨.
export function enforceSentenceBreaks(text) {
  return text
    .split('\n')
    .map((line) => {
      // 한 줄이 짧으면 그대로 유지 (이미 제대로 줄바꿈된 것)
      if (line.length < 80) return line;
      return line.replace(/([.!?…]["'」』)\]]?)[ \t]+(?=[가-힣A-Za-z])/g, '$1\n');
    })
    .join('\n');
}

// 유의어 사전의 "무조건 치환" 전략 항목으로 전사문을 교정.
// 한글 단어 경계 근사: 앞뒤가 한글이면 매칭 제외 (부분매칭 방지).
// 반환: { text: 교정된 전문, applied: [{ from, to, count }, ...] }
export function applySynonymReplacements(text, synonyms) {
  const strictOnes = (synonyms || []).filter((s) => s.strategy === '무조건 치환');
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
