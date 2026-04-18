# 세그먼트 파이프라이닝 PR1 (클라이언트)

**날짜**: 2026-04-18
**커밋**: (이 커밋)
**브랜치 흐름**: `test/segment-pipelining` → `main` (squash)
**설계 문서**: [segment-pipelining-design.md](./segment-pipelining-design.md) (Codex 적대적 리뷰 반영본)

---

## 배경

기존 동작: `stopBtn` 시점에 `processMeeting()`이 세그먼트 N개를 **순차**로 `upload → prepare → poll → transcribe` 실행. 사용자 체감 대기시간 = 녹음시간 + N×(업로드+폴링+전사). 45분 회의에 14세그먼트면 종료 후 5분+ 대기.

목표: 세그먼트 `onstop` 즉시 fire-and-forget 파이프라인 시작. `stopBtn` 시점엔 대부분 세그먼트 이미 전사 완료 상태 → `merge → summarize → finalize`만 수행.

---

## 구현 범위 (Codex 리뷰로 확정)

**포함 (파이프라이닝이 새로 도입하는 리스크에 직접 대응)**
- 세션 코디네이터 (`createSession`, `coordinatorCheck`) — 모든 세그먼트 완료 감지 후 finalize 재진입
- AbortController + `currentSession` 참조 펜싱 — stale 완료가 새 세션 DOM을 오염시키지 않도록
- `prepare`/`transcribe` 각 N=2 세마포어 — 재시도 버스트 시 Gemini/Vercel rate-limit 폭주 방지
- `fetchWithRetry`: 4xx 즉시 throw / 5xx·네트워크 지수 백오프 3회 (1s → 2s → 4s, cap 10s)
- `waitWithSignals`: `'online'` 이벤트 감지 시 백오프 즉시 깨움
- `retrySegment()`: 세그먼트 단위 수동 재시도 (파이프라인 덮어쓰기)
- `beforeunload` 경고: 미완료 세션 유지 중 탭 닫기 방지

**분리 (후속 PR — 서버 변경 또는 비용 큼)**
- 청크 매니페스트 + `prepare-segment` 완성도 검증
- IndexedDB 세그먼트 blob 스필오버 (탭 닫힘 대비)

---

## 테스트 결과 (Vercel preview)

브랜치: `test/segment-pipelining` (commits `b0fccfa`, `875dba6`)
`SEGMENT_SECONDS`를 30초로 임시 단축해서 폰(Android Chrome)에서 검증.

| 시나리오 | 결과 |
|---|---|
| 골든 패스 (60~90초 녹음 → 4 세그먼트) | ✅ 종료 시점에 세그먼트 4개 모두 `done` 상태로 이미 전사 완료 — 설계대로 |
| Gemini Pro 503 (요약 단계) | ⚠️ 1차 시도에서 "This model is currently experiencing high demand" — **기존에 있던 Pro 503 함정**, 파이프라이닝과 무관 |
| finalize 실패 후 재시도 UX | ❌ → ✅ 수정 |

---

## 실전 테스트로 드러난 UX 구멍 + 그 자리에서 수정

**문제**: `runFinalization` 실패 시 `showError()` → error 섹션 전환 → 사용자가 "다시 시도" 누르면 `reset()` 호출 → **이미 완료된 세그먼트 전사 4개를 모두 날려버림**. 인메모리 `segments` 배열도 비워지고 서버에 있는 전사 파일은 참조할 방법이 없어짐.

**수정** (commit `875dba6`):
- `runFinalization.catch`: `showError` 대신 `session.phase = 'failed'` + `renderPipelineStatus()`. processing 섹션 유지.
- `retryFinalization()`: `phase = 'awaiting'` → `coordinatorCheck(session)` 재진입 → `runFinalization` 재실행. 세그먼트 파이프라인 건드리지 않음.
- `renderFinalizeRetry()`: `phase === 'failed'`일 때만 "요약/저장 다시 시도" 버튼을 processing에 append.
- `phaseText` + `summarizeFinalizeError`: Gemini 오류 JSON 덩어리 대신 `message` 필드만 추출해서 표시.
- `reset()`: `finalizeRetryBtn`도 DOM에서 제거.

**관측 효과**: 재테스트에서 golden path 완주 확인. Gemini 503이 다시 나와도 이제는 버튼으로 즉석 재시도하면 됨.

---

## 변경 파일

- `meeting-notes/app.js` (+444 / -151 → 추가로 +61 / -2 = 최종 **+505 / -153**)
  - 추가: `createSession`, `Semaphore`, `waitWithSignals`, `fetchWithRetry`, `startSegmentPipeline`, `uploadChunks`, `prepareSegment`, `pollFileActive`, `transcribeSegment`, `coordinatorCheck`, `runFinalization`, `retrySegment`, `retryFinalization`, `renderPipelineStatus`, `renderFinalizeRetry`, `segmentStatusText`, `phaseText`, `summarizeFinalizeError`
  - 제거: 기존 `processMeeting` (순차 7단계)
  - 수정: `startRecording`(세션 초기화), `startSegmentRecorder.onstop`(fire-and-forget), `finalizeRecording`(→ coordinator 진입), `reset`(세션 abort + 펜싱)
- `meeting-notes/index.html` (+1): `<ul id="segmentList">` 추가
- `meeting-notes/style.css` (+66): 세그먼트 리스트/완료/실패/재시도 + finalize 재시도 버튼
- `meeting-notes/docs/segment-pipelining-design.md` (신규 +269): Codex 리뷰 반영 설계안

---

## 범위 밖 (후속 과제)

1. **청크 매니페스트** — 현재 `prepare-segment`는 `seg-NN/` 폴더 내 청크를 무조건 concat. 부분 청크 남은 상태 retry 시 silent corruption 가능성. 서버 변경 필요.
2. **IndexedDB blob 스필오버** — 탭 닫힘 시 세그먼트 손실 방지.
3. **세션 재개** — 실패 지점부터 이어 처리. 현재는 페이지 이탈 시 전체 폐기.
4. **upload-chunk 병렬화** — 현재 세그먼트 내 청크는 순차 업로드. 브라우저 host당 6 연결 한도 고려한 병렬화 검토 가능.
5. **finalize 재시도 정책 강화** — 현재 사용자 수동 클릭. Gemini Pro 503은 타이밍 운 → 자동 2회 재시도 후 버튼 노출 등.

---

## 교훈

- **적대적 리뷰가 UX 구멍을 잡진 않았다** — Codex 리뷰는 race/retry/rate-limit에 집중. "finalize 실패 후 retry가 세그먼트 전사를 날린다"는 실전 한 번 돌려보고야 발견. **리뷰 + 실제 테스트 둘 다 필요**.
- **Vercel preview + 폰 Chrome 원격 디버깅 루프가 정답** — 로컬은 마이크 없음. `SEGMENT_SECONDS=30`으로 임시 단축해서 테스트 브랜치에 푸시 → preview URL 폰 접속. 완료 후 300 복구.
- **Gemini Pro 503은 관성 함정** — PR #8/#9의 교훈이 이미 WORK-LOG에 있었는데도 이번 첫 테스트에서 또 맞았다. 서버 재시도가 있어도 클라이언트에서 노출되면 UX 책임은 클라이언트 쪽.
