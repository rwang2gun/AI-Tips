// 요약(summarize) 프롬프트 빌더 + topic 재압축 프롬프트 빌더.
// api/process-meeting.js와 scripts/process-recording-locally.js가 공유.
// glossaryText / guideText / synonymHint 는 호출자가 조립하여 전달.

export function buildSummarizePrompt({
  meetingMeta,
  transcript,
  glossaryText = '',
  guideText = '',
  synonymHint = '',
} = {}) {
  return `당신은 게임 기획 회의록 정리 전문가입니다. 아래 한국어 회의 전사문을 바탕으로 회의록을 작성하세요.

[메타 정보]
${JSON.stringify(meetingMeta, null, 2)}
${glossaryText}${synonymHint}${guideText}
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
}

// 1차 요약의 topic이 50자 초과일 때 Pro로 한 번 더 짧게 압축하기 위한 프롬프트.
// 입력: title + 현재 topic + agenda 제목들 (작은 메타만 보내서 빠르고 503 위험 적음).
export function buildRefineTopicPrompt({ meetingData }) {
  const agendaTitles = (meetingData.agenda || [])
    .map((a) => `- ${a.title}`)
    .filter((s) => s.length > 2)
    .join('\n');

  return `다음은 게임 기획 회의의 1차 요약 결과입니다. topic 필드가 길어서 한 줄로 다시 압축이 필요합니다.

[제목]
${meetingData.title || '(없음)'}

[현재 topic — ${meetingData.topic.length}자]
${meetingData.topic}

${agendaTitles ? `[아젠다 제목들]\n${agendaTitles}\n` : ''}
요구사항:
- 50자 이내 한 문장으로 회의의 본질적 주제만 표현
- 아젠다 항목을 나열하지 말 것 ("A, B, C 논의" 같은 형태 금지)
- 새로운 topic 한 줄만 출력. 따옴표/접두어/설명 없이 본문만.`;
}
