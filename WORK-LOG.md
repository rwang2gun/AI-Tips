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


- [PR #1 — 3단계 분할 + 복구 페이지 (첫 시도)](work_log_pr_01.md)
- [PR #2 — 전사/요약 단계 분리](work_log_pr_02.md)
- [PR #3 — videoMetadata 세그먼트 전사 (**실패한 시도**)](work_log_pr_03.md)
- [PR #4 — videoMetadata 원복](work_log_pr_04.md)
- [PR #5 — 로컬 처리 스크립트 추가](work_log_pr_05.md)
- [PR #6 — undici headers timeout 제거](work_log_pr_06.md)
- [PR #7 — maxOutputTokens 상향 + 진단 로깅](work_log_pr_07.md)
- [PR #8 — thinking 모드 비활성화 (**결정적 돌파구**)](work_log_pr_08.md)
- [PR #9 — Gemini 503/429 자동 재시도](work_log_pr_09.md)
- [PR #10 — 요약 단계만 Pro로 전환](work_log_pr_10.md)
- [PR #11 — WORK-LOG.md 작성](work_log_pr_11.md)
- [PR #12 — 5분 세그먼트 분할(로컬) + 유의어 DB + 전사 원문 Notion 첨부](work_log_pr_12.md)
- [PR #13 — 앱 버전 배지](work_log_pr_13.md)
- [PR #14 — 회의록 레이아웃 정리 + 작성 가이드 Notion 연동](work_log_pr_14.md)
- [PR #15 — 녹음 단계 5분 분할 (근본 해결) + topic 2차 압축 + 진단 자료](work_log_pr_15.md)

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
