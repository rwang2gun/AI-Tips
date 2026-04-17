### PR #10 — 요약 단계만 Pro로 전환

**확정된 원인**: Gemini 2.5 Flash가 "긴 입력(126K chars) + responseSchema structured output" 조합을 지속 거절. 용량 풀 혼잡으로 추정.

**해결**:
- 요약 기본 모델을 `gemini-2.5-pro`로 교체 (별도 용량 풀)
- 전사는 `gemini-2.5-flash` 유지 (이미 안정 성공, 단순 작업엔 충분)
- `--summarize-model=gemini-2.5-flash` 플래그로 짧은 회의는 Flash 강제 가능

**결과**: ✅ **요약 성공** — 1회 재시도 후 32.9초 소요.

**최종 모델 구성**:
| 단계 | 모델 | 비용 (63분 기준) |
|------|------|-----------------|
| 전사 | gemini-2.5-flash (thinking OFF) | ~$0.015 (약 20원) |
| 요약 | gemini-2.5-pro | ~$0.09 (약 120원) |
