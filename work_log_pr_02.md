### PR #2 — 전사/요약 단계 분리

**가설**: Gemini 호출을 "오디오→텍스트 전사"와 "텍스트→구조화 JSON 요약" 두 단계로 쪼개면 각 호출 시간이 줄어든다.

**구현 (5단계 파이프라인)**:
1. upload-chunk
2. prepare
3. check-file
4. **transcribe**: 오디오 → 전사문 → Blob(`transcript.txt`)
5. **summarize**: transcript.txt → JSON → Blob(`result.json`)
6. **finalize-notion**: result.json → Notion 페이지 + 정리

**결과**: 🔴 여전히 타임아웃. `transcribe` 단독 호출도 63분 오디오를 처리하느라 60초 초과.
