# 회의록 자동 생성 — 파이프라인 동작 흐름

> **한눈에**: 모바일 PWA가 5분 세그먼트로 녹음 → Vercel 서버리스가 segment별로 Gemini 전사 → 합치고 요약(Flash) → topic 재압축(Pro) → Notion 페이지 + 진단 자료(전사 원문 + 항목별 근거 인용).

이 문서는 *지금 동작하는* 파이프라인의 흐름과 각 단계 기대 결과를 정리한다. 히스토리/장애 복구는 `WORK-LOG.md` / `RECOVERY-PLAN.md`, 인계 정보는 `HANDOFF.md` 참고.

---

## 아키텍처

```
[모바일 PWA]                  [Vercel Serverless]              [외부]
meeting-notes/                api/process-meeting.js           Gemini API
  app.js               ◀──▶   (X-Action 디스패치)        ─►   (Files + generate)
  index.html                  + Vercel Blob (임시 저장)
                                                                Notion API
                                                          ─►   (file_upload + pages)
```

- **클라이언트**: `meeting-notes/app.js` — MediaRecorder 5분 분할 녹음, 세그먼트별 파이프라인 호출
- **서버**: `api/process-meeting.js` — `X-Action` 헤더로 7개 액션 라우팅
- **임시 저장**: Vercel Blob (`meetings/<sessionId>/...`)
- **AI**: Gemini Files API + 2.5 Flash(전사/요약) + 2.5 Pro(topic 재압축)
- **출력**: Notion "자동 회의록 DB" 페이지 + 전사 원문 첨부

---

## 파이프라인 단계

각 단계마다 입력 / 처리 / 출력 / 실패 모드를 명시.

### 0. 녹음 (클라이언트, app.js:60-174)

| 항목 | 내용 |
|------|------|
| 입력 | 사용자 마이크 (32kbps mono, audio/webm;codecs=opus 우선) |
| 처리 | `MediaRecorder.start(1000)` → 5분 후 `stop()` → 새 recorder 시작 (`SEGMENT_SECONDS=300`) |
| 출력 | `segments[] = [{ index, blob }, ...]` — 세그먼트당 독립 webm |
| 기대 시간 | 실시간 (회의 길이만큼) |
| 실패 모드 | 마이크 권한 거부 / 화면 잠금 / 탭 백그라운드 진입 |
| Fallback | wakeLock 요청, visibilityState 복귀 시 재요청 |

> **음성 누락**: stop/restart 사이 수십~수백 ms 손실 가능. 5분 세그먼트에선 허용 범위.

---

### 1. upload-chunk (서버, process-meeting.js handleUploadChunk)

| 항목 | 내용 |
|------|------|
| 입력 | `X-Session-Id` (UUID), `X-Segment-Index` (0~), `X-Chunk-Index`, `X-Total-Chunks`, `X-Mime-Type`, body=raw bytes |
| 처리 | 세그먼트 1개를 3.5MB 단위로 자른 청크를 Vercel Blob에 PUT |
| 출력 | `meetings/<sid>/seg-NN/chunk-NNNN.bin` |
| 기대 시간 | 청크당 1~3초 (청크 크기 + 모바일 회선) |
| 실패 모드 | 회선 끊김 / Vercel Blob 쓰기 실패 |
| Fallback | 클라이언트가 `await` 실패 시 즉시 throw → 재처리는 사용자 액션 |

> **legacy 호환**: `X-Segment-Index` 헤더가 없으면 `meetings/<sid>/chunk-NNNN.bin` 단일 폴더로 저장 (recover.html 경로).

---

### 2. prepare-segment (서버, handlePrepareSegment)

| 항목 | 내용 |
|------|------|
| 입력 | `{ sessionId, segmentIndex, mimeType }` |
| 처리 | `seg-NN/` 청크 전체 fetch+concat → Gemini Files API 업로드 (`withRetry`) |
| 출력 | `{ fileName, fileUri, fileMimeType, state }` (state는 보통 `PROCESSING`) |
| 기대 시간 | 5~15초 (5분 webm ≈ 1.2MB) |
| 실패 모드 | Gemini 업로드 503/429 → withRetry (최대 3회 지수백오프) |
| Fallback | 재시도 실패 시 클라이언트로 throw — 세그먼트 전체 재진행 필요 |

---

### 3. check-file (서버, handleCheckFile) — 클라이언트가 폴링

| 항목 | 내용 |
|------|------|
| 입력 | `{ fileName }` |
| 처리 | `genAI.files.get({ name })` → 상태 조회 |
| 출력 | `{ state, fileUri, fileMimeType }` (`PROCESSING` → `ACTIVE` 또는 `FAILED`) |
| 기대 시간 | 1회 호출당 ~500ms. 클라이언트가 2초 간격으로 최대 60회(2분) 폴링 |
| 실패 모드 | `FAILED` 상태 / 2분 안에 ACTIVE 안 됨 |
| Fallback | 클라이언트가 timeout 시 throw → 사용자 재시도 |

