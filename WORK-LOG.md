# 회의록 복구 작업 로그

> **맥락**: 2026-04-16, Android Chrome PWA에서 녹음한 70분짜리 회의가 Vercel 서버리스 처리 중 `FUNCTION_INVOCATION_TIMEOUT`으로 실패. 복구 과정에서 Gemini API + Vercel Hobby 플랜의 여러 한계를 만나며 10번의 PR로 점진적 개선.

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

## 🎓 핵심 교훈

### Gemini API 실전 지식 (이번 프로젝트로 얻은 것)

1. **`videoMetadata`는 video 전용** — audio에 쓰면 silently ignored (에러 없음)
2. **Gemini 2.5 Flash thinking은 기본 ON** — 단순 작업엔 `thinkingBudget: 0`로 꺼야 출력 토큰 확보
3. **Flash는 "긴 입력 + structured output" 조합에 취약** — 503 지속 반환. Pro로 fallback 필요
4. **Files API 오디오 지원**: webm/opus, ogg, mp3, wav, flac, aac 등. webm/opus도 OK
5. **`videoDuration` 메타데이터는 audio 파일엔 없음** (audio용 `audioMetadata`는 미지원)

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

## 🚧 현재 상태 (2026-04-16 작성 시점)

### ✅ 완료
- 원본 오디오 로컬 백업 (`recovered-79d6ce87.webm`, 14.36 MB)
- 전사문 생성 (`recovered-79d6ce87.transcript.txt`, 126,754 chars)
- 구조화 요약 JSON 생성 (`recovered-79d6ce87.result.json`)
- Vercel PWA의 짧은 회의(~30분 이하) 정상 동작 (PR #4로 안정화)

### 🔴 발견된 문제 (현재 작업 대상)
- **전사 내용 자체의 품질 의심**: 사용자 검수 중 전사문 내용이 실제 회의와 일치하지 않음을 발견
- 이로 인해 요약도 잘못된 기반 위에 생성됨

### 📋 조사 필요
1. 전사문의 어느 부분이 틀렸는지 (부분적 오류? 전체적 문제?)
2. 원인 가설:
   - Gemini 2.5 Flash가 63분 한국어 오디오를 제대로 이해 못함?
   - thinking 비활성화가 품질 저하로 이어졌나?
   - 오디오 품질(32kbps, 모바일 녹음) 자체 문제?
3. 대안 검토:
   - **전사만** Pro로 전환 (`--transcribe-model=gemini-2.5-pro`)
   - 다른 STT 서비스 (Whisper, Clova 등) 병행 비교
   - 오디오 전처리 (noise reduction, normalization)
4. 녹음된 실제 음성 vs 전사 비교 샘플 수집

---

## 🗂️ 관련 파일

| 파일 | 역할 |
|------|------|
| `api/process-meeting.js` | Vercel 서버리스 (PWA용 5단계 파이프라인) |
| `meeting-notes/app.js` | PWA 클라이언트 녹음 + 업로드 |
| `meeting-notes/recover.html` | 실패한 세션 재처리 페이지 |
| `scripts/download-session-audio.js` | Vercel Blob → 로컬 webm |
| `scripts/process-recording-locally.js` | 로컬 전사 + 요약 (Gemini 직접) |
| `scripts/upload-to-notion.js` | JSON → Notion 페이지 |
| `RECOVERY-PLAN.md` | 4단계 복구/개선 계획 |
| `WORK-LOG.md` | **이 문서** — 상세 작업 히스토리 |

---

## 📝 다음 세션에서 이어갈 때

1. **먼저 읽을 파일**: 이 문서 (WORK-LOG.md) + RECOVERY-PLAN.md
2. **현재 작업 컨텍스트**:
   - 70분 회의 복구가 "기술적으로는" 성공했으나 **전사 품질이 낮음**
   - 사용자가 로컬에서 전사문 확인 후 품질 판단 대기 중
3. **미결 과제**:
   - Step 4 (MediaRecorder 10분 세그먼트 분할 녹음) — 아직 미구현
   - 전사 품질 개선 전략 수립 (모델 변경 / STT 서비스 변경 / 오디오 전처리)
4. **브랜치 상태**: `main`이 PR #10까지 반영 상태. 추후 작업은 `claude/fix-meeting-recorder-error-cH1bD` 브랜치 계속 사용.
