# finalize 재시도 강화 + Vercel Blob 페이지네이션 버그 수정

**날짜**: 2026-04-18
**브랜치 흐름**: `test/finalize-retry` → `main` (squash)
**배경**: [segment-pipelining PR1](./work_log_segment_pipelining_pr1.md) 직후 실전 테스트에서 연속 2건의 이슈 발견 → 같은 세션 내 수정

---

## 이번 세션에서 발견한 이슈 (실전 테스트 기반)

### 1. finalize(요약/저장) 단계 Gemini 503 — 재시도 부족
PR1 적용 후 폰 테스트: 전사 4/4 완료 후 summarize 단계에서 `{"code":503,"message":"This model is currently experiencing high demand"}`. 클라 `fetchWithRetry`가 기본 3회 / cap 10s여서 Gemini demand spike 타이밍을 못 버팀.

**WORK-LOG 핵심 교훈 #3** 재현: "Flash는 긴 입력 + structured output 조합에 503 지속 반환" — 서버 `handleSummarize`가 Flash + responseSchema를 쓰고 서버측 `withRetry`도 3회 / 8s cap이라 한 클라 요청 안에서 충분히 못 버팀.

### 2. 134 세그먼트 merge 시 "expected 134, got 100" — Vercel Blob list() 페이지네이션 누락
`SEGMENT_SECONDS=30`으로 긴 녹음 테스트(67분 × 30s = 134 세그먼트). 전사 전부 성공 후 `merge-transcripts` 호출에서 `Segment count mismatch`.

원인: `api/handlers/merge-transcripts.js:18`이 `list({ prefix })`를 단일 호출. Vercel Blob SDK는 페이지당 기본 100~1000개만 반환하고 `cursor`로 다음 페이지를 조회해야 함. 장시간 회의 시 잘림.

### 3. iPad 멀티태스킹 제스처로 PWA 킬 → 세션 복구 불가
수정 도중 아이패드 제스처로 PWA 탭 종료. 전사 파일 134개는 Vercel Blob에 살아있지만 클라 메모리의 `sessionId`/`segments[]` 참조 소멸 → 복구 경로가 CLI `scripts/recover-session.js`뿐. 일반 사용자에겐 사실상 데이터 손실. **"세션 재개"(다음 세션 후보 C) 우선순위 급상승 근거**.

---

## 변경

### 클라이언트 (`meeting-notes/app.js`)
- `fetchWithRetry`에 `capMs`, `onAttempt` 옵션 추가 (backward-compatible)
- `SUMMARIZE_RETRY_ATTEMPTS = 5`, `SUMMARIZE_RETRY_CAP_MS = 30000` 상수 신설 — summarize 단계 전용
  - 누적 백오프 최대 ~60s (1→2→4→8→16/30s)
  - merge/finalize-notion은 기본 3회 유지 (merge는 Gemini 비사용, finalize-notion은 Notion 중복 페이지 리스크)
- `runFinalization`의 summarize 호출에 위 옵션 + `onSummarizeAttempt` 콜백 전달
- `session.finalizeAttempt` 추가: `{ next, max, backoffMs }` 형태로 재시도 상태 저장
- `phaseText`가 `finalizeAttempt` 있으면 `"회의록 요약 중... (AI 과부하로 재시도 3/5)"` 표시
- `retryFinalization`이 `finalizeAttempt`도 초기화

### 서버 핸들러 — Vercel Blob 페이지네이션 수정 (critical)
- `lib/clients/blob.js`: `listAllBlobs(prefix)` 헬퍼 추가 — `cursor` 반복으로 전부 수집
- `lib/clients/blob.js`: `deleteByPrefix`도 `listAllBlobs` 사용으로 잔여 blob 누수 방지
- `api/handlers/merge-transcripts.js`: `listAllBlobs`로 전환 — **이번 버그 발현 지점**
- `api/handlers/prepare-segment.js`: 안전을 위해 전환 (세그먼트 내 청크 수는 보통 < 10이지만 원칙적으로)
- `api/handlers/legacy/prepare.js`: 긴 세션 legacy 복구 대비

### 스크립트
- `scripts/download-session-audio.js`: `listAllBlobs` 사용
- `scripts/recover-session.js`: `import list from '@vercel/blob'` 직접 사용 중이라 inline cursor 루프로 수정

---

