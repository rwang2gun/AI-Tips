# 회의록 복구 + 향후 개선 계획

## 📌 현재 상황 요약

### 문제
- **70분짜리 회의 녹음(sessionId: `79d6ce87-b802-4384-977f-48ff191ac3b3`)이 서버리스 처리 중 `FUNCTION_INVOCATION_TIMEOUT` 으로 실패**.
- 오디오 청크(총 15.1 MB, 5개)는 Vercel Blob에 그대로 남아 있음 → 복구 가능.

### 지금까지 시도했던 것과 실패 원인
| 시도 | 결과 | 원인 |
|------|------|------|
| 단일 `process` 액션 | Timeout | 결합+업로드+Gemini+Notion을 60초 안에 못 끝냄 |
| 3단계 분할 (prepare → check-file → finalize) | Timeout | finalize 내의 Gemini 단일 호출이 60초+ 소요 |
| 5단계 분할 (transcribe 분리) | Timeout | 오디오 전체를 한 번에 전사하는 Gemini 호출이 60초+ |
| **6단계 분할 (transcribe를 세그먼트화)** | **Timeout** | **`videoMetadata.startOffset/endOffset`이 audio 파일에는 작동 안 함 → Gemini가 오프셋 무시하고 전체 처리** |

### 결정적 근거 (Vercel 로그)
- Execution Duration: **1m / 1m** (정확히 한도 초과)
- External API: `POST generativelanguage.googleapis.com/.../generateContent` 단 한 번, 끝까지 미완료
- Peak Memory: 394 MB / 2048 MB (메모리는 여유, 함수 코드는 문제 없음)

### 공식 확인
- `videoMetadata`는 video 파일 전용, audio에는 silently ignored
- audio용 `audioMetadata`는 **Feature Request만 열려 있고 미지원**
- 참고: [Google Feature Request — audioMetadata](https://discuss.ai.google.dev/t/feature-request-adding-audiometadata-support-in-google-ai-files-api/39869)

---

## ✅ Step 1 — 원본 녹음 로컬 백업 (완료된 작업)

`scripts/download-session-audio.js` 스크립트 작성 완료. 향후 요약 결과 수정/재생성이 필요할 때를 대비해 원본 오디오를 안전하게 확보.

### 실행 방법
```bash
# 1) Vercel Dashboard → Storage → meeting-audio → .env.local 탭에서 토큰 복사
export BLOB_READ_WRITE_TOKEN="vercel_blob_rw_..."

# 2) 스크립트 실행
node scripts/download-session-audio.js 79d6ce87-b802-4384-977f-48ff191ac3b3

# → ./recovered-79d6ce87.webm 생성됨
```

⚠️ **중요**: `recovered-*.webm` 파일은 민감 정보가 포함될 수 있으니 git에 커밋하지 말 것 (`.gitignore`에 `*.webm` 추가 권장).

---

## 🔧 Step 2 — 잘못된 `videoMetadata` 코드 원복

현재 `api/process-meeting.js`와 클라이언트에 세그먼트 기반 전사 코드가 있지만 작동하지 않음. 짧은 회의(20분 이하)도 쓸데없이 세그먼트 12개로 나눠 느려짐.

### 원복 범위
- `handleTranscribe`: segmentIndex/offset 파라미터 제거, 단일 `transcript.txt` 생성으로 돌리기
- `handleSummarize`: `transcript-` 프리픽스 조회 → `transcript.txt` 단일 파일 조회로
- `handlePrepare` / `handleCheckFile`: `durationSec` / `sizeBytes` 응답 제거 (불필요해짐)
- `meeting-notes/app.js` / `recover.html`: transcribe 루프 제거, 단일 호출로
- 헤더 주석 업데이트 (5단계로 표기)

### 기대 효과
- 짧은 회의(20분 이하)는 기존대로 정상 작동
- 긴 회의는 여전히 실패 → Step 4에서 근본 해결

---

## 🧪 Step 3 — 현재 70분 녹음 복구 (로컬 스크립트)

Vercel 60초 한도를 우회해 로컬에서 직접 Gemini/Notion을 호출해 회의록 생성.
**Notion 저장은 전사문/요약 JSON 검수 후 수동 단계**로 분리 (결과 수정 가능).

### 스크립트 (작성 완료)

| 파일 | 역할 |
|------|------|
| `scripts/process-recording-locally.js` | 오디오 → 전사문(`.transcript.txt`) + 구조화 요약(`.result.json`) |
| `scripts/upload-to-notion.js` | 검수한 `.result.json` → Notion 페이지 생성 |

### 로컬 환경 세팅

1) 저장소 클론 후 의존성 설치:
```bash
git clone <repo> && cd AI-Tips
npm install
```

2) 프로젝트 루트에 `.env` 생성:
```
# Gemini (AI Studio에서 발급)
GEMINI_API_KEY=AIzaSy...

# Vercel Blob (오디오 다운로드용)
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...

# Notion (페이지 생성 + 용어집)
NOTION_TOKEN=secret_...
NOTION_DATABASE_ID=343b23cf-3720-805a-885a-ef6795242b77
NOTION_GLOSSARY_DB_ID=...  # 선택
```

### 실행 순서

