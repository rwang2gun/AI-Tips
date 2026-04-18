### PR #15 — 녹음 단계 5분 분할 (근본 해결) + topic 2차 압축 + 진단 자료

**의의**: `RECOVERY-PLAN.md`의 Step 4(MediaRecorder 분할 녹음)가 드디어 구현됨. Vercel 60초 한도를 **녹음 단계**에서 근본 해결.

#### 15-1. PWA 녹음 5분 분할

**클라이언트** (`meeting-notes/app.js`):
- `SEGMENT_SECONDS=300` 상수, `startSegmentRecorder()` 루프
- `setTimeout` 5분 후 `mediaRecorder.stop()` → `onstop`에서 다음 recorder 시작
- 사용자 종료 요청 시 `stopRequested=true` 플래그 후 마지막 segment 마무리
- `processMeeting(segs)`: 세그먼트별로 `upload-chunk(X-Segment-Index)` → `prepare-segment` → `check-file` → `transcribe-segment` 반복 → `merge-transcripts` → `summarize` → `finalize-notion`
- 진행 UI를 "세그먼트 N/M …" 단위로 표기

**서버** (`api/process-meeting.js`) — 신규 액션 3개:
- `prepare-segment`: `seg-NN/` 청크 결합 → Gemini Files API 업로드
- `transcribe-segment`: 5분 오디오 전사 → `transcript-NN.txt`. 프롬프트에 "전체 회의 중 N/M 번째 5분" 명시. `thinkingBudget:0` + `maxOutputTokens:65536` (PR #8 교훈 유지)
- `merge-transcripts`: `transcript-NN.txt` 시간순 결합 + `[N:00 ~ M:00]` 헤더 → `transcript.txt` (이후 summarize는 기존과 동일)
- `withRetry` 헬퍼: 503/429/UNAVAILABLE 지수 백오프 (maxAttempts=3, base 2s, max 8s — Vercel 60초 한도 안에 끝남)
- legacy `prepare`/`transcribe` 액션은 `recover.html`의 기존 실패 세션 복구용으로 **보존**

#### 15-2. topic 50자 초과 시 Pro로 2차 압축

PR #14 미결과제 대응. 1차 요약(Flash) 결과의 topic이 길거나 아젠다 나열식이면 **2-pass**로 보강:
- `topic.length > 50` 일 때만 Pro에 작은 입력(title + 1차 topic + 아젠다 제목) 전송
- 입력이 매우 작아 빠르고 503 위험 적음, 단일 책임이라 schema description 준수
- 실패 시 1차 topic 유지 (요약 자체는 이미 성공한 상태)
- 50자 이하면 호출 스킵 → 매번 추가 비용 없음

서버와 로컬 스크립트 양쪽에 동일 로직 적용. 응답 후처리: 첫 줄만 + 양쪽 따옴표/괄호 제거 + `topic:` prefix 제거.

#### 15-3. 회의록 품질 진단 자료

**A. 전사 원문 영구 보존 (서버)**:
- `handleFinalizeNotion`에서 `cleanupChunks` 직전에 `transcript.txt`를 Notion File Upload API로 올리고 진단 토글에 첨부
- 실패해도 페이지 생성 진행 (try/catch)
- 이전엔 finalize 직후 Blob 청소로 전사 원문이 **영구 소실**됐었음. 이제 회의록과 함께 Notion에 묶여 보존 → "전사가 틀린 건지 요약이 틀린 건지" 사후 검토 가능
- PR #12에서 로컬 스크립트에 먼저 구현됐던 패턴을 서버에 이식

**B. 항목별 근거 인용 `sourceQuote`**:
- `meetingSchema` 객체화: `discussion.points` / `decisions` / `todos` 항목을 plain string → `{ text, sourceQuote }` (agenda는 회의 시작 안건이라 제외)
- 요약 프롬프트 규칙 #12 추가: 각 항목의 근거가 된 전사문 인용을 10~80자 **그대로 발췌**
- 명시적 발언 없이 추정/유추한 항목은 `sourceQuote` **빈 문자열** (환각 시그널이므로 정직하게 비우는 것이 중요)
- Notion 렌더링: 본문(아젠다/논의/결정/To-do)은 `.text`만 사용 — 외관 변화 없음. 페이지 하단 "🔍 검토 자료" 토글에 항목별 매핑 표시 (인용 빈 항목은 빨간 "⚠️ 근거 없음 (환각/추정 의심)" 표시)
- `itemText`/`itemQuote` 헬퍼로 구 schema(plain string) 호환 유지

**부수 정리**:
- 서버 `buildBlocks`를 `upload-to-notion.js`와 동일 구조로 일원화 (heading_2 + 회색 메타 콜아웃) — PR #14에서 로컬만 정리됐던 차이 해소
- 신규 헬퍼: `itemText` / `itemQuote` / `buildEvidenceBlocks` / `buildTranscriptFilename` / `uploadTranscriptToNotion`
- **알려진 부채**: 같은 헬퍼가 서버/로컬 양쪽에 **중복 존재**. `buildBlocks` 자체가 동기화 대상이라 유지보수 일관성 위해 그대로 둠 (주석에 동기화 필요 명시)

#### 15-4. 파이프라인 문서화

`MEETING-NOTES-PIPELINE.md` 신규 추가. 현재 동작하는 **7단계 파이프라인** 흐름 정리:
- 단계별 입력/처리/출력/기대 시간/실패 모드/fallback 표
- 산출물 라이프사이클, 진단 자료(전사 첨부 + sourceQuote), 모델/비용, 알려진 한계
- 히스토리(WORK-LOG) / 복구 계획(RECOVERY-PLAN) / 세션 인계(HANDOFF)와 역할 분리
