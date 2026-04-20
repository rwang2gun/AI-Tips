# 서버 전사·요약 유의어 사전 주입 (드리프트 해소)

**날짜**: 2026-04-20
**커밋**: `be2fa2e`
**배경**: 발표 덱 슬라이드 4 "지금의 동작 파이프라인"의 Notion 참조 박스를 코드와 대조 검증하던 중, PR #12 설계 의도(전사 프롬프트에 정답 용어 + 요약 프롬프트에 오인식→정답 매핑)가 **로컬 스크립트에만 구현돼 있고 서버 경로 양쪽(전사·요약) 모두 빠져있는** 드리프트를 발견.

---

## 🔍 발견 경위

덱 슬라이드 4의 참조 박스는 "전사: 용어집·유의어 / 요약: 가이드·용어집·유의어"로 그려져 있었음. 발표용이라 코드와 일치해야 해서 `api/handlers/transcribe-segment.js` 와 `api/handlers/summarize.js` 를 역추적.

**발견한 서버/로컬 드리프트 매트릭스**:

| 경로 | 단계 | 용어집 | 유의어 | 가이드 |
|---|---|---|---|---|
| 서버 (PWA 실운영) | 전사 | ❌ | ❌ | ❌ |
| 서버 (PWA 실운영) | 요약 | ✓ | **❌** | ✓ |
| 로컬 스크립트 | 전사 | ❌ | ✓ | ❌ |
| 로컬 스크립트 | 요약 | ✓ | ✓ | ✓ |

즉 서버 전사는 Notion 참조 전무, 서버 요약은 유의어 누락. `lib/prompts/summarize.js`는 `synonymHint` 파라미터를 받도록 준비돼 있었는데 서버 핸들러가 전달 안 했던 구조적 방치.

**"AI도 관성에 빠진다"** 교훈(WORK-LOG 핵심 교훈 #5) 재확인 — 문서화된 설계가 리팩터·모듈 추출 과정에서 일부 경로에만 배선된 상태로 굳어짐. 이전 사례:
- PR #14 가이드 연동이 로컬만 반영 → 실전 회의록 품질 저하로 `038ed82`에서 뒤늦게 서버 반영
- PR #10 summarize 모델 Flash→Pro 전환이 로컬만 반영 → 2026-04-18 `ac8c70e`에서 서버 통일
- **이번(2026-04-20)** 유의어 사전도 같은 패턴 — 1년 살짝 안 된 공백

---

## 🔧 수정

### `lib/prompts/transcribe.js`
- `buildSegmentTranscribePrompt`에 `synonymHint = ''` 파라미터 추가, 프롬프트 말미에 `${synonymHint}` 주입
- 기본값 빈 문자열 → 하위호환 (호출자가 생략해도 기존 동작 유지)

### `api/handlers/transcribe-segment.js`
- `fetchSynonyms()` 호출 → `buildTranscribeSynonymHint(synonyms)` 로 "정답 용어만" 프롬프트 힌트 생성 (프라이밍 역효과 회피 원칙)
- Gemini 응답 수신 후 `applySynonymReplacements(rawTranscript, synonyms)` 로 "무조건 치환" regex 후처리 → 정제본을 Blob에 저장
- `applied.length > 0` 시 진단 로그 출력
- `NOTION_SYNONYM_DB_ID` 미설정 시 `fetchSynonyms()` 가 빈 배열 반환 → 힌트·치환 둘 다 no-op (하위호환)

### `api/handlers/summarize.js`
- `fetchSynonyms()` + `buildSummarizeSynonymHint(synonyms)` 호출 → 오인식→정답 매핑 + 맥락 메모 두 섹션 생성
- `buildSummarizePrompt` 에 `synonymHint` 파라미터 전달 (빌더는 이전부터 이 파라미터를 수용 준비)

### `tests/unit/prompts/transcribe.test.js`
- `buildSegmentTranscribePrompt`에 `synonymHint` 주입 시 말미에 붙는지 확인하는 테스트 1건 추가
- 기존 3건은 시그니처 하위호환으로 전부 통과

### 비용
- 세션당 Notion DB 조회 2~3회 추가 (전사 세그먼트마다 + 요약 1회) — 200~500ms씩. Vercel 환경에서 세그먼트 병렬 실행이라 사용자 체감 지연은 가장 느린 세그먼트 ~500ms 증가.

---

## 📚 문서 갱신

- `MEETING-NOTES-PIPELINE.md` 섹션 4(transcribe-segment) — 유의어 힌트 + regex 후처리 명시 + 이력 메모(2026-04-20 반영)
- `MEETING-NOTES-PIPELINE.md` 섹션 6(summarize) — Flash→Pro 정정 + 3개 Notion 참조(가이드·용어집·유의어) 명시 + 이력 메모
- `MEETING-NOTES-PIPELINE.md` 환경변수 섹션 — `NOTION_SYNONYM_DB_ID` "로컬 스크립트만" → "서버 전사·요약 + 로컬 공통"
- `REFACTOR-PLAN.md` "의도적 차이" 섹션 — "유의어 사전 로컬만 사용" 취소선 + 해소 메모
- `WORK-LOG.md` 교훈 #5를 **3가지 드리프트 사례 명시적 리스트**로 확장 (가이드·모델·유의어)
- `WORK-LOG.md` 기술 부채: 공통 모듈 추출 이후에도 드리프트가 발생한 사례 → "드리프트 탐지 자동화 미비" 신규 부채로 승격
- `WORK-LOG.md` 🟡 관찰 필요: "서버 유의어 주입 체감 효과" 추가 — 실전 회의에서 오인식 감소 확인 대기

---

## 🎓 교훈

1. **공통 모듈로 추출해도 드리프트는 생긴다** — Phase A~E 리팩터에서 `lib/prompts/summarize.js`가 `synonymHint` 파라미터를 잘 준비해뒀지만, **호출자가 전달 안 하면 의미 없음**. 모듈 추출은 중복 제거이지 일관성 보증이 아님.
2. **발표 자료가 코드 검증 도구로도 쓰인다** — "이 화면이 실제 코드와 일치하나?"를 대조하다가 드리프트 발견. 문서화 행위 자체가 invariant 검증 루틴이 될 수 있음.
3. **드리프트 탐지 자동화 필요성 재확인** — 린트 룰/테스트로 "서버 핸들러가 사용 가능한 hint builder를 전부 호출하는지" 검사가 다음 개선 과제. 수동 점검은 3번이나 놓침.

---

## 🔗 관련 파일

### 런타임 (수정)
- `api/handlers/transcribe-segment.js` · `api/handlers/summarize.js`
- `lib/prompts/transcribe.js`

### 테스트 (추가)
- `tests/unit/prompts/transcribe.test.js`

### 문서 (갱신)
- `meeting-notes/docs/MEETING-NOTES-PIPELINE.md`
- `meeting-notes/docs/REFACTOR-PLAN.md`
- `meeting-notes/docs/WORK-LOG.md`
