// ============================================================
// 전사 합본에서 유의어 DB 등록 후보 단어를 추출
// ============================================================
//
// [목적]
// - 전사문에서 반복적으로 등장하는 명사/고유명사를 빈도순으로 추출
// - cowork(또는 사람)가 유의어 DB에 등록할 후보 목록으로 활용
//
// [사용법]
//   node scripts/extract-term-candidates.js <transcript-file> [--min-chars=3] [--min-count=3]
//
// [결과]
//   빈도 내림차순 상위 단어 목록을 stdout에 출력
//   (불용어는 자동 제외)
// ============================================================

import fs from 'node:fs/promises';

const input = process.argv[2];
const kwargs = Object.fromEntries(
  process.argv
    .slice(3)
    .filter((a) => a.startsWith('--') && a.includes('='))
    .map((a) => a.slice(2).split('=', 2))
);

const minChars = parseInt(kwargs['min-chars'] || '3', 10);
const minCount = parseInt(kwargs['min-count'] || '3', 10);

if (!input) {
  console.error('Usage: node scripts/extract-term-candidates.js <transcript-file> [--min-chars=3] [--min-count=3]');
  process.exit(1);
}

// 한국어 회의에서 정보가 없는 고빈도 단어 (조사·부사·지시어·감탄사·허사)
const STOPWORDS = new Set([
  // 지시·접속
  '이제', '그래서', '그런', '그냥', '이렇게', '이런', '근데', '그게', '그럼', '이게', '그거', '저거', '그런데',
  '그러면', '그러니까', '그리고', '하지만', '그러나', '그렇게', '그렇지', '저렇게', '이렇게도',
  // 관형·부사
  '뭔가', '약간', '되게', '그냥도', '아까', '진짜', '정말', '되면', '되는', '하는', '있는', '없는', '한번', '한번만',
  '이거', '저거', '그거', '어떤', '무슨', '어떻게', '얼마나', '얼마', '너무',
  // 동사 활용의 일부만 매칭된 조각
  '같아요', '같은', '하고', '하면', '해서', '돼요', '되고', '된다', '돼서', '돼도', '해도', '해요', '했던', '했어요',
  '할게', '갈게', '많은', '많이', '많아', '있어요', '있었던', '없어요', '없었던', '생각해', '생각', '봐요', '볼게',
  // 감탄·맞장구
  '으음', '아니', '네네', '맞아', '그래', '아니요', '맞아요', '네예', '그렇', '예예',
  // 기타
  '우리', '우리가', '우리는', '우리도', '저는', '저도', '저희', '저희가', '제가', '너도', '너는', '지금', '오늘',
  '그때', '이때', '만약', '사실', '정도', '되게도',
]);

const text = await fs.readFile(input, 'utf-8');

// 한글 단어 추출 (한 음절 단위가 {}로 정확히 세지도록 Unicode property 사용)
const koRegex = new RegExp(`[\\uAC00-\\uD7A3]{${minChars},}`, 'gu');
const enRegex = /[A-Za-z][A-Za-z0-9]{2,}/g; // 영문 3자+

const koMatches = text.match(koRegex) || [];
const enMatches = text.match(enRegex) || [];

// 카운트
const counts = new Map();
for (const w of [...koMatches, ...enMatches]) {
  if (STOPWORDS.has(w)) continue;
  counts.set(w, (counts.get(w) || 0) + 1);
}

// 정렬
const sorted = [...counts.entries()]
  .filter(([, c]) => c >= minCount)
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

// 출력: 컬럼 포맷
console.log(`[source] ${input}  |  ${text.length} chars`);
console.log(`[filter] min-chars=${minChars}, min-count=${minCount}, stopwords=${STOPWORDS.size}`);
console.log(`[result] ${sorted.length} terms above threshold`);
console.log('');

// Top-100만 간결히
const top = sorted.slice(0, 100);
const pad = Math.max(...top.map(([w]) => [...w].length * 2 + 2));
for (const [w, c] of top) {
  console.log(`  ${String(c).padStart(4)}  ${w}`);
}

if (sorted.length > 100) {
  console.log('');
  console.log(`  ... (${sorted.length - 100} more omitted)`);
}

// 파일로도 저장 (cowork에 넘기기 편하게)
const outPath = input.replace(/\.[^.]+$/, '') + '.term-candidates.txt';
const lines = sorted.map(([w, c]) => `${c}\t${w}`);
await fs.writeFile(outPath, lines.join('\n') + '\n', 'utf-8');
console.log('');
console.log(`[saved] ${outPath}  (${sorted.length} entries, TSV: count<TAB>term)`);
