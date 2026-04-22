# 스토리지 가시화 + 수동 정리 UI 계획

> **배경**: Phase 1(commit 5705e02/1ff2575)은 "loop 탐지/짧은 전사 세그먼트만" 오디오를 보존하는 selective retention. 하지만 (a) flag 로직이 놓치는 품질 저하 케이스가 있고(도메인 용어 짜깁기 등 loop도 아니고 길이도 정상 범위), (b) 사용자가 회의록 받자마자 검수 후 재처리할 수 있는 윈도우가 없다. cron 기반 24h 전수 보관은 구현 단순성에 비해 가시성·동의가 약함. 이 계획은 **결과 UI에서 스토리지 사용량을 노출 + 수동 삭제 버튼**으로 전환한다.

---

## 🎯 목표

1. 사용자가 회의 끝난 직후 "서버에 얼마나 남았나"를 숫자로 본다.
2. 사용자가 명시적 액션(버튼)으로 24h 이상된 오디오를 삭제한다 — 자동 만료 없음.
3. flag 로직에 의존하지 않고 **모든 세션의 오디오 + meta.json**을 24h 창 안에서 보존. 재전사의 본질은 오디오이므로 모든 회의에 대해 사후 재전사 가능.
4. `raw.txt`는 현행대로 flagged 세그먼트에만 저장. non-flagged의 raw는 유의어 치환 전후 차이만 있어 저장 가치 낮음 (2026-04-22 Codex 2차 리뷰 결정, 옵션 B).
5. Phase 1의 selective retention 분기를 단순화한다 (retentionIndices 구조 제거).

## ❌ 비목표

- 자동 만료(cron). 명시적 사용자 액션만 삭제 트리거.
- 세그먼트 단위 선택 삭제 UI. 1단계에서는 "24h+ 통째 삭제"만.
- 다른 브라우저/디바이스에서 저장소 관리. 결과 UI 한 화면에 한정.

---

## 🔄 구조 변화 (Before → After)

### Before (현재, 1ff2575 시점)

```
finalize-notion:
  1. Notion 업로드 (transcript + manifest + result page)
  2. cleanup:
     - retentionIndices 계산 (flagged ∪ raw.txt 존재)
     - retentionIndices에 속하면 seg-NN/chunk-*.bin + transcript-NN.raw.txt + transcript-NN.meta.json 보존
     - 그 외 전부 삭제

결과 UI: Notion 링크 + 새 회의 버튼만.
```

### After

```
finalize-notion:
  1. Notion 업로드 (동일)
  2. cleanup (축소):
     - transcript.txt, transcript-NN.txt, result.json 삭제 (Notion에 박제됨)
     - 오디오 + meta.json 은 전 세그먼트 보존 (retention 판정 없음)
     - raw.txt 는 flagged 세그먼트에만 존재 (transcribe-segment에서만 생성, 변경 없음)

결과 UI:
  - Notion 링크 (기존)
  - 서버 저장소 요약 (신규)
  - [24h+ 오디오 정리] 버튼 (신규)
  - 새 회의 버튼 (기존)

스토리지 정리 트리거:
  - 결과 UI 진입 시 /api/storage-usage 호출
  - 버튼 클릭 시 /api/cleanup-old-audio 호출 → 완료 후 재조회로 UI 갱신
```

---

## 🧩 API 계약

> HTTP 메서드는 **둘 다 POST**. `api/process-meeting.js`가 비-POST 요청을 405로 거부하고, 다른 X-Action과 일관성을 유지하기 위함. 의미상 `storage-usage`는 조회성이지만 기존 라우팅 패턴을 따름.

### POST (X-Action: `storage-usage`)

Vercel Blob 루트를 `meetings/` 전체 스캔 → 세션별 집계.

**Request**: body 불필요(빈 JSON `{}` 허용). `x-app-token` 통과 필수 (기존 게이트).

