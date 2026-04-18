# 세그먼트 파이프라이닝 설계안

**상태**: Codex 적대적 리뷰 반영 → 구현 범위 확정 (2026-04-18)
**작성일**: 2026-04-18
**대상 파일**: `meeting-notes/app.js`, `meeting-notes/index.html`, `meeting-notes/style.css`

## 0. Codex 리뷰 반영 결과

**이번 PR 포함 (비용 낮고 파이프라이닝이 새로 도입하는 리스크)**
- 세션 코디네이터 상태머신 — retry 후 자동으로 merge/summarize/finalize 재진입
- AbortController + 세션 토큰 펜싱 — reset() 시 stale 완료가 새 세션 UI를 오염시키지 않도록
- prepare/transcribe 단계 동시성 세마포어 (각 2) — 재시도 버스트 시 rate-limit 폭주 방지

**별도 후속 PR로 분리 (비용 큼, 현재도 존재하던 리스크)**
- 청크 매니페스트 도입 + `prepare-segment` 완성도 검증 (서버 변경 + legacy 호환 필요)
- IndexedDB 세그먼트 blob 스필오버 (탭 닫힘 대비)

**중요 가정 (이번 PR에서 해결하지 않고 감수)**
- 현재 `api/handlers/prepare-segment.js`는 `seg-NN/` 폴더 내 청크를 무조건 concat.
  부분 청크 남은 상태로 retry 시 silent corruption 가능성 존재 — 이번 PR은 retry를
  "같은 `segmentIndex`로 처음부터 다시 실행" 하되, 중간 실패 청크가 서버에 남아있어도
  재전송 로직이 덮어쓴다는 기존 동작에 의존. 매니페스트 PR에서 근본 해결.

---

## 1. 배경

**현재 동작 (meeting-notes/app.js:285-407 `processMeeting`)**
- 5분 단위 세그먼트 녹음은 병렬 진행 준비 완료 — 서버는 이미 `sessionId + segmentIndex`로 세그먼트별 독립 액션을 가짐:
  `upload-chunk` → `prepare-segment` → `check-file` → `transcribe-segment`.
- 클라이언트 `processMeeting()`은 `stopBtn` 클릭 후에만 순차 호출.
- 결과: 사용자 대기시간 = 녹음시간 + (세그먼트N × (업로드 + Gemini 폴링 + 전사)).

**목표**
- 세그먼트 `onstop` 이벤트에서 fire-and-forget으로 업로드/전사 시작.
- `stopBtn` 시점엔 대부분 세그먼트가 이미 전사 완료 → `merge → summarize → finalize`만 수행.
- 개념적 총 단축 = (N-1) × (업로드+폴링+전사) 시간만큼.

**참고 파일 (기존 코드)**
- `meeting-notes/app.js:131-168` `startSegmentRecorder` — `mediaRecorder.onstop`에서 segments.push, 그리고 stopRequested/pauseRequested에 따라 분기.
- `meeting-notes/app.js:224-249` `finalizeRecording` — 리소스 해제 후 `processMeeting(segments, duration)` 호출.
- `meeting-notes/app.js:285-407` `processMeeting` — 7단계 순차 실행.
- `api/process-meeting.js:5-24` — 서버 액션 시퀀스 주석.
- `api/handlers/` — 각 액션 핸들러. 세그먼트별 독립 실행 가능.

---

## 2. 상태 모델

```js
// startRecording 진입 시 초기화
let sessionId = null;              // crypto.randomUUID(), 세그먼트 간 공유
let segmentPipelines = new Map();  // index → SegmentPipeline

// SegmentPipeline 형태
// {
//   status: 'uploading' | 'preparing' | 'polling' | 'transcribing' | 'done' | 'failed',
//   promise: Promise<void>,
//   attempts: { upload: 0, prepare: 0, transcribe: 0 },  // check-file 제외
//   error: Error | null,
//   uploadProgress: { done: 0, total: 0 },               // UI용
// }
```

**sessionId 생명주기**: `startRecording` 시점 생성 → 모든 세그먼트/merge/summarize/finalize 동안 동일. `reset()`/`idle` 복귀 시 null.

---

## 3. 파이프라이닝 진입점

### 3.1 세그먼트 시작 지점 변경
기존 `startSegmentRecorder` 의 `mediaRecorder.onstop`:

```js
// 기존 (app.js:139-158)
if (audioChunks.length) {
  const blob = new Blob(audioChunks, ...);
  segments.push({ index: segmentIndex, blob });
  segmentIndex++;
}
if (stopRequested) finalizeRecording();
else if (pauseRequested) { ... enterPausedState(); }
else startSegmentRecorder();
```

변경:

```js
if (audioChunks.length) {
  const seg = { index: segmentIndex, blob };
  segments.push(seg);
  segmentIndex++;
  startSegmentPipeline(seg);   // ← 추가: fire-and-forget
}
// 이후 분기 동일
```

### 3.2 finalizeRecording → finalizeAndSummarize
기존 `processMeeting(segs, durationSec)` 호출을 다음으로 대체:

