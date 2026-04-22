// 전사문(transcript) 후처리 유틸 — 순수 함수, 외부 의존성 없음.
// 서버(api/handlers/transcribe-segment.js)와 로컬(scripts/process-recording-locally.js) 공용.

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

// Gemini Flash generation loop 탐지 — 치환 없이 검출만.
// 2026-04-22 세션 seg 01에서 "그"라는 한 글자가 수천 번 반복된 케이스가 대표 예시.
// 트리거는 한 글자일 수도, 2~6자 어절일 수도 있어 양쪽 다 검사하되, 같은 문자열 범위를
// 여러 길이의 토큰으로 이중 계산하지 않도록 길이가 긴 쪽 match를 우선 채택.
// 반환:
//   { hasLoop, longestRun: { token, count, start, chars } | null, repeatedChars }
//   - longestRun.chars = count * token.length
//   - start: 반복이 시작된 문자 인덱스 (raw 보존 의사결정/진단용)
//   - repeatedChars: 발견된 모든 loop run 길이 합 (겹침 없이)
export function detectLoop(text, { minRun = 20 } = {}) {
  if (!text || typeof text !== 'string') {
    return { hasLoop: false, longestRun: null, repeatedChars: 0 };
  }
  // 최대 토큰 길이 20 — 2026-04-22 seg 13 "컴파일된 걸로 만들고 " (12자)급 어절 반복을 커버하면서도
  // 알고리즘 비용(O(N×maxLen))을 현실적인 수준으로 유지. 20자 이상 반복되는 긴 phrase는 드묾.
  const maxLen = 20;
  let longest = null;
  let repeatedChars = 0;
  let i = 0;
  while (i < text.length) {
    // 현 위치 i에서 가능한 가장 긴 토큰 길이(maxLen→1)부터 시도. 긴 쪽이 먼저 run을 소비하면
    // 짧은 길이는 중복 집계하지 않음.
    let matched = false;
    for (let len = maxLen; len >= 1; len--) {
      if (i + len * 2 > text.length) continue;
      const token = text.slice(i, i + len);
      if (!token.trim()) continue; // 공백-only 토큰 skip
      let count = 1;
      let j = i + len;
      while (j + len <= text.length && text.slice(j, j + len) === token) {
        count++;
        j += len;
      }
      if (count >= minRun) {
        const chars = count * len;
        repeatedChars += chars;
        if (!longest || chars > longest.chars) {
          longest = { token, count, start: i, chars };
        }
        i = j;
        matched = true;
        break;
      }
    }
    if (!matched) i++;
  }
  return {
    hasLoop: longest !== null,
    longestRun: longest,
    repeatedChars,
  };
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