**Response**:
```json
{
  "totalBytes": 54321098,
  "totalFiles": 87,
  "deletableBytes": 34000000,
  "deletableFiles": 58,
  "stuckBytes": 2000000,
  "stuckFiles": 2,
  "cutoffIso": "2026-04-21T13:00:00Z",
  "sessions": [
    {
      "sessionId": "d1f0030f-3f08-4dff-a03c-293fc9085ff2",
      "totalBytes": 18500000,
      "deletableBytes": 18500000,
      "stuckBytes": 0,
      "files": 15,
      "oldestUploadedAtIso": "2026-04-22T10:05:00Z",
      "newestUploadedAtIso": "2026-04-22T11:12:00Z",
      "ageExceeds24h": false,
      "stuck": false
    }
  ]
}
```

- `ageExceeds24h` 기준: `newestUploadedAtIso <= now - 24h` (세션 단위 판정).
- `deletableBytes/Files`는 **화이트리스트 매칭 blob(`seg-*/chunk-*.bin`, `transcript-*.raw.txt`, `transcript-*.meta.json`) 중 세션이 24h 초과인 것들의 합**. cleanup 실행 시 실제로 제거되는 byte 수와 동일(재동기화 보장).
- `stuckBytes/Files`는 **화이트리스트 밖 잔존 파일(`transcript.txt`, `transcript-NN.txt`, `result.json`)의 합**. Notion 페이지 생성 실패로 남은 failed-finalize 세션을 식별. cleanup API로는 삭제 안 되고 사용자가 수동 개입해야 함.
- 세션 레코드에서도 같은 구분을 내려줌(`deletableBytes`/`stuckBytes` per-session).
- **이 설계가 제공하는 invariant**: cleanup 호출 후 `remainingTotalBytes == previousTotalBytes - previousDeletableBytes`.

### POST (X-Action: `cleanup-old-audio`)

24h 이상 지난 세션의 **오디오/raw/meta만** 삭제. 파생 결과물은 절대 건드리지 않음.

**Request**: body 불필요(빈 JSON `{}` 허용). 내부적으로 storage-usage와 동일 기준 적용.

**Response**:
```json
{
  "deletedSessions": 3,
  "deletedFiles": 60,
  "freedBytes": 36000000,
  "remainingTotalBytes": 18500000
}
```

**삭제 대상 패턴 (엄격 화이트리스트)**:
- `meetings/<sid>/seg-*/chunk-*.bin` (오디오 청크)
- `meetings/<sid>/transcript-*.raw.txt`
- `meetings/<sid>/transcript-*.meta.json`

**절대 삭제 금지 (failed-finalize 회복 경로 보존)**:
- `meetings/<sid>/transcript.txt`, `meetings/<sid>/transcript-NN.txt`, `meetings/<sid>/result.json`
- 이들은 정상 finalize 시 Notion 업로드 직후 삭제됨. **Blob에 남아 있다는 건 Notion 페이지 생성이 실패했다는 신호** — `handleFinalizeNotion`은 `result.json` 존재를 재시도 트리거로 삼음(없으면 400 반환). 24h 경과했다고 자동 삭제하면 회복 가능한 실패 세션을 영구 소실시킴. 이 범주의 정리는 cleanup UI가 아니라 사용자가 의식적으로 판단하는 **별도 수동 경로(scripts/list-blob-sessions.js로 확인 후 수동 del)**에 둠.

### 공통 제약

- **Vercel 60s 타임아웃**: 대량 삭제 시 `del([...urls])` 한 번에 수백 개까지는 OK (Vercel Blob 내부 배치). 안전하게는 **세션 단위로 병렬 처리**하고 최대 N세션씩 끊어서 호출 — 1단계에서는 단순 `del(urls)` 일괄 + 시간 초과 시 다음 호출이 이어받는 패턴(idempotent).
- **Idempotency**: 재호출해도 안전해야 함 — 삭제 대상이 이미 없으면 no-op.
- **App access gate**: 기존 `APP_ACCESS_TOKEN` 헤더 검증을 상속.

---

## 🛠 구현 상세

### `lib/storage/usage.js` (신규 — 순수 함수)

