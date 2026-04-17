# 리팩터 Plan — 하네스 엔지니어링 구조 전환

> 지속 업데이트를 위한 모듈 분리 리팩터 계획. 구현 전 Codex 리뷰 예정.

## 배경

회의록 자동 생성 PWA를 구조 고민 없이 만들었더니 단일 파일이 비대해졌고, `api/`와 `scripts/` 사이에 상당한 코드 중복이 쌓였음. 앞으로 지속적으로 기능을 추가·개선하기 위해 모듈 경계를 명확히 분리.

## 현재 문제

| 파일 | 줄수 | 문제 |
|---|---|---|
| [api/process-meeting.js](api/process-meeting.js) | 1111 | 9개 액션 핸들러 + 공통 유틸 + 프롬프트 + Notion 빌더 모두 한 파일 |
| [scripts/process-recording-locally.js](scripts/process-recording-locally.js) | 704 | API 파이프라인과 거의 동일한 로직 복붙 |
| [scripts/upload-to-notion.js](scripts/upload-to-notion.js) | 453 | `buildBlocks` 등 API와 중복, 주석에도 "동기화 필요" 경고 |

## 코드 중복 분석

### 순수 복붙 (통합 필요)
- `meetingSchema()` — API와 로컬 100% 동일
- `fetchGlossary()` — 완전 동일
- `buildBlocks()` — 구조 동일 (API 쪽이 진단 토글 등 약간 더 복잡)
- transcript 파일명 생성, Notion 파일 업로드 유틸

### 의도적 차이 (별도 유지)
- **Gemini 클라이언트**: serverless는 per-request 생성, 로컬은 전역 싱글톤
- **오디오 소스**: serverless는 Vercel Blob, 로컬은 fs
- **유의어 사전**: 로컬만 사용 (API는 용어집으로 충분)
- **세그먼트 병합**: API만 필요 (클라이언트가 5분 단위 분할)
- **타임아웃**: 로컬 undici 무제한, API 60초 제약

### [api/process-meeting.js](api/process-meeting.js) 액션 목록
- `upload-chunk`, `prepare-segment`, `check-file`, `transcribe-segment`, `merge-transcripts`, `summarize`, `finalize-notion`
- legacy: `prepare`, `transcribe` — [meeting-notes/recover.html](meeting-notes/recover.html) 호환용 (삭제 불가)

## 목표 디렉토리 구조

```
api/
├── process-meeting.js         # 라우터 (~80줄) — 액션 분기만
├── version.js                 # 변경 없음
└── handlers/                  # NEW
    ├── upload-chunk.js
    ├── prepare-segment.js
    ├── transcribe-segment.js
    ├── merge-transcripts.js
    ├── summarize.js
    ├── finalize-notion.js
    └── legacy/                # recover.html 호환
        ├── prepare.js
        └── transcribe.js

lib/                           # NEW — api/scripts 공유
├── clients/
│   ├── gemini.js              # GoogleGenAI 팩토리 (환경별 옵션)
│   ├── notion.js              # NotionClient 팩토리
│   └── blob.js                # @vercel/blob 래퍼
├── schemas/
│   └── meeting.js             # responseSchema 단일 source
├── prompts/
│   ├── transcribe.js          # 전사 프롬프트 빌더 (segment/legacy/local 변형)
│   └── summarize.js           # summarize 프롬프트 빌더
├── glossary.js                # fetchGlossary
├── synonyms.js                # fetchSynonyms + 힌트 빌더 (로컬 전용 import)
├── guide.js                   # fetchGuide (Notion 작성 가이드)
├── notion/
│   ├── page-builder.js        # buildBlocks (API/로컬 모두 지원)
│   └── file-upload.js         # uploadTranscriptToNotion
├── audio/
│   └── chunking.js            # 청크 결합/세그먼트 병합 (순수)
├── transcript/
│   └── post-process.js        # enforceSentenceBreaks, applySynonymReplacements
└── http/
    └── body-parser.js         # raw body 유틸 (api 전용)

scripts/                       # 위치 유지, 내부만 lib/* import
├── process-recording-locally.js
├── upload-to-notion.js
├── split-audio-segments.js
├── download-session-audio.js
├── extract-term-candidates.js
└── preview-summarize-prompt.js

tests/                         # NEW
├── unit/                      # 순수 함수
│   ├── audio/chunking.test.js
│   ├── transcript/post-process.test.js
│   ├── schemas/meeting.test.js
│   └── notion/page-builder.test.js
└── integration/               # 핸들러 (Gemini/Notion/Blob mock 주입)
    ├── summarize.test.js
    └── transcribe-segment.test.js
```