---

### 4. transcribe-segment (서버, handleTranscribeSegment)

| 항목 | 내용 |
|------|------|
| 입력 | `{ sessionId, segmentIndex, fileUri, fileMimeType, totalSegments }` |
| 처리 | Gemini 2.5 Flash로 한국어 전사 (`thinkingBudget: 0`, `maxOutputTokens: 65536`, `withRetry`) |
| 출력 | `meetings/<sid>/transcript-NN.txt` (UTF-8 plain text) |
| 기대 시간 | 5분 오디오당 15~30초 |
| 실패 모드 | 빈 응답 (`MAX_TOKENS` w/ thinking 잔존) / 503 지속 / 일부 segment generation loop |
| Fallback | 503은 withRetry, 그 외는 throw |

> **모델 선택 이유**: PR #8 — Flash thinking을 끄지 않으면 출력 토큰을 thinking이 다 먹어 빈 응답 반환됨. 단순 전사라 `thinkingBudget: 0` 필수.

---

### 5. merge-transcripts (서버, handleMergeTranscripts)

| 항목 | 내용 |
|------|------|
| 입력 | `{ sessionId, totalSegments }` |
| 처리 | `transcript-NN.txt` 시간순 정렬 + `--- [N:00 ~ M:00] ---` 헤더로 결합 |
| 출력 | `meetings/<sid>/transcript.txt` (전체 결합본) |
| 기대 시간 | 1~3초 (Blob fetch만) |
| 실패 모드 | 세그먼트 수 mismatch (totalSegments 다르면 400 반환) |
| Fallback | 없음 — 정합성 보장이 목적 |

---

### 6. summarize (서버, handleSummarize)

| 항목 | 내용 |
|------|------|
| 입력 | `{ sessionId, title, meetingType, durationSec }` |
| 처리 | transcript.txt + 용어집(Notion) 합쳐 Flash로 구조화 JSON 추출 (`responseSchema`, `withRetry`) |
| 출력 | `meetings/<sid>/result.json` = `{ meetingData, date }` |
| 기대 시간 | 10~30초 (전사문 길이 비례) |
| 실패 모드 | Flash가 긴 입력+structured output 조합에서 503 지속 |
| Fallback | withRetry — 추가 fallback은 없음 (지속 실패 시 로컬 재처리 권장) |

> **schema**: `discussion.points / decisions / todos`는 `{ text, sourceQuote }` 객체 배열. `sourceQuote`는 전사문 10~80자 인용 또는 빈 문자열(환각 시그널).

---

### 6a. refine-topic (서버, refineTopic — 조건부 호출)

| 항목 | 내용 |
|------|------|
| 트리거 | `meetingData.topic.length > 50` |
| 입력 | title + 1차 topic + agenda 제목 리스트 (작은 메타) |
| 처리 | Gemini 2.5 Pro로 한 줄 재압축 (`maxOutputTokens: 256`, `withRetry`) |
| 출력 | `meetingData.topic` 덮어쓰기 (응답이 더 짧을 때만) |
| 기대 시간 | 5~10초 |
| 실패 모드 | 503 또는 응답이 더 짧지 않음 |
| Fallback | 1차 topic 그대로 유지 (요약 자체는 이미 성공) |

---

### 7. finalize-notion (서버, handleFinalizeNotion)

| 항목 | 내용 |
|------|------|
| 입력 | `{ sessionId }` |
| 처리 | (1) `transcript.txt`를 Notion File Upload (3단계 single_part) — 실패 시 첨부 없이 진행 (2) `createNotionPage` — 본문 + 진단 토글 (3) `cleanupChunks` — Blob 세션 폴더 전체 삭제 |
| 출력 | `{ title, notionUrl }` + Notion 페이지 (자동 회의록 DB) |
| 기대 시간 | 5~15초 (file upload 1~3초 + 페이지 생성 2~5초 + cleanup 1~2초) |
| 실패 모드 | Notion 토큰 만료 / DB 권한 없음 / file upload API 변경 |
| Fallback | transcript 업로드 실패만 graceful (페이지는 생성됨) |

---

## 산출물 라이프사이클

| 산출물 | 생성 단계 | 저장 위치 | 수명 |
|--------|----------|----------|------|
| `seg-NN/chunk-NNNN.bin` | upload-chunk | Vercel Blob | finalize-notion에서 삭제 |
| Gemini Files API 업로드본 | prepare-segment | Google AI 서버 | 48시간 자동 만료 |
| `transcript-NN.txt` | transcribe-segment | Vercel Blob | finalize-notion에서 삭제 |
| `transcript.txt` (전체) | merge-transcripts | Vercel Blob | finalize-notion 직전에 Notion에 첨부 후 삭제 |
| `result.json` | summarize | Vercel Blob | finalize-notion에서 삭제 |
| Notion 페이지 + 첨부 전사 | finalize-notion | Notion | **영구** (사용자 관리) |

