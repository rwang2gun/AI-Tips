// 회의록 구조화 요약 responseSchema (Gemini structuredOutput용).
// api/process-meeting.js와 scripts/process-recording-locally.js가 공유하는 단일 source.
export function meetingSchema() {
  // 항목별 "근거 인용"을 함께 받는 재사용 타입.
  // sourceQuote가 빈 문자열이면 "명시적 발언 없음 = 환각/추정 의심" 신호로 활용.
  const evidenced = {
    type: 'object',
    properties: {
      text: { type: 'string', description: '항목 본문 (한국어)' },
      sourceQuote: {
        type: 'string',
        description:
          '이 항목의 근거가 된 전사문에서의 짧은 인용 (원문 그대로 10~80자). 명시적 발언 없이 추정/유추로 작성한 항목은 빈 문자열.',
      },
    },
    required: ['text', 'sourceQuote'],
  };

  return {
    type: 'object',
    properties: {
      title: { type: 'string', description: '회의 제목 (30자 이내)' },
      topic: { type: 'string', description: '회의 주제 한 줄 요약 (50자 이내). 아젠다를 나열하지 말고 핵심만 짧게.' },
      meetingType: {
        type: 'string',
        enum: ['킥오프', '내부 논의', '실무 논의', '기타'],
      },
      labels: {
        type: 'array',
        items: { type: 'string', enum: ['전투', '시스템', '밸런스', 'UI'] },
      },
      agenda: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            items: { type: 'array', items: { type: 'string' } },
          },
          required: ['title', 'items'],
        },
      },
      discussion: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            topic: { type: 'string' },
            points: { type: 'array', items: evidenced },
          },
          required: ['topic', 'points'],
        },
      },
      decisions: { type: 'array', items: evidenced },
      todos: { type: 'array', items: evidenced },
    },
    required: ['title', 'topic', 'meetingType', 'labels', 'agenda', 'discussion', 'decisions', 'todos'],
  };
}
