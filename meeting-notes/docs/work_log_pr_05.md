### PR #5 — 로컬 처리 스크립트 추가

**방향 전환**: Vercel 우회해서 로컬 Node.js에서 Gemini 직접 호출. Vercel timeout 무관.

**구현**:
- `scripts/download-session-audio.js` — Vercel Blob 청크 다운로드 → `recovered-<sid>.webm`
- `scripts/process-recording-locally.js` — 오디오 → 전사문 + 요약 JSON (Notion 미저장)
- `scripts/upload-to-notion.js` — 검수한 JSON → Notion 페이지 생성
- `.env.example` 업데이트 (BLOB_READ_WRITE_TOKEN)
- `.gitignore`에 `recovered-*.webm` 등 추가 (민감 정보 보호)
