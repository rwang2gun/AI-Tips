### PR #4 — videoMetadata 원복

**조치**: PR #3 변경사항을 전부 원복. `handleTranscribe`/`handleSummarize`/클라이언트 단일 호출로 복귀. 헤더 주석에 [한계] 섹션 추가 (audio에 videoMetadata 안 됨).

**Vercel 서버리스 한계 수용**: Vercel Hobby 플랜(60초)에서는 30분 이상 회의 단일 처리 불가능. 근본 해결은 녹음 단계 분할 (Step 4: MediaRecorder 10분 세션 분할).
