# 회의록 복구 작업 로그

> **맥락**: 2026-04-16, Android Chrome PWA에서 녹음한 70분짜리 회의가 Vercel 서버리스 처리 중 `FUNCTION_INVOCATION_TIMEOUT`으로 실패. 복구 과정에서 Gemini API + Vercel Hobby 플랜의 여러 한계를 만나며 PR #1~#10으로 단건 복구. 이후 PR #11~#15로 운영 품질/근본 구조까지 확장 (2026-04-17).

---

## 🎯 원본 문제

- **세션 ID**: `79d6ce87-b802-4384-977f-48ff191ac3b3`
- **길이**: 약 63분 (녹음 시점 70분 추정했으나 Gemini는 63분으로 측정)
- **포맷**: audio/webm;codecs=opus, 32kbps mono, 15.06 MB
- **청크**: Vercel Blob에 5개 (chunk-0000.bin ~ chunk-0004.bin)
- **최초 에러**: 단일 `process` 액션이 Vercel Hobby 60초 한도 초과
- **Vercel 로그**: `External API: POST generativelanguage.googleapis.com/.../generateContent` 단 한 번이 60초 풀 점유

---

## 📜 시도 히스토리 (시간순)

### PR #1 — 3단계 분할 + 복구 페이지 (첫 시도)

**가설**: 결합+업로드+Gemini+Notion이 60초에 안 맞으니 3개 액션으로 쪼개면 된다.

**구현**:
- `prepare`: 청크 결합 + Gemini Files API 업로드 (ACTIVE 대기 X)
- `check-file`: 클라이언트가 파일 상태 폴링
- `finalize`: Gemini 전사+요약 동시 처리 + Notion 페이지 생성
- `meeting-notes/recover.html`: 실패한 세션 재처리용 페이지

**결과**: 🟡 `finalize` 단계에서 **여전히 타임아웃**. 단일 Gemini 호출(audio→structured JSON)이 60초 초과.

---

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

---

### PR #3 — videoMetadata 세그먼트 전사 (**실패한 시도**)

**가설**: Gemini Files API의 `videoMetadata.startOffset/endOffset`으로 오디오 구간을 지정해 10분 단위로 쪼개면 각 호출이 짧아진다.

**구현**:
- `transcribe` 호출에 `videoMetadata: { startOffset: "Ns", endOffset: "Ms" }` 주입
- 클라이언트가 `durationSec / 600` 회 반복 호출

**결과**: ❌ **완전 실패**. Gemini가 오프셋을 **silently ignore** (video 전용이라 audio엔 효과 없음). 매 호출마다 전체 오디오 처리 → 60초 초과.