```js
async function finalizeAndSummarize(durationSec) {
  showSection('processing');
  renderPipelineStatus();  // 현재 Map 상태 렌더

  // 1. 모든 세그먼트 파이프라인 대기
  const results = await Promise.allSettled(
    [...segmentPipelines.values()].map(p => p.promise)
  );
  const failed = [...segmentPipelines.entries()]
    .filter(([, p]) => p.status === 'failed');
  if (failed.length) {
    showRetryUI(failed);   // 수동 재시도 UI — 버튼 클릭 시 retrySegment(idx)
    return;
  }

  // 2. merge → summarize → finalize (기존 5~7단계)
  await fetchWithRetry('/api/process-meeting', { X-Action: 'merge-transcripts', ... });
  await fetchWithRetry('.../', { X-Action: 'summarize', ... });
  const res = await fetchWithRetry('.../', { X-Action: 'finalize-notion', ... });
  showResult(await res.json());
}
```

### 3.3 startSegmentPipeline 본체

```js
function startSegmentPipeline(seg) {
  const state = {
    status: 'uploading',
    attempts: { upload: 0, prepare: 0, transcribe: 0 },
    error: null,
    uploadProgress: { done: 0, total: 0 },
    promise: null,
  };
  segmentPipelines.set(seg.index, state);

  state.promise = (async () => {
    try {
      await uploadChunks(seg, state);       // 1. upload-chunk × N
      state.status = 'preparing';
      const prep = await prepareSegment(seg, state);   // 2. prepare-segment
      state.status = 'polling';
      const file = await pollFileActive(prep, state);  // 3. check-file (기존 60회 유지)
      state.status = 'transcribing';
      await transcribeSegment(seg, file, state);       // 4. transcribe-segment
      state.status = 'done';
    } catch (err) {
      state.status = 'failed';
      state.error = err;
      throw err;
    } finally {
      renderPipelineStatus();
    }
  })();
}
```

---

## 4. 재시도 전략

### 4.1 자동 재시도 (fetchWithRetry)
- 대상: `upload-chunk`, `prepare-segment`, `transcribe-segment`, `merge-transcripts`, `summarize`, `finalize-notion`.
- 트리거: `TypeError` (fetch 자체 실패), 5xx, `fetch` 자체 timeout(30s).
- 정책: 지수 백오프 3회, 1s → 2s → 4s, max 10s.
- 각 단계 독립 카운터 (upload가 1회 썼다고 transcribe 재시도 기회가 줄어들지 않음).

### 4.2 수동 재시도
- `Promise.allSettled` 후 `failed` 상태 세그먼트만 UI에 리스트업.
- 사용자가 "세그먼트 N 재시도" 버튼 클릭 → 해당 `segmentIndex`로 `startSegmentPipeline` 재호출.
- 서버: `seg-NN` 폴더가 부분 상태로 남아도 `prepare-segment`가 "현재 있는 청크 전부 결합" 방식이라 overwriting 불필요 (가정 — 리뷰에서 검증 요청).

### 4.3 check-file 폴링 예외
- 본래 반복 폴링이므로 자동 재시도 루프에 넣지 않음.
- 기존 60회 × 2초 = 최대 2분 유지. 그 안에 ACTIVE 안 되면 `failed`.

---

## 5. 진행률 UI

### 5.1 녹음 중
- recorder 화면 유지. 세그먼트 리스트 **비노출** — 복잡도 억제, 녹음자 주의분산 최소화.
- 내부적으로 `segmentPipelines` 업데이트는 진행.

### 5.2 stopBtn 이후 (processing 섹션)
```html
<ul id="segmentList">
  <li data-seg="0">세그먼트 1/3 ✅ 완료</li>
  <li data-seg="1">세그먼트 2/3 ⏳ 전사 중</li>
  <li data-seg="2">세그먼트 3/3 ⏫ 업로드 2/4</li>
</ul>
<div id="mergeStatus">회의록 요약 중...</div>
```
- `renderPipelineStatus()`가 Map 순회하며 DOM 갱신. 상태 변경마다 호출.
- merge/summarize/finalize는 단일 상태 라인 `<div id="mergeStatus">`.

### 5.3 실패 UI
```html
<li data-seg="1" class="failed">
  세그먼트 2/3 ❌ 네트워크 오류
  <button onclick="retrySegment(1)">재시도</button>
</li>
```

---

## 6. 네트워크 끊김 대응

| 상황 | 대응 |
|---|---|
| `navigator.onLine === false` 중 fetch | 자연 실패 → `fetchWithRetry`가 포착, 지수 백오프 대기 |
| `window` `'online'` 이벤트 | 진행 중 백오프 타이머 즉시 해제, 재시도 트리거 |
| 녹음 중 오프라인 | 세그먼트 메모리 축적, 파이프라인은 계속 재시도. online 복귀 시 밀린 작업 소화 |
| `beforeunload` | 미완료 파이프라인 있으면 `e.preventDefault()` → 브라우저 기본 경고 |
| 탭 닫힘/새로고침 | **범위 밖** — 현재도 동일한 데이터 손실. `recover.html`은 별도 흐름 |