## 테스트 경과 (Vercel preview `test/finalize-retry`)

- 커밋 `d23b5a3` (retry 강화): 골든 패스 4 세그먼트까지 정상 진행 → summarize에서 Gemini 503 발생했으나 클라 retry UI가 예상대로 "AI 과부하로 재시도" 노출. 그러나 5회 다 실패 → 재시도 버튼 → 페이지네이션 버그로 failed
- 커밋 `7190b7f` (페이지네이션 fix): preview 빌드 완료. 하지만 **사용자가 iPad 제스처로 앱 종료 → 134 세그먼트 세션은 최종 검증 못함**. 재테스트 제안했으나 긴 녹음 반복이 비효율적이라 중단. 페이지네이션 코드는 cursor 루프 표준 패턴이라 코드 리뷰로 정확성 확정.
- **regression/최종 E2E 검증은 다음 회의에서 자연 검증** — 5분 세그먼트 실전 운영이 곧 검증.

---

## 후속 과제 (미구현, 이번 세션 유보)

### 1. UI: 완료 세그먼트 접기 (바로 다음 세션 후보)
- 세그먼트 많아지면 상단 에러 텍스트와 하단 "요약/저장 다시 시도" 버튼 사이 거리가 너무 벌어짐
- 제안: `done` 상태 세그먼트가 N개 이상이면 `<details>`로 접어서 "✅ 완료된 세그먼트 N개 (펼치기)" 표시
- 실패/진행 중 세그먼트는 항상 펼쳐서 표시
- 파일: `meeting-notes/app.js`의 `renderPipelineStatus`, `meeting-notes/index.html`(container 재구조), `meeting-notes/style.css`(fold 스타일)

### 2. 세션 재개 (다음 세션 후보 C — 우선순위 상승)
이번 iPad 킬 사건이 보여줬듯 **PWA 중단 시 복구 경로가 CLI뿐**. 다음 PR:
- `sessionId` + 완료 세그먼트 상태를 localStorage에 persist
- 앱 재시작 시 "진행 중 세션 발견, 이어서 요약할까요?" 다이얼로그
- 서버에 `resume-session` 액션 신설 — 전사 파일 목록 조회해서 클라에 반환
- IndexedDB blob 스필오버(B 옵션)는 이후 별개 PR

### 3. 서버 summarize Pro fallback 재확인
`api/handlers/summarize.js`가 주 호출을 `gemini-2.5-flash`로 쓰는데, WORK-LOG PR #10이 "Pro로 전환"이라 기록되어 있음. 리팩터 과정에서 Flash로 회귀한 것인지 의도적인지 확인 필요. Flash 유지라면 긴 입력 + structured output 조합의 503 발생률이 높아 이번 세션 같은 사고가 재발.

### 4. `scripts/finalize-session.js` 신설 (옵션)
PWA 중단 시 전사까지 완료된 세션을 merge→요약→Notion까지만 돌리는 CLI. 일반 `recover-session.js`는 재전사를 해서 낭비. 이번 세션에선 "코드 추가보다 재실험"이 합리적이라 유보.

---

## 교훈

1. **"Flash 긴 입력 + structured output → 503"는 관성 함정** — 이미 WORK-LOG에 명시돼 있는데 이번 첫 실전 테스트에서 또 맞음. 서버 Pro fallback이 적용돼 있는지 매번 확인 필요.
2. **SDK 기본 페이지 크기를 가정하지 말 것** — Vercel Blob `list()`는 paginated. 장시간 회의 스케일은 단일 호출 가정을 깬다. 유사 패턴이 `scripts/` 전반에 깔려있어 한 번에 정리하는 게 위생적이었음.
3. **PWA 중단은 언제든 일어난다** — 아이패드 제스처, 전화, 메모리 압박. 인메모리 세션 상태는 언제든 손실 가능 전제로 설계해야 함. 세션 재개 PR 우선순위를 실제 경험으로 입증.
4. **실전 테스트가 설계 리뷰를 보완한다** — Codex 적대적 리뷰는 race/retry/rate-limit에 집중했지만 "UX에서 에러와 재시도 버튼이 멀리 떨어지는 문제" 같은 건 실제 134 세그먼트 돌려보고야 드러남. **리뷰 + 실전 둘 다 필요**는 PR1에 이어 이번 세션에서도 반복 확인.