```
const CLEANUP_WHITELIST = [
  /\/seg-\d+\/chunk-\d+\.bin$/,
  /\/transcript-\d+\.raw\.txt$/,
  /\/transcript-\d+\.meta\.json$/,
];

export function isCleanupTarget(pathname) {
  return CLEANUP_WHITELIST.some((re) => re.test(pathname));
}

export function summarizeBlobs(blobs, { nowMs, cutoffMs }) {
  // sessionId별로 그룹핑 (scripts/list-blob-sessions.js 로직 재활용)
  // 각 blob에 대해:
  //   - 세션 oldest/newest uploadedAt 갱신
  //   - isCleanupTarget(pathname) 이면 "whitelist bytes" 누적, 아니면 "stuck bytes" 누적
  // 세션 레벨 플래그:
  //   ageExceeds24h = newestUploadedAtMs <= cutoffMs
  //   stuck = stuckBytes > 0
  // 세션의 deletableBytes = ageExceeds24h ? whitelistBytes : 0
  //   (진행 중 세션은 화이트리스트 파일이 있어도 삭제 금지)
  // 전역 합계:
  //   deletableBytes = Σ session.deletableBytes
  //   stuckBytes     = Σ session.stuckBytes
  //   (stuck은 24h 여부와 무관하게 집계 — UI가 "쌓이고 있다" 신호만 주면 됨)
  // 반환: { totalBytes, totalFiles, deletableBytes, deletableFiles,
  //        stuckBytes, stuckFiles, cutoffIso, sessions[] }
}
```

**이유**: 테스트 가능성 + `cleanup-old-audio` 핸들러와 정의 공유(drift 방지). `isCleanupTarget`을 단일 소스로 두고 storage-usage/cleanup이 같이 import.

### `api/handlers/storage-usage.js` (신규)

- `listAllBlobs('meetings/')` 호출 → `summarizeBlobs(blobs, { nowMs: Date.now(), cutoffMs: Date.now() - 24h })`
- `jsonResponse(res, 200, result)` 반환.

### `api/handlers/cleanup-old-audio.js` (신규)

- `listAllBlobs('meetings/')` 호출
- `summarizeBlobs`로 deletable 세션 식별
- 각 deletable 세션의 오디오/raw/meta 패턴 매칭 파일 URL을 수집
- `del(urls)` 일괄 호출
- 삭제 후 재스캔 → `remainingTotalBytes` 반환

### `api/process-meeting.js`

- handlers 맵에 `storage-usage`, `cleanup-old-audio` 등록.

### `api/handlers/finalize-notion.js` (단순화)

- 현재의 `retentionIndices` 기반 selective cleanup 삭제.
- 새 정책: **Notion 업로드에 이미 박제된 파생 파일만 삭제**.
  ```
  정상 finalize 완료 시 삭제:
    - meetings/<sid>/transcript.txt        (Notion에 transcript 첨부 완료)
    - meetings/<sid>/transcript-NN.txt     (merge 이후 불필요)
    - meetings/<sid>/result.json           (요약 → page-builder 결과 이미 Notion 페이지에 반영)
  보존 (24h 이상 지나면 cleanup-old-audio UI로 삭제):
    - seg-*/chunk-*.bin
    - transcript-*.raw.txt (flagged 세그먼트만 존재)
    - transcript-*.meta.json
  Notion 생성 실패 시 (throw):
    - cleanup 전체 스킵. result.json이 남아 다음 finalize 재시도 트리거가 됨.
  ```
- `raw.txt`의 생성 정책은 **변경 없음** — `transcribe-segment.js`에서 flagged 세그먼트에만 저장(2026-04-22 Codex 2차 리뷰 옵션 B). non-flagged 세그먼트는 유의어 치환 전후가 거의 동일해 저장 가치 낮음.
- `buildManifest` 반환값에서 `retentionIndices` 의존 제거. `flaggedSegments`는 계속 사용 (경고 섹션용).
- 호환: `buildManifest`가 `retentionIndices`를 계속 계산해 반환해도 무해(다른 호출자 없음). 제거보다 "deprecated 주석" 수준으로 남기고 다음 정리 타이밍에 완전 제거.

### `meeting-notes/app.js` + `index.html` (UI)

- `index.html`의 `<section id="result">`에 추가 블록:
  ```html
  <div class="storage-panel">
    <div class="storage-line">
      <span>서버 저장소</span>
      <strong id="storageTotal">계산 중…</strong>
    </div>
    <div class="storage-line muted">
      <span>24h+ 삭제 가능</span>
      <strong id="storageDeletable">—</strong>
    </div>
    <button class="ghost-btn" id="cleanupBtn" type="button" disabled>24h+ 오디오 정리</button>
  </div>
  ```
