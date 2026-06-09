# 녹음 종료 직후 업로드 타임아웃 개선안

> **배경**: 2026-05-21 실전 관찰. 녹음 종료 직후 남은 세그먼트 전송 단계에서 브라우저 UI에 업로드 실패가 표시됨. 약 30분 기다린 뒤 동일 세션을 다시 전송하면 성공. 동 시점에 Vercel Hobby 함수 사용량 75% 초과 알림 메일 수신. 두 신호(시간 경과 후 성공 + 사용량 급증)는 **rate limit + Vercel 함수 한도와 retry 백오프의 충돌**을 강하게 시사. 실측·코드 리딩 기반 가설이며 Vercel 로그 직접 확인은 사용량 부담으로 보류.
>
> **모델 baseline 노트 (2026-06-09 갱신)**: 본 계획은 2026-06-09 main 머지 시점의 모델 구성 기준으로 작성됨. 전사 `gemini-3.5-flash`(`lib/handlers/transcribe-segment.js:11`, `lib/handlers/legacy/transcribe.js:26`), 요약 `gemini-3.1-pro`(`lib/handlers/summarize.js:14`). 직전까지 사용하던 `gemini-2.5-flash` / `gemini-2.5-pro`는 [Gemini API changelog 2026-06-01](https://ai.google.dev/gemini-api/docs/changelog?hl=ko#06-01-2026) 의 2.0 계열 폐기 공지를 계기로 차세대(3.x)로 일괄 이주한 결과. 본 개선안의 quota 가설은 모델 generation과 무관(어느 generation이든 Free tier RPM 한도에 동일하게 노출)하지만, 검증 시점의 실제 quota 한도와 응답 시간 분포는 3.x 기준으로 다시 측정해야 함.

---

## 🎯 목표

1. 녹음 종료 직후 큐에 쌓인 세그먼트가 동시 폭주하지 않도록 클라이언트단 압력을 낮춘다.
2. Gemini 429/503 발생 시 서버 함수가 60초 한도를 풀로 소모하지 않게 한다 (Vercel 사용량 절감).
3. 실패 자체는 줄이지 못해도 **함수-시간 단위 비용 폭증**(타임아웃 × 재시도)은 차단한다.

## ❌ 비목표

- Gemini Free tier 한도 자체를 올리는 작업(유료 전환·다중 키 로테이션). 본 개선안 범위 밖.
- 세션 자동 재개/오프라인 큐 구현. 현행 retry로 충분히 흡수되는지 먼저 측정.
- 서버-사이드 큐 도입(Vercel KV 등). 추가 함수 호출과 추가 종속성 비용이 더 큼.

---

## 🩺 진단

### 증상

- **단계**: 녹음 종료 후 `startSegmentPipeline`이 마지막 in-flight 세그먼트들과 함께 진행되는 구간 (`uploading` → `preparing` → `polling` → `transcribing`).
- **관찰 위치**: 브라우저 UI 에러 표시 (Vercel 로그 미확인).
- **재현 조건**: 회의 길이가 길어 큐에 쌓인 세그먼트가 많을수록 자주 발생 추정. 30분급 회의에서 발생 확인.
- **자연 회복**: 약 30분 후 같은 세션 재전송 → 성공.

### 코드 흐름

녹음 종료 시 클라이언트가 거치는 단계 (`meeting-notes/app.js:454-494`):

1. `uploadChunks` — 세그먼트 오디오를 3.5MB씩 `upload-chunk`로 전송 (Vercel Blob 저장)
2. `prepareSegment` — 서버가 Blob 청크 결합 + Gemini Files API 업로드 (`lib/handlers/prepare-segment.js:24-33`)
3. `pollFileActive` — `check-file`로 ACTIVE 폴링 (최대 2분)
4. `transcribeSegment` — Gemini `generateContent` 호출 (`lib/handlers/transcribe-segment.js:40-55`)

현재 파라미터 (`meeting-notes/app.js:5-27`):

| 설정 | 값 |
| --- | --- |
| `PREPARE_CONCURRENCY` | 2 |
| `TRANSCRIBE_CONCURRENCY` | 2 |
| `RETRY_MAX_ATTEMPTS` (클라) | 3 |
| `RETRY_BASE_MS` / `RETRY_CAP_MS` | 1000 / 10000 |
| 서버 `withRetry` | maxAttempts=3, base=2s, cap=8s, 429/500/503/UNAVAILABLE/RESOURCE_EXHAUSTED 재시도 |

### 가설 (강한 신호 순)

1. **Gemini Free tier rate limit** — 30분 기다린 뒤 성공한 사실이 결정적. `gemini-3.5-flash`의 분당 RPM과 일일 토큰 한도는 좁다. 녹음 종료 순간 큐에 쌓인 세그먼트가 동시 4개(prepare 2 + transcribe 2)로 몰리고, 각각 retry까지 추가되어 quota window를 넘김. 429/`RESOURCE_EXHAUSTED` 신호. (2026-06-09 이전 `gemini-2.5-flash` 사용 시점에도 동일 패턴 관측됨 — 모델 generation 자체가 원인은 아님.)
2. **Vercel Hobby 60초 함수 한도와 retry 백오프 충돌** — Gemini가 429/503 반환 → 서버 `withRetry`가 2s→4s→8s 백오프 → 그 사이 Gemini 호출 자체도 무거움 → `prepare-segment` / `transcribe-segment`가 60초 초과 → 504(`FUNCTION_INVOCATION_TIMEOUT`) → 클라이언트 `fetchWithRetry`가 5xx로 보고 3회 재시도 → **함수-시간 사용량 폭증**. 75% 알림과 정합.
3. **녹음 종료 시점 burst 집중** — 녹음 중에는 세그먼트가 5분 간격으로 띄엄띄엄 만들어지나, stop 직후엔 in-flight 세그먼트들이 마지막 세그먼트와 한꺼번에 같은 시간대로 압축되어 동시 요청 압력이 최고조.

### 가설을 뒷받침하는 근거

- `lib/http/retry.js:11` + `lib/http/gemini-error.js`(`isRetriable`) — `RESOURCE_EXHAUSTED|UNAVAILABLE|429|503`이 retriable 분류. 즉 quota 거절 시 서버가 자동으로 시간을 더 쓴다. (2026-06-09 머지로 분류 로직이 `gemini-error.js`로 분리됨. `prepayment depleted`만 즉시 throw로 빠르게 실패.)
- `meeting-notes/app.js:226` — 클라이언트가 5xx를 retriable로 처리. Vercel 504도 여기 포함.
- `meeting-notes/app.js:215` — fetch에 `signal`만 있고 별도 타임아웃 없음. Vercel이 504 돌려줄 때까지 60+초 대기.
- `lib/handlers/prepare-segment.js:28-33` — Gemini `files.upload`를 `withRetry`로 감싸 단일 함수 안에서 모든 백오프 진행.

---

## 🔧 개선안 (영향도 높은 순)

### 1. 클라이언트 동시성 축소 (가장 작은 변경, 최대 효과)

**파일**: `meeting-notes/app.js:26-27`

```diff
- const PREPARE_CONCURRENCY = 2;
- const TRANSCRIBE_CONCURRENCY = 2;
+ const PREPARE_CONCURRENCY = 1;
+ const TRANSCRIBE_CONCURRENCY = 1;
```

- **효과**: 동시 Gemini 호출 4개 → 2개. quota 압력 절반.
- **트레이드오프**: 처리 시간 증가. 30분 회의(세그먼트 6개) 기준 직렬 처리해도 합리적 — 세그먼트당 전사 약 20~40초 × 6 = 2~4분.
- **검증 방법**: 다음 달 실 사용 1~2회로 충분.

### 2. 서버 `withRetry` 백오프 축소

**파일**: `lib/http/retry.js:11`

```diff
- export async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 2000, maxDelayMs = 8000, label = 'withRetry' } = {}) {
+ export async function withRetry(fn, { maxAttempts = 2, baseDelayMs = 1000, maxDelayMs = 4000, label = 'withRetry' } = {}) {
```

- **효과**: 서버 함수 안의 백오프 합이 6s → 1s로 단축. 60초 한도 안에 retry 1회 시도 후 빨리 5xx로 종료. **함수-시간 사용량의 가장 큰 출혈 지점.**
- **트레이드오프**: 일시적 Gemini 거절을 클라이언트가 흡수해야 함 — 클라이언트 `fetchWithRetry`의 3회 재시도가 이미 그 역할.
- **주의**: 로컬 CLI(`scripts/*`)에서 `withRetry`를 직접 호출하며 명시적으로 `{ maxAttempts: 6, maxDelayMs: 32000 }` 오버라이드하는 호출자가 있는지 grep 필요. 있다면 영향 없음(인자가 우선). 호출자 없으면 로컬 회복력만 떨어짐 — 별도 상수로 분리 검토.
- **2026-06-09 baseline 변화**: `isRetriable` 로직이 `lib/http/gemini-error.js`로 분리되며 `prepayment depleted`는 즉시 throw로 분기됨. 본 변경은 retry 횟수/지연만 조정하므로 새 분류 로직과 무관.

### 3. 클라이언트 요청별 하드 타임아웃 추가

**파일**: `meeting-notes/app.js:195` (`fetchWithRetry`)

현재는 Vercel이 504를 돌려줄 때까지 대기. 클라이언트가 ~45초에 자체 abort + retry 하도록 변경.

```diff
+ const PER_REQUEST_TIMEOUT_MS = 45000;

  async function fetchWithRetry(url, opts, { session, label, ... }) {
    ...
    while (attempt < maxAttempts) {
+     const timeoutController = new AbortController();
+     const timeoutId = setTimeout(() => timeoutController.abort(), PER_REQUEST_TIMEOUT_MS);
+     const combinedSignal = AbortSignal.any([signal, timeoutController.signal]);
      try {
-       const res = await fetch(url, { ...reqOpts, signal });
+       const res = await fetch(url, { ...reqOpts, signal: combinedSignal });
+     } finally {
+       clearTimeout(timeoutId);
+     }
      ...
    }
  }
```

- **효과**: 504 대기 시간 60+초 → 45초. 클라 retry가 더 빠르게 다음 시도로 진입.
- **주의**: `upload-chunk`는 3.5MB 본문 전송 시간이 모바일 회선에서 45초를 넘길 수 있음. 라벨별로 타임아웃을 다르게 줘야 안전 (`upload-chunk`는 90s, `prepare`/`transcribe`는 45s).
- **주의**: `AbortSignal.any`는 비교적 신규 API. iOS Safari 17+ 필요. fallback은 수동 listener 결합.
- **취지**: 세션 abort와 per-request 타임아웃을 분리해서 둘 다 작동하게.

### 4. (선택) 녹음 종료 직후 stagger

**파일**: `meeting-notes/app.js:442` (`startSegmentPipeline`)

stop 시점에 큐에 쌓인 세그먼트들이 동시에 prepare 단계로 들어가지 않도록, 세션 phase가 `awaiting`으로 전환되는 시점부터 prepare 시작 사이에 세그먼트 인덱스 기반 짧은 지연(`segmentIndex * 1500ms`)을 둠.

- **상태**: 1번(동시성 1)으로 자연스럽게 해결될 가능성 큼. 1번 적용 후에도 타임아웃이 잔존할 때만 추가.

---

## 📋 적용 순서

**1단계 (다음 달 첫 실 사용)**: 변경 1번만 적용.

- 가장 작고 되돌리기 쉬움.
- 1~2회 실측. UI 에러 발생 여부 + Vercel 사용량 증가 속도 관찰.

**2단계 (1단계 후 잔존 시)**: 변경 2번 추가.

- 서버 retry 약화로 함수-시간 출혈 차단.
- Vercel 사용량 곡선이 평탄해지는지 다음 결제 주기로 확인.

**3단계 (2단계 후 잔존 시)**: 변경 3번 추가, 필요 시 4번.

- 클라이언트 타임아웃 도입은 라벨별 분기 + AbortSignal 호환성 확인이 필요해 가장 마지막.

---

## 🧪 검증 체크리스트 (다음 달)

각 단계 적용 후 1회 실사용 기준으로 확인:

- [ ] 30분 이상 회의 1건 녹음 → 종료 직후 모든 세그먼트가 UI 에러 없이 `done`까지 도달.
- [ ] 처리 시간이 체감상 견딜만한 범위 (목표: 회의 길이의 10~20% 내에 완료).
- [ ] Vercel Hobby 사용량 알림이 사용량 곡선 기울기에 미치는 변화 (월말 알림 메일 기준).
- [ ] 실패 시 `진행로그_<date>_<title>.txt`가 Notion에 첨부되었는지 확인 (finalize 도달 여부).

## 🚨 검증 보류 이유

- Vercel Hobby 사용량 75% 알림 수신 상태. 인위적 재현 테스트 1회당 60초 × N 함수 호출이 발생 → 월간 한도 소진 위험.
- 다음 달 결제 주기 리셋 후 실 사용 케이스로 검증.

---

## 📚 관련 자료

- 최초 60초 타임아웃 문제: [WORK-LOG.md](./WORK-LOG.md) "🎯 원본 문제" 섹션
- 5분 세그먼트 분할 도입(근본 해결): [work_log_pr_15.md](./work-log-archive/work_log_pr_15.md)
- 세그먼트 파이프라이닝(클라이언트): [work_log_segment_pipelining_pr1.md](./work-log-archive/work_log_segment_pipelining_pr1.md)
- finalize 재시도 강화: [work_log_finalize_retry.md](./work-log-archive/work_log_finalize_retry.md)
- Gemini Flash 503 + Pro 전환: WORK-LOG 핵심 교훈 3번
- Vercel Hobby 함수 한도: WORK-LOG 핵심 교훈 "Vercel Hobby 플랜 한계"
- 모델 generation 이주 트리거: [Gemini API changelog 2026-06-01](https://ai.google.dev/gemini-api/docs/changelog?hl=ko#06-01-2026) (gemini-2.0 계열 폐기 → 3.x로 이주, 2.5는 동시 이주)
