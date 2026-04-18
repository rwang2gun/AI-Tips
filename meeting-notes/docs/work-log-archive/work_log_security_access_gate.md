# 앱 레벨 접근 게이트 (APP_ACCESS_TOKEN) + 외부 유입 사건 대응

**날짜**: 2026-04-18
**브랜치 흐름**: `security/app-access-gate` → `main` (squash, 커밋 `5520fd4`)
**후속 커밋**: `00e3964` — `.env.example`에 `APP_ACCESS_TOKEN` 항목 추가
**배경**: 데이터 손실 미스터리 조사 중 Vercel Blob storage에서 **본인이 녹음하지 않은 세션 3건**(부동산 법률 상담, 서울시 장애인 활동 지원 위원회 회의록 등 민감 콘텐츠)을 발견. 조사 결과 Vercel Free 플랜의 Standard Protection이 Preview만 덮고 Production은 공개 상태라는 구조적 문제가 원인.

---

## 🚨 발견된 외부 유입 사건

### 조사 계기
`3abe5062-734d-439b-8a78-4579a8b800f9` 세션 데이터 손실 원인 추적(서버 merge가 12개 blob fetch했는데 전사 출력이 4섹션 1081자)을 위해 Blob Storage 브라우저를 뒤지던 중 사용자가 `ff7eec7f-e000-4559-a33f-b05eda5f55c8/` 폴더에 transcript 100개 초과 발견. 그 외 모르는 세션 수 개 존재 확인 요청으로 조사 확대.

### 전체 세션 분류 (`scripts/list-blob-sessions.js` 신규 작성)
|  | Session ID | 시간 (KST) | 분류 | 내용 |
|---|---|---|---|---|
| 1 | `79d6ce87-...` | 04-16 12:13 | 본인 | 70분 회의 FUNCTION_INVOCATION_TIMEOUT 실패 (RECOVERY-PLAN 원본) |
| 2 | `78ef84bf-...` | 04-17 12:09 | 본인 | 45분 회의 실전 실패 (WORK-LOG 기록) |
| 3 | `ff7eec7f-...` | 04-18 아침 | 본인 | PR1 검증 134세그먼트 테스트, iPad 제스처로 중단 |
| 4 | `1cb7ac9e-...` | 04-18 **01:06** | **외부** | 환경/홍보 관련 연설 녹음 |
| 5 | `b4dac7af-...` | 04-18 01:17 | 본인 | "가나다라마바사" 마이크 테스트 |
| 6 | `fddccbeb-...` | 04-18 **09:59** | **외부** | **부동산 임대차 법률 상담** (summary까지 완료 = Notion 페이지 생성됨) |
| 7 | `30aac507-...` | 04-18 **11:47** | **외부** | **서울시 장애인 활동 지원 위원회 회의록** |

### 규모 실측
외부 3건으로 소비된 자원:
- Vercel Blob 저장 (수백 KB 단위, 무시 수준)
- 전사(transcribe-segment) Gemini Flash 호출 4회
- 요약(summarize) Gemini Pro 호출 1회 (fddccbeb) ≈ 120원
- finalize-notion으로 **본인 Notion 회의록 DB에 타인 법률 상담 페이지 생성됨** (사용자 수동 삭제 필요)

---

## 🔍 근본 원인

**Vercel Free 플랜의 Deployment Protection이 Preview 한정**. UI에서 "Standard Protection"이 켜져 있어도 Production URL(`ai-tips-six.vercel.app`)은 공개. Pro 플랜($20+/mo)에서 "All Deployments" 옵션이 열리고, $150/mo 추가 옵션에 Password Protection.

사용자는 Free 플랜, 메인 사이트를 사내 AI 스터디에 공개한 상태라 Production은 유지해야 함 → **앱 레벨 차단 필요**.

공격(?) 경로 추정:
- URL 인덱싱/추측으로 `ai-tips-six.vercel.app` 접근
- `/meeting-notes/` 진입 후 녹음 버튼 클릭
- 서버 `/api/process-meeting`이 무제한 처리 → 본인 Gemini/Notion 토큰 소진

---

## 💡 채택 방안 — 앱 레벨 게이트