## 모듈 경계 규칙

- `lib/` ← `api/handlers/*`, `scripts/*` 가 import (한 방향)
- `lib/clients/*` ← Gemini/Notion/Blob을 생성하는 **유일한** 곳
- `lib/clients/*` 는 다른 `lib/*` 를 import 하지 않음 (순환 방지)
- `api/handlers/*` 만 HTTP req/res 를 만짐
- `lib/schemas/`, `lib/prompts/` 는 순수 데이터/문자열 (클라이언트 의존 없음)

## Phase 순서

각 Phase 끝에 Codex 리뷰 → 수정 → 다음 Phase.

| Phase | 내용 | 검증 |
|---|---|---|
| **A** | `lib/schemas`, `lib/prompts`, `lib/glossary`, `lib/synonyms`, `lib/guide` 추출 | 단위 테스트 + Codex 리뷰 |
| **B** | `lib/clients/*`, `lib/notion/file-upload`, `lib/audio/chunking`, `lib/transcript/post-process`, `lib/http/body-parser` | 단위 테스트 + Codex 리뷰 |
| **C** | `lib/notion/page-builder` (buildBlocks 통합 — 가장 큰 중복) | 스냅샷 테스트 + Codex 리뷰 |
| **D** | `api/handlers/*` 분리 + [api/process-meeting.js](api/process-meeting.js) 라우터화 | 핸들러 통합 테스트 + Codex 리뷰 |
| **E** | `scripts/*` 가 `lib/*` 사용하도록 변환 | 수동 실행 검증 + Codex 리뷰 |

## 테스트 전략

- **프레임워크**: `node:test` (Node 20 native, 의존성 0)
- **실행**: `npm test` 스크립트 추가
- **순수 유틸 우선** (ROI 최고): chunking, post-process, schemas, page-builder
- **핸들러 통합 테스트**: 의존성 주입 패턴 — Gemini/Notion 인스턴스를 인자로 받아서 mock 주입
- **e2e 없음**: 실제 Gemini/Vercel 호출 비용·복잡도 ↑, 수동 배포 검증으로 대체

## 보존 (Backward Compatibility)

- Vercel 함수 entry 그대로: `/api/process-meeting`, `/api/version`
- 액션 이름 그대로 (`upload-chunk`, `prepare-segment`, ...)
- legacy `prepare`/`transcribe` 보존 ([meeting-notes/recover.html](meeting-notes/recover.html) 호환)
- 환경변수 그대로
- Notion DB 스키마 그대로

## 리팩터에서 손대지 **않는** 것

- 공개 계약 (action 이름, req/res 형태)
- Gemini API 호출 로직 자체
- Notion DB 스키마
- prompt 문구 자체 (이동만, 수정 X)
- 의도적 차이 (싱글톤 vs per-request 등)

## 위험 및 완화

| 위험 | 완화 |
|---|---|
| [meeting-notes/recover.html](meeting-notes/recover.html) 기능 깨짐 | legacy 핸들러를 `api/handlers/legacy/`에 보존, 동작 변경 X |
| import 경로 오류 | 각 Phase 후 `node --check api/*.js scripts/*.js` |
| Gemini 싱글톤이 serverless cold start에서 문제? | 팩토리 패턴 + lazy init, 핸들러마다 `getClient()` 호출 |
| Phase D 한 번에 1111줄 분리 — 리뷰 어려움 | action당 1 commit으로 쪼개서 작업 (리뷰 단위 축소) |

## 열린 질문 (Codex 리뷰 요청 포인트)

1. 모듈 경계 적절한가? 빠진/불필요한 모듈? 순환 위험?
2. Phase 순서 A→E 안전? C를 B보다 앞으로?
3. 싱글톤 vs per-request 차이 — 팩토리/DI/환경 플래그 중 어느 추상화?
4. `node:test` 적절? 의존성 주입이 과한가?
5. 놓친 위험 — 특히 recover.html 호환.
6. Phase D 분할 — action당 commit 가치 있나?
7. 하네스 엔지니어링 관점 추가 제안.