```bash
# 1) Vercel Blob에서 70분 오디오 다운로드 (이미 백업 완료된 경우 스킵)
node --env-file=.env scripts/download-session-audio.js 79d6ce87-b802-4384-977f-48ff191ac3b3

# 2) 전사 + 요약 (Notion 저장 X)
node --env-file=.env scripts/process-recording-locally.js recovered-79d6ce87.webm

# → 아래 두 파일 생성:
#    recovered-79d6ce87.transcript.txt  (전사문, 편집 가능)
#    recovered-79d6ce87.result.json     (요약 JSON, 편집 가능)

# 3) 검수/편집 후 Notion 저장
node --env-file=.env scripts/upload-to-notion.js recovered-79d6ce87.result.json
```

### 재실행 동작

- `recovered-*.transcript.txt`가 이미 있으면 **전사 건너뜀** (summarize만 재실행)
- `recovered-*.result.json`이 이미 있으면 **요약도 건너뜀** (preview만 출력)
- 강제 재실행: `--force-retranscribe` / `--force-resummarize`

### 장점
- Vercel 타임아웃 없음 → 70분이든 3시간이든 처리 가능
- 전사문 + 요약 JSON을 중간에 검수/편집 가능 (Notion 저장 전 확인)
- 요약만 다시 돌리기 쉬움 (프롬프트 실험 등)
- 0원 추가 비용 (Gemini/Notion 사용량만)

---

## 🏗️ Step 4 — 긴 회의를 위한 근본 해결 (녹음 시 세그먼트 분할) ✅ 완료

**목표**: 앞으로 녹음하는 긴 회의도 Vercel Hobby(60초 한도) 내에서 자동 처리 가능하게.

### 구현 결과
MediaRecorder를 **5분마다 stop/restart**해서 **독립적인 webm 파일 여러 개**로 녹음. 각 세그먼트를 segment 단위 파이프라인(prepare-segment → transcribe-segment → merge-transcripts)으로 처리.

> 원안은 10분이었으나 WORK-LOG.md PR #12 학습대로 5분이 단일 Gemini 전사 호출의 안전 기준치라서 5분으로 확정.

### 변경 사항

#### 클라이언트 (`meeting-notes/app.js`)
```
녹음 타이머:
  - 10분마다 MediaRecorder.stop() → blob 추출 → MediaRecorder.start() 재시작
  - 각 blob은 segment-<NNN>/chunk-<MMMM>.bin 으로 업로드
  - 녹음 종료 시 마지막 세그먼트도 업로드

처리 플로우:
  1. upload-chunk (세그먼트별, 기존과 동일 경로 패턴)
  2. prepare-all → 각 세그먼트를 Gemini Files API에 병렬 업로드, fileUri 배열 반환
  3. check-file (세그먼트별, 병렬 가능)
  4. transcribe (세그먼트별, 순차 호출) → segment-NNN/transcript.txt
  5. summarize → 모든 세그먼트 전사문 합쳐서 요약
  6. finalize-notion → Notion 페이지 생성 + 세션 폴더 정리
```

#### 서버 (`api/process-meeting.js`)
- Blob 경로를 `meetings/<sid>/segment-<NNN>/chunk-<MMMM>.bin` 로 변경
- `prepare-all`: 모든 세그먼트 폴더를 iterate, 각각 Gemini 파일로 업로드, fileUri 배열 반환
- `transcribe`: 특정 세그먼트(segmentIndex)의 Gemini 파일을 처리 → `segment-NNN/transcript.txt`
- `summarize`: 모든 `segment-*/transcript.txt`를 정렬해서 합침
- `finalize-notion`: 세션 폴더 전체 삭제 (이전과 동일)

### 예상 동작 (70분 기준)
- 10분 세그먼트 7개 → 각 세그먼트 Gemini 처리 20~30초 (독립 webm 파일이라 빠름)
- 각 API 호출 60초 내 완료 보장

### 주의 사항
- MediaRecorder restart 시 찰나의 음성 누락 가능 (Web Audio API로 gapless 녹음 구현도 가능하지만 복잡)
- 첫 번째 시도로는 단순 stop/restart 방식으로 시작

---

## 📊 우선순위와 실행 순서

| 순서 | 작업 | 예상 소요 | 상태 |
|------|------|-----------|------|
| 1 | 원본 녹음 로컬 백업 (Step 1) | 2분 (토큰 설정 + 스크립트 실행) | ✅ 스크립트 준비 완료 |
| 2 | `videoMetadata` 코드 원복 (Step 2) | 15분 | ✅ PR #4로 머지 완료 |
| 3 | 로컬 스크립트로 70분 녹음 복구 (Step 3) | 사용자 실행 | ✅ 스크립트 준비 완료 — `process-recording-locally.js` + `upload-to-notion.js` |
| 4 | MediaRecorder 세그먼트 분할 녹음 (Step 4) | 2~3시간 | ✅ 완료 — 5분 segment 파이프라인 |

---

## ❓ 결정 포인트 (사용자에게 확인 필요)

1. **Step 2 원복 PR**을 지금 만들까, 아니면 Step 3까지 끝낸 후 한꺼번에?
2. **Step 4 구현 시점**: 바로 이어서 / Step 3으로 복구 완료 후 별개 진행 / 나중으로 미룸
3. **Step 3 로컬 스크립트**: 전사문 검수 지점(step 3 중간의 `(선택) 전사문 검수` 단계)을 넣을지 여부

---

## 🗂️ 관련 파일 참조

- `scripts/download-session-audio.js` — Step 1 스크립트 (완료)
- `scripts/process-recording-locally.js` — Step 3 스크립트 (예정)
- `api/process-meeting.js` — Step 2 원복 + Step 4 리팩토링 대상
- `meeting-notes/app.js` — Step 2 원복 + Step 4 리팩토링 대상
- `meeting-notes/recover.html` — Step 2 원복 대상