- `app.js`의 `showResult(data)` 끝에서 `refreshStorageUsage()` 호출.
- `refreshStorageUsage()`: fetch `storage-usage` → UI 갱신. `deletableBytes > 0` 이면 버튼 enable. `stuckBytes > 0` 이면 별도 라인에 "회복 필요 세션 N개"를 경고로 표시(1단계에서는 숫자 노출만, 클릭 UI는 비목표).
- `cleanupBtn.onclick`: confirm dialog → fetch `cleanup-old-audio` → 성공 시 토스트/inline 메시지 + `refreshStorageUsage()` 재호출.

---

## ⚠️ 엣지 케이스

1. **진행 중 세션이 cleanup에 휘말림**: 다른 사용자가 회의 녹음 중일 때 cleanup 버튼을 누르면 현재 세션 Blob이 24h 이상인 경우는 없으므로 영향 없음. 다만 **현재 세션의 finalize가 진행 중**일 때 cleanup이 같은 prefix를 건드리면 race 가능 — 기본적으로 "세션 단위 판정"이 24h 기준이라 진행 중(< 24h) 세션은 deletable에서 제외되므로 안전. 명시적으로 validate: cleanup 대상에 현재 세션 sid 포함되면 skip.

2. **Vercel Blob `uploadedAt` 신뢰도**: Blob SDK가 제공. 현재 `scripts/list-blob-sessions.js`에서 이미 사용 중(안정성 검증됨). `null`인 경우 deletable에서 제외(보수적).

3. **부분 삭제 실패**: 일부 파일 삭제가 실패해도 재호출로 이어받음(idempotent). 응답에 `deletedFiles`를 반환해 UI가 "부분적으로 실패한 경우에도 다시 눌러라" 힌트를 줄 수 있음 — 1단계에서는 "재시도" 같은 복잡 UI는 생략.

4. **Notion 생성 실패 후 cleanup** (Codex 리뷰 P1 반영): `finalize-notion`은 Notion 페이지 생성 실패 시 throw → cleanup 미실행 → `result.json`/`transcript.txt`/`transcript-NN.txt` 가 Blob에 남음. 이 상태는 의도적 회복 경로 — 클라가 finalize를 재시도하면 `handleFinalizeNotion`이 `result.json`을 읽어 Notion 생성만 다시 시도. **`result.json` 존재 자체가 "아직 Notion에 못 올렸으니 재시도해라" 신호**. 따라서 이 cleanup API는 해당 파일들을 **절대 건드리지 않음** (위 화이트리스트 참조). 24h 경과된 실패 세션이 쌓이면 사용자가 `scripts/list-blob-sessions.js`로 확인 후 수동으로 `scripts/recover-session.js` 돌리거나 직접 del. 자동 만료 대상 아님.

5. **동시 cleanup 버튼 클릭**: 두 탭에서 동시에 누르면 첫 호출이 파일 삭제, 두 번째는 no-op. 응답 숫자가 달라져도 UI는 재조회로 자동 보정.

6. **대용량 cleanup (수백 MB, 수천 파일)**: Vercel Hobby 60s 한도. 기준 `del()` 호출이 느려져도 단일 세션당 수십 파일 수준이라 10세션 × 20파일 = 200건 정도는 안전. 10세션 초과 시 "다음 호출에서 이어받음" 구조라 UX 자연스러움.

7. **여러 사용자 고려**: 현재 PWA는 단일 사용자(APP_ACCESS_TOKEN 공유) 전제. 다중 사용자 되면 세션 소유자 구분 필요 — 비목표.

8. **브라우저 새로고침 후 결과 UI 진입 불가**: 현재 구조상 결과 UI는 finalize 직후만 표시됨. 세션 종료 후 다시 진입하는 경로 없음. → 스토리지 UI는 항상 "방금 막 끝난 회의 직후의 전체 현황"을 보여주므로 "과거에 잊은 cleanup"은 다음 회의 때 자연스럽게 잡힘. 다만 회의 간격이 매우 긴 경우(예: 2주) 그동안 Blob 누적. 1단계에서는 허용 — 비용/개인정보 리스크 평가 후 2단계에서 보조 UI 추가 고려.

---

## ✅ 테스트