### 선택지 비교
| 옵션 | 비용 | 보호 범위 | 구현 복잡도 |
|---|---|---|---|
| Vercel All Deployments | $20+/mo | Preview + Prod 완전 | Vercel 설정 1회 |
| Password Protection | $150/mo 추가 | Preview + Prod 완전 | Vercel 설정 1회 |
| Cloudflare Access | 무료 (Free tier 50users) | DNS 전 구간 | 30분+ 도메인 이전 |
| **앱 레벨 게이트** | **무료** | **API 호출 차단** (정적 HTML은 노출되지만 실사용 불가) | **30분 구현** |

앱 레벨 게이트 선택. 정적 HTML 자체를 막진 못하지만 공격자의 목표(Gemini/Notion 소진, 본인 DB 오염)는 완전 차단. 자원 소비 기준 실질적 동등 방어.

### 구현 요약

**서버** ([api/process-meeting.js](../../../api/process-meeting.js))
```js
const expectedToken = process.env.APP_ACCESS_TOKEN;
if (expectedToken) {
  const provided = req.headers['x-app-token'];
  if (provided !== expectedToken) {
    return jsonResponse(res, 401, { error: 'Unauthorized' });
  }
}
```
환경변수 없으면 게이트 비활성 → 로컬 개발 + 기존 배포 호환성 유지. 라우터 최상단에 배치해 모든 X-Action이 보호됨.

**클라** ([meeting-notes/app.js](../../app.js) + [index.html](../../index.html) + [style.css](../../style.css))
- `localStorage['meetingNotes.accessToken']`에 토큰 저장
- 페이지 로드 시 토큰 없으면 🔒 인증 섹션 노출, 나머지 섹션(`recorder`/`processing`/`result`/`error`) 숨김
- `fetchWithRetry` 내부에서 모든 `/api/process-meeting` 호출에 `x-app-token` 헤더 자동 주입
- **401 응답 시**: `clearAccessToken()` + `session.abortController.abort()` + `location.reload()` — 에러 메시지 표시 없이 게이트로 복귀
  - 사용자 제안으로 "왜 틀렸는지" 숨김. 공격자에게 "토큰 존재" 단서 회피

**recover.html** — `window.fetch` 래핑으로 `/api/*` 호출에 자동 헤더 주입 + 401 시 `prompt()`로 재입력. 복구 UI는 개발자용이라 간단하게.

**`.env.example`** — `APP_ACCESS_TOKEN` 항목 + 주석(운영 필수, 로컬 `vercel dev` 시만 필요, 다른 스크립트는 불필요) 추가.

---

## 🧹 블롭 정리 작업

### 신규 스크립트 2종
1. **[scripts/cleanup-blob-session.js](../../../scripts/cleanup-blob-session.js)** — UUID 화이트리스트 검증 + dry-run 기본. `--confirm` 플래그로만 실제 삭제. `@vercel/blob`의 `list()` cursor 페이지네이션, UUID 정규식으로 prefix 실수 방지.
2. **[scripts/list-blob-sessions.js](../../../scripts/list-blob-sessions.js)** — `meetings/` 하위 전체 세션 요약 (파일 수/크기/transcript·audio·merged·summary 존재 여부/첫·마지막 uploadedAt(KST)).

### 실행 결과 (실수로 `.git/.env`에 넣어 첫 1회는 `--env-file=.git/.env`, 이후 루트로 이동)
- `ff7eec7f-...` (아침 134세그먼트 테스트): 268 파일, 24.22 MB → 삭제
- 외부 3건(`1cb7ac9e` / `fddccbeb` / `30aac507`): 12 파일, 0.16 MB → 삭제
- 본인 실패 2건(`78ef84bf` / `79d6ce87`): 22 파일, 23.73 MB → 삭제 (WORK-LOG 기록만 남기고 데이터 정리)
- 최종 잔여: `b4dac7af` (본인 가나다라마바사 마이크 테스트) 1건만 남음

---

## 🧭 배포 후 운영 체크리스트

1. **Vercel env vars에 `APP_ACCESS_TOKEN` 설정** (Production + Preview + Development 3 환경 모두 체크)
   - 값: `openssl rand -hex 32` 또는 비밀번호 관리자 랜덤 생성기, 32자+ 권장
   - Vercel Dashboard → `ai-tips` → Settings → Environment Variables
2. **Production 재배포** — env var 저장은 즉시 반영 안 되고 다음 배포부터 활성. main 머지가 재배포 트리거 역할.
3. **각 디바이스 최초 1회 토큰 입력** — 이후 localStorage 영구 보존. iPad Chrome / 데스크탑 Chrome / 동료 기기 등 각각 1회
4. **공격자가 "토큰 틀림"을 모르게** — 401 시 에러 메시지 없이 리셋. 사용자 피드백으로 의도적 선택.

