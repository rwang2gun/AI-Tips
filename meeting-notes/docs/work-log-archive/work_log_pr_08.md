### PR #8 — thinking 모드 비활성화 (**결정적 돌파구**)

**확정된 원인**: Gemini 2.5 Flash는 **기본적으로 "thinking" 모드가 ON**. thinking이 출력 토큰 예산을 내부 사고에 소비 → 실제 전사 텍스트는 0 토큰으로 종료 (`finishReason: MAX_TOKENS`, `candidates[0].content.parts` 빈 상태).

**해결**:
```js
config: {
  maxOutputTokens: 65536,
  thinkingConfig: { thinkingBudget: 0 },  // thinking OFF
}
```

전사는 단순 작업이라 thinking 불필요. 전체 토큰 예산을 실제 출력에 할당.

**결과**: ✅ **전사 성공** — 126,754 chars / 235초 소요.

**중요한 교훈**:
- 📌 Gemini 2.5 Flash의 thinking 모드는 기본 ON이고 상당한 출력 토큰 소비
- 📌 `maxOutputTokens` 단독으로는 부족 — thinking이 계속 한도를 잡아먹을 수 있음
- 📌 단순 작업은 `thinkingBudget: 0`으로 명시적 OFF 권장
