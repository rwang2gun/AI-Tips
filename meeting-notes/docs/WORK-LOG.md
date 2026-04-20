# 회의록 복구 작업 로그

> **맥락**: 2026-04-16, Android Chrome PWA에서 녹음한 70분짜리 회의가 Vercel 서버리스 처리 중 `FUNCTION_INVOCATION_TIMEOUT`으로 실패. 복구 과정에서 Gemini API + Vercel Hobby 플랜의 여러 한계를 만나며 PR #1~#10으로 단건 복구. 이후 PR #11~#15로 운영 품질/근본 구조까지 확장. 2026-04-17 저녁 두 번째 실전 실패(세션 78ef84bf, 45분 회의 9/14 실패) + 발표 자료 전면 개편 + 서버 드리프트 수정 + 루트 문서 23개를 `meeting-notes/docs/`로 정리 등 post-PR#15 직접 커밋으로 이어짐.

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


- [PR #1 — 3단계 분할 + 복구 페이지 (첫 시도)](work-log-archive/work_log_pr_01.md)
- [PR #2 — 전사/요약 단계 분리](work-log-archive/work_log_pr_02.md)
- [PR #3 — videoMetadata 세그먼트 전사 (**실패한 시도**)](work-log-archive/work_log_pr_03.md)
- [PR #4 — videoMetadata 원복](work-log-archive/work_log_pr_04.md)
- [PR #5 — 로컬 처리 스크립트 추가](work-log-archive/work_log_pr_05.md)
- [PR #6 — undici headers timeout 제거](work-log-archive/work_log_pr_06.md)
- [PR #7 — maxOutputTokens 상향 + 진단 로깅](work-log-archive/work_log_pr_07.md)
- [PR #8 — thinking 모드 비활성화 (**결정적 돌파구**)](work-log-archive/work_log_pr_08.md)
- [PR #9 — Gemini 503/429 자동 재시도](work-log-archive/work_log_pr_09.md)
- [PR #10 — 요약 단계만 Pro로 전환](work-log-archive/work_log_pr_10.md)
- [PR #11 — WORK-LOG.md 작성](work-log-archive/work_log_pr_11.md)
- [PR #12 — 5분 세그먼트 분할(로컬) + 유의어 DB + 전사 원문 Notion 첨부](work-log-archive/work_log_pr_12.md)
- [PR #13 — 앱 버전 배지](work-log-archive/work_log_pr_13.md)
- [PR #14 — 회의록 레이아웃 정리 + 작성 가이드 Notion 연동](work-log-archive/work_log_pr_14.md)
- [PR #15 — 녹음 단계 5분 분할 (근본 해결) + topic 2차 압축 + 진단 자료](work-log-archive/work_log_pr_15.md)

### 후속 작업 (post-PR#15 직접 커밋 · 2026-04-17 저녁)

PR 없이 main에 직접 반영된 커밋들. 실전 운영에서 드러난 이슈 대응 + 보조 자료 개편.

- [발표 자료 전면 개편 (16:9 + 내러티브 14장)](work-log-archive/work_log_deck_redesign.md) — 커밋 9bc51c2
- [세션 78ef84bf 실전 실패 · 복구 · 서버 가이드 반영](work-log-archive/work_log_session_78ef84bf.md) — 커밋 022900f(recover-session.js) + 038ed82(서버 fetchGuide)
- [문서 폴더 정리 — 루트 .md 23개를 meeting-notes/docs/로 이동](work-log-archive/work_log_docs_reorg.md) — 커밋 6123f22

### Phase F — 세그먼트 파이프라이닝 PR1 (클라이언트 · 2026-04-18)

- [세그먼트 파이프라이닝 PR1 (클라이언트)](work-log-archive/work_log_segment_pipelining_pr1.md) — `test/segment-pipelining` 브랜치 preview 검증 후 squash merge. 세션 코디네이터, AbortController 펜싱, Semaphore(N=2), fetchWithRetry, onstop fire-and-forget, finalize 인라인 재시도
- [finalize 재시도 강화 + Vercel Blob 페이지네이션 버그 수정](work-log-archive/work_log_finalize_retry.md) — `test/finalize-retry` 브랜치 squash merge. summarize 단계 retry 5회×30s cap, `listAllBlobs` 헬퍼, 실전 테스트에서 발견된 버그 2건 + iPad PWA 킬 → 세션 재개 PR 우선순위 상승 근거

### 보안 — 외부 유입 사건 + 앱 접근 게이트 (2026-04-18 저녁)

- [앱 레벨 접근 게이트 (APP_ACCESS_TOKEN) + 외부 유입 사건 대응](work-log-archive/work_log_security_access_gate.md) — `security/app-access-gate` 브랜치 squash merge (커밋 5520fd4 + 00e3964). Blob 조사 중 외부 사용자 3건 녹음 발견(법률 상담, 서울시 공공회의 등) → Vercel Free 플랜 Standard Protection이 Preview만 덮고 Production은 공개라는 구조 문제 확인 → 앱 레벨 `x-app-token` 헤더 검증(서버 401) + localStorage 기반 클라 게이트(입력 UI + 401 시 리셋). 블롭 정리 스크립트 2종(`cleanup-blob-session.js`/`list-blob-sessions.js`) 추가. 본인 실패 세션 2건 포함 총 22 파일/23.73 MB 정리.

### 서버 Pro 전환 + UI 토글 + 진단 매니페스트 (2026-04-19 main 머지)

- **서버 summarize Flash→Pro + 완료 세그먼트 숨기기 토글** (커밋 `ac8c70e`) — `test/summarize-pro-and-fold-ui` 브랜치 rebase(보안 게이트와 `meeting-notes/app.js` 이벤트 리스너 구간 수동 해결) 후 squash merge. PR #10이 로컬만 Pro로 전환하고 서버 핸들러엔 미적용이었던 드리프트를 2026-04-18 실전 503 재현으로 근거 확보 후 보완. 세그먼트 많을 때(134+) 상단 에러/하단 재시도 버튼 거리 과도 문제를 `.segment-list.hide-done .seg-item.done` 한 줄 CSS 토글로 해소. Preview 단계에서 hide-done은 이전 세션에 이미 검증, Pro 모델은 rebase 후 별도 재검증 없이 머지(사용자 결정).
- **진행 로그(diagnostic manifest) Notion 첨부** (커밋 `4ffa238`) — `test/notion-diag-manifest` 브랜치 rebase 시 위 브랜치에 있던 3커밋(Pro·hide-done·cleanup 스크립트)은 패치 중복/동일 upstream으로 자동 drop, 실제 매니페스트 커밋만 남아 squash merge. `lib/notion/manifest.js` 신규 — `listAllBlobs`로 세션 Blob 나열 + 각 `transcript-NN.txt` 앞 60자 수집 → `진행로그_<date>_<title>.txt` 텍스트. finalize-notion이 cleanup 직전에 업로드해 Blob 삭제 후에도 사후 진단 가능. 클라 세션에 `startedAtIso`/`endedAtIso` 추가, summarize result.json에 `model` 필드 추가(Flash/Pro 드리프트 사후 확인). 본 기능은 Preview 검증 건너뛰고 머지(사용자 결정) — 실사용 시 진행로그 파일 생성 여부 확인 필요.

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
4. **Standard Protection은 Preview 한정** — "Enabled"만 보고 Production이 보호된다고 착각하기 쉬움. "All Deployments"는 Pro($20/mo), Password Protection은 $150/mo 추가. Free 플랜에서 Production 보호하려면 **앱 레벨 게이트**(`APP_ACCESS_TOKEN` 헤더 검증) 구현 필수. 공개 URL = API 접근이라 자원 소비 구조(Gemini/Notion 토큰)는 필수 방어. 2026-04-18 외부 유입 3건(법률 상담·서울시 공공회의 등) 실측으로 확인

### 프로세스 교훈

1. **가정 검증 없이 구현하지 말 것** — PR #3 (videoMetadata)은 공식 문서에 "video 전용"이라 적혀 있었는데 오디오에도 작동한다고 가정하고 구현했다가 전량 폐기
2. **Vercel Function 로그가 최고의 진단 도구** — "external API 하나가 60초 점유" 정보로 Gemini 쪽 시간 소비 확정. **단, Hobby는 1시간만 보존**이라 사후 분석 불가 (세션 78ef84bf 케이스) → 앱 레벨에서 Blob/외부 저장소에 에러 로깅 필요
3. **중간 산출물 파일 저장이 회복 핵심** — 전사문이 `recovered-*.transcript.txt`에 남아 있어서 503 재시도 시 토큰 낭비 없이 summarize만 재실행 가능
4. **모델 선택은 작업 특성에 맞춰** — 단순 전사는 Flash + thinking OFF, 구조화 요약은 Pro
5. **서버/로컬 구현 드리프트 주의** — 반복 패턴:
   - PR #14 가이드 연동이 로컬에만 들어가고 서버에 빠진 게 실전 회의록 품질 저하로 나타남 (agenda 0, topic 초과)
   - PR #10 summarize 모델 Flash→Pro 전환이 로컬만 반영 → 2026-04-18 [ac8c70e]에서 서버도 Pro로 통일
   - PR #12 유의어 사전 연동이 로컬 스크립트에만 들어가 있어 서버 전사·요약 모두 `synonymHint` 미주입 상태 → 2026-04-20 서버 양방향 반영으로 해소
   
   "코드 중복"이 아니라 "사용자 체감 품질이 경로에 따라 달라지는 버그". 기능 추가 시 양쪽 동시 반영 또는 공통 모듈 추출 기준 필요. **드리프트는 PR당 기본 점검 항목** — 새 Notion 참조/모델 선택/프롬프트 구성 변경 시 `api/handlers/*`와 `scripts/*` 양쪽 모두 확인
6. **Gemini 호출 명령 제안 전 known-bug 체크** — 세션 78ef84bf 복구 중 45분 단일 오디오 전사를 내(Claude)가 먼저 제안 → WORK-LOG PR #12 경고 시나리오 유도. 과금 API 명령 직전엔 WORK-LOG "알려진 한계"와 입력 조건 대조가 루틴

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

## 🚧 현재 상태 (2026-04-17 저녁 갱신)

### ✅ 완료
- **단건 복구 2건**: 79d6ce87 (63분 전체) + 78ef84bf (45분 부분, 9/14까지)
- **전사 품질 문제 원인 확정** (PR #12): generation loop — 5분 분할로 해소
- **Vercel 60초 근본 해결 구조** (PR #15): MediaRecorder 5분 세그먼트 녹음 + 서버 세그먼트 파이프라인
- **운영 품질 개선**:
  - 유의어 DB 양단 연동 (PR #12) — **서버 전사·요약 반영은 2026-04-20에서야 마무리** (드리프트 후속 해소)
  - 회의록 작성 가이드 Notion 외재화 (PR #14) — **서버 반영은 [038ed82]에서 뒤늦게 추가**
  - 서버 summarize 모델 Flash→Pro 통일 ([ac8c70e], 2026-04-18) — 로컬은 PR #10에서 이미 Pro
  - Notion 페이지 레이아웃 정리 (PR #14)
  - 앱 버전 배지로 배포 반영 확인 (PR #13)
- **진단 자료 구축** (PR #15): 전사 원문 첨부 + `sourceQuote` 환각 탐지
- **복구 유틸 확보** ([022900f]): `scripts/recover-session.js`로 세그먼트 구조 실패 세션 복구 가능
- **발표 자료 리뉴얼** ([9bc51c2]): 16:9 + 내러티브 14장, Notion embed 대응
- **문서 분리**: RECOVERY-PLAN / WORK-LOG / MEETING-NOTES-PIPELINE 역할 분리

### 🔴 실전에서 드러난 구조적 문제 (우선순위 높음)
- **upload-chunk 재시도 없음**: 단일 실패로 세션 전체 abort. 78ef84bf가 정확히 이 패턴
- **retry 버튼이 실제 재전송 아님**: `reset()`만 호출해 녹음 초기 화면으로. 인메모리 segments 활용 못함
- **세션 재개 불가**: 실패 지점부터 이어 처리 불가능 → 전체 재시작 또는 수동 `recover-session.js` 실행
- **Vercel Hobby 로그 1시간 보존**: 사후 원인 분석 못함 → 앱 레벨 에러 로깅 (세션 폴더에 `errors.log.json`) 필요

### 🟡 미검증 / 관찰 필요
- **topic 2-pass 실 효과**: 78ef84bf에서 가이드 있어도 55자 유지 (2-pass 시도했으나 더 짧지 않아 1차 유지). schema description + 가이드만으로 50자 강제하기 어려운 내용이 있음
- **sourceQuote 환각 탐지율**: 78ef84bf에서 수집됐으나 적중률 판정 미완
- **PWA 70분+ 완주**: 45분에서 실패 → 70분은 더 위험. 재시도 구조 없이는 확률 낮음
- **서버 유의어 주입 체감 효과 (2026-04-20 반영 후)**: 전사 프롬프트 힌트 + regex 후처리 + 요약 매핑 3단 주입이 실제 회의에서 오인식 감소로 이어지는지 관찰 필요. 로컬 스크립트 기준 효과는 PR #12에서 확인됐으나 서버는 첫 실전 회의에서 재검증

### ⚠️ 기술 부채
- ~~**서버/로컬 헬퍼 중복**: `buildBlocks`, `buildEvidenceBlocks`, `uploadTranscriptToNotion`, **`fetchGuide`/`renderPageBlocks`** 등 `api/process-meeting.js`와 `scripts/` 양쪽에 중복.~~ → **2026-04-18 Phase A~E 리팩터**에서 `lib/` 공통 모듈로 추출 완료. 다만 드리프트 이력 자체는 교훈으로 보존 (프로세스 교훈 #5)
- **드리프트 탐지 자동화 미비**: 공통 모듈로 추출했지만 "서버와 로컬이 Notion 참조 세트를 동일하게 쓰는지"는 여전히 수동 점검. 2026-04-20 유의어 사전 드리프트도 공통 모듈 추출 이후에 발견된 누락. lint/test 레벨에서 "서버 핸들러가 사용 가능한 hint builder를 전부 호출하는지" 검사 필요
- **legacy 액션 보존**: `prepare`/`transcribe` (단일 파일용)이 `recover.html` 기존 실패 세션 복구용으로 남아 있음

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
| `scripts/download-session-audio.js` | Vercel Blob → 로컬 webm (legacy 단일 폴더 세션용) |
| `scripts/recover-session.js` | seg-NN 구조 실패 세션 복구 + ffmpeg 병합 ([022900f]) |
| `scripts/split-audio-segments.js` | ffmpeg 5분 분할 (PR #12) |
| `scripts/process-recording-locally.js` | 로컬 전사 + 요약 (Gemini 직접) |
| `scripts/upload-to-notion.js` | JSON → Notion 페이지 + 전사 첨부 |
| `scripts/extract-term-candidates.js` | 전사 빈도 기반 유의어 후보 추출 (PR #12) |
| `scripts/preview-summarize-prompt.js` | API 호출 없이 요약 프롬프트 검토 (PR #12) |

### 문서 (전부 `meeting-notes/docs/` 하위, 커밋 6123f22로 정리됨)
| 파일 | 역할 |
|------|------|
| `meeting-notes/docs/HANDOFF.md` | Claude 세션 인계 (새 세션 시작 시 가장 먼저) |
| `meeting-notes/docs/SETUP.md` | 9단계 배포 체크리스트 |
| `meeting-notes/docs/MEETING-NOTES-PIPELINE.md` | 현재 7단계 파이프라인 단계별 명세 (PR #15) |
| `meeting-notes/docs/RECOVERY-PLAN.md` | 4단계 복구/개선 계획 (Step 4 완료) |
| `meeting-notes/docs/REFACTOR-PLAN.md` | 모듈 리팩터 계획 (Codex 리뷰 예정) |
| `meeting-notes/docs/WORK-LOG.md` | **이 문서** — 상세 작업 히스토리 (PR별 링크) |
| `meeting-notes/docs/work-log-archive/work_log_pr_*.md` | PR 1~15 각각의 상세 |
| `meeting-notes/docs/work-log-archive/work_log_*.md` | 이벤트별 상세 (deck 개편, 세션 78ef84bf, 문서 정리) |

### 환경변수
- `GEMINI_API_KEY`, `NOTION_API_KEY`, `NOTION_DATABASE_ID`, `BLOB_READ_WRITE_TOKEN`
- `NOTION_SYNONYM_DB_ID` (PR #12) — 유의어 DB
- `NOTION_GUIDE_PAGE_ID` (PR #14) — 회의록 작성 가이드 페이지

---

## 📝 다음 세션에서 이어갈 때

1. **먼저 읽을 파일** (모두 `meeting-notes/docs/` 하위):
   - `MEETING-NOTES-PIPELINE.md` (현재 동작 구조)
   - `WORK-LOG.md` (이 문서, 시행착오/교훈)
   - `RECOVERY-PLAN.md` (Step 1~4 계획 대비 진척)
   - `HANDOFF.md` (새 Claude 세션 시작 시 컨텍스트 복원용)
2. **현재 작업 컨텍스트**:
   - 단건 복구 2건 완료 (79d6ce87 전체 / 78ef84bf 부분 ~40분)
   - 실전에서 **5분 분할 녹음 자체는 괜찮으나 업로드 실패 시 복구 경로 취약** 확인
   - 서버 가이드 반영 완료 — 다음 PWA 회의부터 agenda 정상 추출 기대
3. **최우선 해결 과제 (실전 재발 방지)**:
   - **retry 버튼 실제 재전송 구현** (현재 reset만 호출)
   - **upload-chunk 재시도 + 지수 백오프** (단일 blip으로 전체 abort 방지)
   - **세션 재개 구조** (서버가 이미 완료된 세그먼트 인식 → 실패한 곳부터만)
   - **앱 레벨 에러 로깅** (Vercel Hobby 1시간 보존 우회 — 세션 폴더에 `errors.log.json`)
4. **품질 검증 과제**:
   - topic 2-pass가 실전에서 50자 내로 정리되는지 케이스 누적
   - sourceQuote 빈 문자열 항목의 환각 적중률 사례 분석
5. **여유 있을 때 정리**:
   - 서버/로컬 헬퍼 중복 (`buildBlocks`, `fetchGuide` 등) 공통 모듈로 추출
   - legacy `prepare`/`transcribe` 액션 제거 (구 실패 세션 모두 복구된 이후)
5. **브랜치 상태**: `main`이 PR #15까지 반영 (커밋 `34ec94a`).