---

## 7. 경합 조건 정리

- `segmentIndex++`는 `mediaRecorder.onstop`에서만 → 유니크 보장.
- 일시정지 중 이전 세그먼트 파이프라인 계속 진행 → `sessionId` 동일, `segmentIndex` 다름 → 안전.
- `stopBtn` 시점: 현재 세그먼트 `onstop` → `segments.push` → `startSegmentPipeline` → `stopRequested === true` 경로 → `finalizeAndSummarize`. 마지막 세그먼트가 pipelines에 등록된 후 `Promise.allSettled` 진입 보장.
- `reset()`이 진행 중 파이프라인과 충돌할 가능성 있음 — 구현 시 `segmentPipelines.clear()` 전에 abort 고려.

---

## 8. 변경 파일

- **`meeting-notes/app.js`**
  - 신규: `startSegmentPipeline`, `uploadChunks`, `prepareSegment`, `pollFileActive`, `transcribeSegment`, `fetchWithRetry`, `finalizeAndSummarize`, `renderPipelineStatus`, `retrySegment`.
  - 제거: `processMeeting` (`finalizeAndSummarize`로 대체).
  - 수정: `startRecording` (sessionId/pipelines 초기화), `startSegmentRecorder.onstop`, `finalizeRecording` (→ `finalizeAndSummarize` 호출).
- **`meeting-notes/index.html`**: processing 섹션에 `<ul id="segmentList">`, `<div id="mergeStatus">` 추가.
- **`meeting-notes/style.css`**: 세그먼트 리스트/실패 상태 스타일.

---

## 9. 범위 밖 (후속)

- **건너뛰기** (실패 세그먼트 제외하고 merge 진행): 서버 `merge-transcripts`가 빠진 `transcript-NN.txt`에 어떻게 반응하는지 검증 필요.
- **localStorage / IndexedDB 기반 세션 복구** (탭 닫힘 대비).
- **녹음 중 실시간 완료 토스트** ("✅ 세그먼트 1 전사 완료").
- **세그먼트 blob IndexedDB 임시 저장** (메모리 상 세그먼트 누적 부담 완화).

---

## 10. 리뷰 요청 — 적대적으로 파고들어달라

1. **경합 조건 사각지대**: `sessionId` 공유 fire-and-forget에서 놓친 race? 일시정지→재개→`stopBtn` 순서에서 마지막 세그먼트 파이프라인 시작 전에 `finalizeAndSummarize`가 실행될 가능성? `reset()` 중간 호출 시나리오?
2. **재시도 전략의 허점**: 지수 백오프 3회면 충분한가? `check-file` 60회 폴링 중 네트워크 끊김은 어떻게 다뤄야 하나? `upload-chunk` 중간 실패(3번째 청크) 시 1~2번째는 재전송 안 하는데 `seg-NN` 폴더가 부분 상태로 남아도 `prepare-segment`가 정상 동작한다는 가정이 맞는가?
3. **UI 상태 관리 복잡도**: Map 기반 상태 + DOM 동기화의 버그 위험. 더 단순한 대안(전사 완료된 순서대로 큐만 UI 표시)이 있나?
4. **기존 녹음 UX 회귀**: 일시정지/재개 중 fire-and-forget 파이프라인이 MediaRecorder나 오디오 리소스(stream/audioCtx)와 충돌해 녹음 품질/마이크 권한을 해칠 가능성?
5. **서버 부하**: 5분 세그먼트 × N개가 동시에 `prepare-segment`에 도달할 때 Gemini Files API 동시 업로드 rate limit, Vercel 서버리스 동시 실행 한도, Blob 동시 쓰기 경합? 일반 진행은 N=1 동시성이지만 재시도/일시정지 축적 시 문제?
6. **기술 선택 적합성**: Web Worker 기반 큐 대안 vs 메인 스레드 fire-and-forget. 6분 이상 긴 회의에서 세그먼트당 약 9개 청크 동시 fetch가 브라우저 연결 한계(호스트당 6)에 부딪혀 녹음 스레드를 지연시키나?
7. **범위 설정**: 건너뛰기 + localStorage 복구를 빼는 게 합당한가, 최소한의 안전망(예: 세그먼트 blob IndexedDB 임시 저장)이 같이 들어가야 하나?

---

**AS-IS 비교 (참고)**

| 시점 | AS-IS (순차) | TO-BE (파이프라이닝) |
|---|---|---|
| 세그먼트 1 녹음 종료 | 대기 | 업로드/전사 시작 |
| 세그먼트 2 녹음 종료 | 대기 | 업로드/전사 시작 (세그 1과 병렬) |
| ... | ... | ... |
| `stopBtn` 클릭 | 첫 세그먼트부터 순차 전사 시작 | 대부분 세그먼트 이미 `done`, merge/요약/Notion만 |
| 완료까지 걸리는 추가 시간 | ~N × 업로드+폴링+전사 | 1 × 업로드+폴링+전사 + merge/요약/Notion |