### Notion DB 수동 정리 필요
`fddccbeb` 외부 세션이 summary까지 완료 → `finalize-notion`이 본인 Notion 회의록 DB에 페이지 생성. **사용자가 2026-04-18 날짜로 모르는 법률 상담 페이지**를 찾아 삭제 + 휴지통 비우기 필요. (스크립트로 Notion API 접근 가능하지만 DB 조회/페이지 식별 로직이 범위 밖이라 수동이 안전)

---

## 📋 관련 부수 작업

### 동일 세션에서 진행됐지만 미머지(rebase 대기)
- **`test/summarize-pro-and-fold-ui`** — 서버 summarize Flash→Pro 전환 + 완료 세그먼트 숨기기 체크박스 (기본 ON)
  - 기능 동작 확인됨 (Preview 38.5s Pro summarize + 체크박스 토글 OK)
  - 머지 보류 사유: 같은 브랜치에서 `3abe5062` 세션 데이터 손실 발생, 앱 버그 여부 미확정 상태에서 main 오염 우려
- **`test/notion-diag-manifest`** — `진행로그_<date>_<title>.txt` Notion 첨부 (서버 Blob 상태 + 세그먼트별 프리뷰 + 녹음 시각 박제). 사후 진단의 영속 경로.
  - `test/summarize-pro-and-fold-ui` 위에 쌓여 있음
  - 둘 다 main(게이트 포함)으로 rebase 후 재검증 필요

### 미해결 미스터리
`3abe5062-734d-439b-8a78-4579a8b800f9` 세션에서 클라 UI는 "세그먼트 12개 done"인데 서버 transcript.txt는 4섹션 1081자. 서버 merge 로그는 GET ×12를 보였지만 출력은 4섹션. Vercel 로그 1시간 만료 + Blob deleteByPrefix 정상 수행으로 **영구 미제**. 다음 세션에서 발생할 경우 `test/notion-diag-manifest`가 진행로그에 박제할 예정.

유력 가설(가장 그럴듯한 것부터):
1. iOS Chrome 마이크 suspend + 가짜 세그먼트(mediaRecorder 살아있지만 audioChunks 실질 없음, Gemini가 짧은 필러 텍스트로 전사해 pipeline `done` 처리)
2. Vercel Blob `list()`의 12 GET이 실제론 페이지네이션 중복(4 unique × 3) 가능성 — 다음 세션에 manifest가 URL 식별해주면 확인 가능

---

## 🎓 교훈

1. **Vercel Free 플랜 Standard Protection은 Preview 한정** — "Enabled"만 보고 Production이 보호된다고 착각. 드롭다운에서 범위 확인 필수.
2. **공개 URL은 곧 API 접근** — 정적 HTML 공개만으로 `/api/*`가 외부 트래픽을 받을 수 있다는 사실. 앱이 자체적으로 자원(Gemini/Notion 토큰)을 소비하는 구조라면 **앱 레벨 게이트는 선택이 아니라 필수**.
3. **Blob `access: 'public'`의 현실** — 쓰기는 토큰 보호되지만 읽기는 URL만 알면 누구나. URL에 UUID 난수가 있어 "사실상 비공개"지만 로그/스크린샷으로 유출 가능성 존재. 민감 세션은 finalize 후 삭제된다는 점이 그나마 방어.
4. **401 UX는 의도적으로 모호하게** — "토큰 틀림" 메시지는 공격자에게 "토큰 존재" 단서. 리셋만 하고 조용히 게이트 복귀가 더 안전.
5. **사건 발견 경로가 "데이터 손실 조사"** — 원래 목적(3abe5062 미스터리)을 놓고 Blob을 뒤지다 부수적으로 발견. 정기 모니터링이 없으면 수 개월 방치 가능. `scripts/list-blob-sessions.js`를 주기적으로 돌려보는 루틴이 필요.
6. **".env 위치" 혼란 재현 방지** — 사용자가 `.env`를 `.git/.env`에 잘못 넣은 사례. `.env.example`이 프로젝트 루트에 있으니 거기와 나란히 두도록 셋업 문서에 명시. 이번 세션에선 `mv .git/.env .env`로 정상화.
