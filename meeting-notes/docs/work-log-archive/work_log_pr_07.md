### PR #7 — maxOutputTokens 상향 + 진단 로깅

**문제**: 전사 성공했다고 나오지만 실제로는 빈 응답 반환.

**1차 가설**: 출력 토큰 한도 8192가 60분 전사 분량(20~30K)보다 작아서 `MAX_TOKENS`로 잘림.

**해결 시도**:
- `config: { maxOutputTokens: 65536 }` 명시 (Flash 모델 최대치)
- 빈 응답 시 Gemini 응답 구조 덤프 (finishReason, safetyRatings, promptFeedback, usageMetadata)

**결과**: 🟡 여전히 빈 응답. 하지만 진단 로깅으로 `finishReason: MAX_TOKENS` 확인 — 한도 올렸는데 왜 여전히 MAX_TOKENS?