**중요한 교훈**:
- 📌 [Gemini Files API는 audio에 `videoMetadata`를 지원하지 않음 (feature request만 열려 있음)](https://discuss.ai.google.dev/t/feature-request-adding-audiometadata-support-in-google-ai-files-api/39869)
- 📌 [video_metadata SDK 이슈](https://github.com/googleapis/python-genai/issues/854)
- 📌 가정을 실제 API 동작으로 검증하지 않고 구현한 것이 잘못. 공식 문서에 "video 전용"이라고 분명히 적혀 있었음.

---

### PR #4 — videoMetadata 원복

**조치**: PR #3 변경사항을 전부 원복. `handleTranscribe`/`handleSummarize`/클라이언트 단일 호출로 복귀. 헤더 주석에 [한계] 섹션 추가 (audio에 videoMetadata 안 됨).

**Vercel 서버리스 한계 수용**: Vercel Hobby 플랜(60초)에서는 30분 이상 회의 단일 처리 불가능. 근본 해결은 녹음 단계 분할 (Step 4: MediaRecorder 10분 세션 분할).

---

### PR #5 — 로컬 처리 스크립트 추가

**방향 전환**: Vercel 우회해서 로컬 Node.js에서 Gemini 직접 호출. Vercel timeout 무관.

**구현**:
- `scripts/download-session-audio.js` — Vercel Blob 청크 다운로드 → `recovered-<sid>.webm`
- `scripts/process-recording-locally.js` — 오디오 → 전사문 + 요약 JSON (Notion 미저장)
- `scripts/upload-to-notion.js` — 검수한 JSON → Notion 페이지 생성
- `.env.example` 업데이트 (BLOB_READ_WRITE_TOKEN)
- `.gitignore`에 `recovered-*.webm` 등 추가 (민감 정보 보호)

---

### PR #6 — undici headers timeout 제거

**문제**: 63분 오디오 전사 시 Gemini 응답이 5분 넘게 걸려 Node 20의 fetch가 쓰는 undici의 기본 `headersTimeout`(300초)에 걸림.

**해결**:
```js
import { Agent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));
```
CLI 스크립트라 무제한 안전 (사용자가 Ctrl+C 가능).

---

### PR #7 — maxOutputTokens 상향 + 진단 로깅

**문제**: 전사 성공했다고 나오지만 실제로는 빈 응답 반환.

**1차 가설**: 출력 토큰 한도 8192가 60분 전사 분량(20~30K)보다 작아서 `MAX_TOKENS`로 잘림.

**해결 시도**:
- `config: { maxOutputTokens: 65536 }` 명시 (Flash 모델 최대치)
- 빈 응답 시 Gemini 응답 구조 덤프 (finishReason, safetyRatings, promptFeedback, usageMetadata)

**결과**: 🟡 여전히 빈 응답. 하지만 진단 로깅으로 `finishReason: MAX_TOKENS` 확인 — 한도 올렸는데 왜 여전히 MAX_TOKENS?

---

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

---

### PR #9 — Gemini 503/429 자동 재시도

**문제**: 전사 성공 후 summarize 단계에서 `HTTP 503 UNAVAILABLE` ("high demand") 반환. 두 번 연속.

**해결**: `withRetry` 헬퍼 추가
- 503/429/500 + "overloaded"/"UNAVAILABLE"/"RESOURCE_EXHAUSTED" 메시지 매칭 시 재시도
- 지수 백오프: 2s → 4s → 8s → 16s → 32s (최대 5회, 총 ~62초 대기)
- transcribe/summarize 양쪽 호출 모두 감쌈

**결과**: 🔴 Summarize가 6회 재시도 모두 503. 일시적 혼잡 아닌 지속적 거절.

---

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

---

### PR #11 — WORK-LOG.md 작성

이 문서 자체. 단건 복구가 끝난 시점에 PR #1~#10의 시행착오와 교훈을 정리. 이후 PR에서 "작성 가이드", "파이프라인 문서"와 역할 분리.

---

### PR #12 — 5분 세그먼트 분할(로컬) + 유의어 DB + 전사 원문 Notion 첨부

**발견한 새 문제**: 63분 단일 전사 시 Gemini가 generation loop에 빠져 **같은 문장을 70회 반복** 출력. 전사 "내용 자체 품질 저하"의 실체였음.

**구현**:
- `scripts/split-audio-segments.js`: ffmpeg `-c copy`로 5분 단위 stream copy 분할 (재인코딩 없음, 빠름)
- `scripts/process-recording-locally.js`
  - 줄바꿈 후처리: Gemini가 규칙 무시 시 강제 개행
  - `--transcribe-only` 플래그: 세그먼트별 전사 워크플로우 지원
  - **유의어 DB 양단 연동** (NOTION_SYNONYM_DB_ID):
    - 전사 프롬프트엔 **정답 용어만** 주입 (오답을 보여주면 프라이밍 역효과)
    - 전사 후처리: 한글 단어 경계 regex로 "무조건 치환"
    - 요약 프롬프트엔 오인식→정답 **매핑 전체** 주입 → Pro가 맥락 기반으로 전사 오류 복구
- `scripts/upload-to-notion.js`
  - `--transcript` 인자 추가
  - Notion File Upload API 3단계(create → send → attach) 직접 호출
  - 페이지 하단에 `전사원문_{date}_{title}.txt` 파일 블록 첨부 → 사후 품질 검토 가능
- `scripts/extract-term-candidates.js`: 전사 빈도 집계로 유의어 후보 추출 (DB 초기 구축용)
- `scripts/preview-summarize-prompt.js`: API 호출 없이 요약 프롬프트 구성 확인

**중요한 교훈**:
- 📌 긴 오디오 단일 전사 시 **generation loop** 발생 — "thinking OFF + maxOutputTokens 최대"만으로는 부족, 입력 자체를 짧게 잘라야 함
- 📌 유의어 프라이밍은 **정답만** 보여줄 것 — 오답 포함 시 모델이 오답을 선택하는 역효과

---

### PR #13 — 앱 버전 배지

**문제**: 코드 수정 후 "실제 배포에 반영됐는지" 즉시 확인할 수단이 없어 잘못된 캐시/버전으로 디버깅하는 실수 반복.

**구현**:
- `api/version.js`: Vercel 환경변수(`VERCEL_GIT_COMMIT_SHA/REF/ENV`)로 버전 JSON 반환. 모듈 cold-start 시각을 배포일 근사값으로 사용. `Cache-Control: no-store`.
- `shared/version-badge.js`: 공통 삽입 스크립트. 우하단 fixed 칩 생성 후 `/api/version` fetch해 채움.
- 5개 페이지에 `<script defer>` 주입: index / meeting-notes / claude-notion-guide / claude-notion-personal-guide / meeting-notes-deck

**버전 표시 규칙**:
- production: `{YYYY-MM-DD} · {sha7}`
- preview: `preview · {sha7}` (주황)
- dev/local: `dev` / offline: `offline` (회색)

---

### PR #14 — 회의록 레이아웃 정리 + 작성 가이드 Notion 연동

**문제 1**: 회의록 페이지가 **파란 콜아웃 덩어리**로만 보여 가독성 저하.
**문제 2**: `topic` 필드가 실질적으로 **아젠다 나열식**(같은 내용이 topic과 agenda에 중복)으로 생성됨.

**구현**:
- **레이아웃** (`upload-to-notion.js`):
  - 메타(기본정보/후속진행): blue_background → gray_background 콜아웃
  - 본문 4섹션: callout 제거 → `heading_2` + bullets
  - 논의 사항: 토픽을 `heading_3`로 승격, 포인트는 평평한 bullets
  - divider로 메타/본문/첨부 3영역 명확히 구분
- **가이드 Notion 연동** (`process-recording-locally.js`):
  - `NOTION_GUIDE_PAGE_ID`에 "회의록 작성 가이드" 페이지 두고 요약 단계에서 자동 로드
  - `fetchGuide()`: 페이지 블록을 markdown-like 평문으로 변환 (heading/paragraph/list/quote/divider/callout/table)
  - 프롬프트에 `[회의록 작성 가이드]` 섹션 주입, 규칙 0번에 "가이드 우선" 명시
  - 결과: **코드 수정 없이 Notion에서만 규칙 튜닝 가능**
- `meetingSchema().topic` description 강화: "50자 이내, 아젠다 나열 금지" (Pro는 schema description을 매우 중시함)

**검증 상태**: 가이드 연동 후 agenda 빈 배열 → 4개 항목으로 자동 재구성 **실증 완료**. topic 간결화는 Pro 503 연속 실패로 **당일 재검증 실패** → PR #15에서 2-pass 방식으로 보강.

---

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

---

## 🎓 핵심 교훈

### Gemini API 실전 지식 (이번 프로젝트로 얻은 것)

1. **`videoMetadata`는 video 전용** — audio에 쓰면 silently ignored (에러 없음)
2. **Gemini 2.5 Flash thinking은 기본 ON** — 단순 작업엔 `thinkingBudget: 0`로 꺼야 출력 토큰 확보
3. **Flash는 "긴 입력 + structured output" 조합에 취약** — 503 지속 반환. Pro로 fallback 필요
4. **Files API 오디오 지원**: webm/opus, ogg, mp3, wav, flac, aac 등. webm/opus도 OK
5. **`videoDuration` 메타데이터는 audio 파일엔 없음** (audio용 `audioMetadata`는 미지원)
6. **긴 오디오 단일 전사 시 generation loop 발생** — 같은 문장 반복 출력. thinking OFF로도 해결 안 됨, 입력 자체를 잘라야 함 (PR #12)
7. **용어 프라이밍은 정답만** — 오인식/정답 쌍을 함께 보여주면 모델이 오인식 표현을 선택하는 역효과. 정답 용어만 전사 프롬프트에 넣고, 요약 단계에서 맥락 복구 (PR #12)
8. **schema description은 Pro가 매우 중시** — topic 제약("50자 이내, 아젠다 나열 금지")을 스키마에 명시하면 준수율 높음 (PR #14)
9. **긴 요약은 2-pass로** — 큰 입력+큰 출력+엄격한 제약을 한 번에 요구하기보다, 큰 요약 이후 작은 2차 호출로 특정 필드만 재압축 (PR #15)

### Node.js 실전 지식

1. **undici 기본 `headersTimeout` 300초** — 5분 넘는 API 응답은 `setGlobalDispatcher(new Agent({ headersTimeout: 0 }))` 필요
2. **503/429는 자동 재시도 + 지수 백오프 필수** — CLI 스크립트도 예외 없음

### Vercel Hobby 플랜 한계

1. **60초 함수 실행 한도** — 변경 불가 (Pro 업그레이드해야 300초)
2. **30분 이상 오디오는 단일 Gemini 호출로 처리 불가** — 녹음 단계에서 분할이 근본 해결 (Step 4)
3. **청크 기반 업로드 유효 — 하지만 결합된 단일 파일 처리는 Hobby 한계**

### 프로세스 교훈

1. **가정 검증 없이 구현하지 말 것** — PR #3 (videoMetadata)은 공식 문서에 "video 전용"이라 적혀 있었는데 오디오에도 작동한다고 가정하고 구현했다가 전량 폐기
2. **Vercel Function 로그가 최고의 진단 도구** — "external API 하나가 60초 점유" 정보로 Gemini 쪽 시간 소비 확정
3. **중간 산출물 파일 저장이 회복 핵심** — 전사문이 `recovered-*.transcript.txt`에 남아 있어서 503 재시도 시 토큰 낭비 없이 summarize만 재실행 가능
4. **모델 선택은 작업 특성에 맞춰** — 단순 전사는 Flash + thinking OFF, 구조화 요약은 Pro

---

## 📊 토큰 사용량 요약

| 시도 | 입력 | 출력 | 성공 여부 | 예상 비용 |
|------|-----|------|----------|----------|
| Vercel 시도 1 (timeout) | 135K | 0 | ❌ | 30원 |
| Vercel 시도 2 (timeout) | 135K | ? | ❌ | 30원 |
| Vercel 시도 3 (MAX_TOKENS) | 135K | 0 | ❌ | 30원 |
| 로컬 1 (headers timeout) | 135K | ? | ❌ | 30원 |
| 로컬 2 (MAX_TOKENS) | 135K | 0 | ❌ | 30원 |
| 로컬 3 (thinking OFF) | 135K | 20K | ✅ | 60원 |
| 로컬 4 (503 재시도 실패) | 31K | 0 | ❌ | 30원 |
| 로컬 5 (Pro summarize) | 31K | 6K | ✅ | 150원 |
| **총합** | | | | **~390원** (실제 1,300원) |

차이는 Gemini Files API 업로드 오버헤드, 여러 번의 `files.get` 호출 등 부가 토큰으로 추정.

---

## 🚧 현재 상태 (2026-04-17 갱신)

### ✅ 완료
- **단건 복구** (2026-04-16): 원본 오디오 로컬 백업 / 전사문 / 요약 JSON 생성
- **전사 품질 문제 원인 확정** (PR #12): generation loop — 5분 분할로 해소
- **Vercel 60초 근본 해결** (PR #15): MediaRecorder 5분 세그먼트 녹음 + 서버 세그먼트 파이프라인. RECOVERY-PLAN.md Step 4 완료
- **운영 품질 개선**:
  - 유의어 DB 양단 연동 (PR #12)
  - 회의록 작성 가이드 Notion 외재화 (PR #14)
  - Notion 페이지 레이아웃 정리 (PR #14)
  - 앱 버전 배지로 배포 반영 확인 (PR #13)
- **진단 자료 구축** (PR #15):
  - 전사 원문 `.txt`를 회의록과 함께 Notion에 첨부
  - 항목별 `sourceQuote`로 환각 탐지 가능
- **문서 분리**: RECOVERY-PLAN / WORK-LOG / MEETING-NOTES-PIPELINE 역할 분리

### 🟡 미검증 / 관찰 필요
- **PR #15 실전 검증 부족**:
  - topic 2-pass 압축이 실제 회의에서 정상 동작하는지 재검증 미완 (PR #14 당일 Pro 503으로 실패)
  - PWA 5분 분할 녹음이 실전 70분 회의에서 끝까지 완주하는지 실사례 필요
- **sourceQuote 환각 탐지율**: "근거 없음" 표시가 실제 환각과 얼마나 일치하는지 사례 축적 필요

### ⚠️ 기술 부채
- **서버/로컬 헬퍼 중복**: `buildBlocks`, `buildEvidenceBlocks`, `uploadTranscriptToNotion` 등이 `api/process-meeting.js`와 `scripts/` 양쪽에 중복. 한쪽만 변경하면 동작 차이 발생 위험. 현재는 주석으로 동기화 필요 명시만 됨.
- **legacy 액션 보존**: `prepare`/`transcribe` (단일 파일용)이 `recover.html` 기존 실패 세션 복구용으로 남아 있음. 구 세션 모두 정리되면 제거 가능.

---

## 🗂️ 관련 파일

### 런타임
| 파일 | 역할 |
|------|------|
| `api/process-meeting.js` | Vercel 서버리스 (PWA용 7단계 파이프라인 + legacy 3단계) |
| `api/version.js` | 배포 버전 JSON (PR #13) |
| `meeting-notes/app.js` | PWA 클라이언트 녹음(5분 세그먼트) + 업로드 |
| `meeting-notes/recover.html` | 실패한 세션 재처리 페이지 (legacy 경로) |
| `shared/version-badge.js` | 모든 페이지 우하단 버전 배지 (PR #13) |

### 스크립트
| 파일 | 역할 |
|------|------|
| `scripts/download-session-audio.js` | Vercel Blob → 로컬 webm |
| `scripts/split-audio-segments.js` | ffmpeg 5분 분할 (PR #12) |
| `scripts/process-recording-locally.js` | 로컬 전사 + 요약 (Gemini 직접) |
| `scripts/upload-to-notion.js` | JSON → Notion 페이지 + 전사 첨부 |
| `scripts/extract-term-candidates.js` | 전사 빈도 기반 유의어 후보 추출 (PR #12) |
| `scripts/preview-summarize-prompt.js` | API 호출 없이 요약 프롬프트 검토 (PR #12) |

### 문서
| 파일 | 역할 |
|------|------|
| `RECOVERY-PLAN.md` | 4단계 복구/개선 계획 (Step 4 완료) |
| `MEETING-NOTES-PIPELINE.md` | 현재 동작 파이프라인 단계별 명세 (PR #15) |
| `WORK-LOG.md` | **이 문서** — 상세 작업 히스토리 |

### 환경변수
- `GEMINI_API_KEY`, `NOTION_API_KEY`, `NOTION_DATABASE_ID`, `BLOB_READ_WRITE_TOKEN`
- `NOTION_SYNONYM_DB_ID` (PR #12) — 유의어 DB
- `NOTION_GUIDE_PAGE_ID` (PR #14) — 회의록 작성 가이드 페이지

---

## 📝 다음 세션에서 이어갈 때

1. **먼저 읽을 파일**:
   - `MEETING-NOTES-PIPELINE.md` (현재 동작 구조)
   - `WORK-LOG.md` (이 문서, 시행착오/교훈)
   - `RECOVERY-PLAN.md` (Step 1~4 계획 대비 진척)
2. **현재 작업 컨텍스트**:
   - 단건 복구 완료 + 근본 구조(5분 분할 녹음) 반영 + 진단 자료(전사 첨부 + sourceQuote) 구축까지 도달
   - 실전 회의에서의 **end-to-end 검증**이 다음 관문
3. **우선 확인 과제**:
   - 실전 70분 이상 회의로 PR #15 파이프라인 완주 검증
   - topic 2-pass 압축 실제 결과 품질 (아젠다 나열식에서 한 줄 주제로 실제 바뀌는지)
   - sourceQuote 누락 항목이 실제 환각과 얼마나 일치하는지 몇 건 샘플 분석
4. **여유 있을 때 정리**:
   - 서버/로컬 헬퍼 중복 (`buildBlocks` 등) 공통 모듈로 추출
   - legacy `prepare`/`transcribe` 액션 제거 (구 실패 세션 모두 복구된 이후)
5. **브랜치 상태**: `main`이 PR #15까지 반영 (커밋 `34ec94a`).