> **finalize 직전 Notion 첨부**가 핵심 — 그래야 cleanup해도 전사 원문이 영구 보존됨 (이전엔 청소 후 재구성 불가능했음).

---

## 진단 자료 (품질 디버깅용)

Notion 페이지 하단 `🔍 검토 자료` 토글 안에:

1. **전사 원문 file 첨부** — `전사원문_<date>_<title>.txt`
   - "전사가 틀린 건지 요약이 틀린 건지" 사후 비교 가능
2. **항목별 sourceQuote 매핑** — 결정/To-do/논의 각 항목에:
   - 인용 있음 → `텍스트  「회색 이탤릭 인용…」`
   - 인용 없음 → `텍스트  ⚠️ 근거 없음 (환각/추정 의심)` (빨간색)

본문(아젠다/논의/결정/To-do)은 텍스트만 표시 — 회의록 외관은 그대로 깔끔.

---

## 모델 / 예상 비용

| 단계 | 모델 | 트리거 | 60분 회의 기준 비용 |
|------|------|--------|---------------------|
| transcribe-segment | gemini-2.5-flash (thinking OFF) | 항상 (×12) | ~20원 |
| summarize | gemini-2.5-flash | 항상 ×1 | ~15원 |
| refine-topic | gemini-2.5-pro | topic > 50자 | ~30원 (조건부) |

> 로컬 스크립트(`process-recording-locally.js`)는 summarize도 Pro 기본. 서버는 Flash + 503 재시도(60초 한도 안에 끝나야 함).

---

## 알려진 한계

1. **세그먼트 경계 음성 누락** — MediaRecorder stop/restart 사이 수십~수백 ms 손실. 5분 단위에선 허용 범위.
2. **recover.html은 legacy 세션만 복구** — 새 segment 구조 (`seg-NN/`)는 미지원. 신규 실패 세션은 로컬 스크립트(`scripts/process-recording-locally.js`)로 처리.
3. **finalize-notion 60초 한도** — transcript Notion 업로드 + 페이지 생성 + cleanup이 모두 60초 안에 끝나야 함. 큰 전사문(500K+ chars) 시 위험. 현재까지 실측은 20초 이내.
4. **Pro topic 재압축이 503 지속** — fallback으로 1차 topic 유지하지만 길이 그대로. 다음 회의에서 검증 예정.
5. **summarize 503 지속** — 60초 안에 withRetry 3회로 끝나는데, Flash가 긴 입력+structured output 조합에서 지속 거절하면 throw. 로컬 스크립트로 fallback.

---

## 관련 파일

| 파일 | 역할 |
|------|------|
| `meeting-notes/app.js` | PWA 클라이언트 (녹음 + 세그먼트 파이프라인 호출) |
| `meeting-notes/index.html` | PWA UI |
| `meeting-notes/recover.html` | legacy 단일 파일 세션 복구 페이지 |
| `api/process-meeting.js` | 서버리스 (7개 액션 디스패치 + Notion 첨부 + 페이지 생성) |
| `api/version.js` | 배포 버전 배지용 |
| `scripts/process-recording-locally.js` | 로컬 전사 + 요약 (Vercel timeout 우회) |
| `scripts/upload-to-notion.js` | result.json → Notion 페이지 (수동 검수 후) |
| `scripts/split-audio-segments.js` | ffmpeg로 사후 5분 분할 (로컬 복구용) |
| `scripts/download-session-audio.js` | Vercel Blob → 로컬 webm 다운로드 |
| `scripts/extract-term-candidates.js` | 전사 빈도 → 유의어 후보 추출 |
| `scripts/preview-summarize-prompt.js` | 요약 프롬프트 구성 미리보기 (API 호출 X) |

---

## 환경변수

| 변수 | 용도 | 필수 |
|------|------|------|
| `GEMINI_API_KEY` | Google AI Studio 발급 | ✅ |
| `NOTION_TOKEN` | Notion Integration 토큰 | ✅ |
| `NOTION_DATABASE_ID` | 자동 회의록 DB ID | ✅ |
| `NOTION_GLOSSARY_DB_ID` | 용어집 DB ID | ⚪ (없으면 용어집 없이 요약) |
| `NOTION_SYNONYM_DB_ID` | 유의어 DB ID (로컬 스크립트만) | ⚪ |
| `NOTION_GUIDE_PAGE_ID` | 회의록 작성 가이드 페이지 (로컬 스크립트만) | ⚪ |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob (배포 시 자동) | ✅ |