### 단위 테스트 (신규)

- `tests/unit/storage/usage.test.js` (신규)
  - `isCleanupTarget`: 화이트리스트 3종 패턴 true / `transcript.txt`·`transcript-NN.txt`·`result.json` false.
  - `summarizeBlobs`: 세션별 그룹핑, `ageExceeds24h` 경계값, `uploadedAt` null 처리.
  - `summarizeBlobs` 검증 불변식: `deletableBytes + stuckBytes == 24h+세션의 whitelist+stuck 합`.
  - **회귀 가드**: 24h+ failed-finalize 세션(`result.json`만 남음)이 `deletableBytes`에 포함되지 않고 `stuckBytes`로만 집계되는지.
- `tests/unit/api/storage-usage.test.js`? — 핸들러는 얇으므로 stub listBlobs DI로 통합 검증 가능하면 추가, 아니면 skip.

### 회귀

- `finalize-notion` cleanup 변경 후 기존 E2E/수동 테스트 시나리오:
  - 정상 세션: 오디오/raw/meta 남고, transcript.txt/transcript-NN.txt/result.json은 삭제.
  - flagged 세그먼트 있는 세션: 동일 — 세그먼트 구분 없이 전부 보존.

### UI

- 결과 화면 진입 → 스토리지 숫자 표시됨.
- 24h 이내 세션만 있을 때: 버튼 disabled.
- 24h+ 세션 있을 때: 버튼 enabled, 클릭 → 삭제됨, 숫자 0으로 갱신.

---

## 📦 커밋 순서 (권장)

1. `lib/storage/usage.js` + 테스트.
2. `api/handlers/storage-usage.js` + `cleanup-old-audio.js` + `process-meeting.js` 라우팅.
3. `api/handlers/finalize-notion.js` cleanup 단순화 + `manifest.js`에서 `retentionIndices` 보조 역할로 유지.
4. `meeting-notes/index.html` + `app.js` UI.
5. 문서: WORK-LOG.md 갱신, 필요 시 CLAUDE.md 메모.

1~3은 서버만 변경이라 배포 후 기존 UI는 그대로 동작. 4번 배포까지 사이에 수동으로 API를 curl로도 쓸 수 있음.

## 🧭 Phase 1과의 관계

Phase 1의 selective retention 정책을 **대체**함. Phase 1에서 만든 sidecar(meta.json / raw.txt) 구조는 그대로 유지 — "언제 loop이 발생했나"는 manifest의 `## 전사 품질 경고` 섹션으로 계속 노출되고, 사용자가 24h 내에 cleanup 버튼 누르기 전까지는 raw + 오디오까지 같이 남음.

Phase 2(Pro fallback 자동 발동)는 이 계획과 독립. Phase 1 데이터 축적 후 판단.

## 🤔 열려 있는 질문

- [x] HTTP 메서드 — **둘 다 POST로 결정** (라우터 POST-only 제약 + X-Action 일관성).
- [x] raw.txt 전수 보존 여부 — **옵션 B 채택: flagged 한정 유지** (2026-04-22 Codex 2차 리뷰).
- [x] failed-finalize 파생 파일 처리 — **cleanup에서 절대 건드리지 않음** (회복 경로 보존).
- [ ] cleanup이 idempotent하게 작동하려면 Vercel Blob `del()`이 "없는 URL"에 관대한지 확인 필요.
- [ ] `storage-usage`가 1GB 넘는 대용량 blob 목록을 스캔할 때 60s 한도 걸릴 가능성. `listAllBlobs`의 페이지네이션 비용 평가 필요.
- [ ] `oldestUploadedAtIso / newestUploadedAtIso` 대신 "session.createdAt" 같은 세션 시작 시각을 기준 삼는 게 더 직관적인지.
- [ ] 버튼에 confirm dialog 필요한지 (삭제는 되돌릴 수 없음).
- [x] failed-finalize 세션을 API 응답에서 구분 — **`stuckBytes/stuckFiles` + 세션별 `stuck` 플래그로 분리** (2026-04-22 Codex 3차 리뷰 P1 반영).
- [ ] `stuckBytes > 0` 인 세션을 결과 UI에 어떤 형식으로 노출할지 (인라인 경고? 별도 섹션? 개수만 표시?).
