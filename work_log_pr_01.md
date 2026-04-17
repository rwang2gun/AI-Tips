### PR #1 — 3단계 분할 + 복구 페이지 (첫 시도)

**가설**: 결합+업로드+Gemini+Notion이 60초에 안 맞으니 3개 액션으로 쪼개면 된다.

**구현**:
- `prepare`: 청크 결합 + Gemini Files API 업로드 (ACTIVE 대기 X)
- `check-file`: 클라이언트가 파일 상태 폴링
- `finalize`: Gemini 전사+요약 동시 처리 + Notion 페이지 생성
- `meeting-notes/recover.html`: 실패한 세션 재처리용 페이지

**결과**: 🟡 `finalize` 단계에서 **여전히 타임아웃**. 단일 Gemini 호출(audio→structured JSON)이 60초 초과.
