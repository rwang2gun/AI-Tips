# Vertex AI 백엔드 전환 가이드

회의록 앱의 Gemini 호출을 **AI Studio(선불 크레딧)** 에서 **Vertex AI(Google Cloud 빌링)** 로 전환하는 방법.

## 왜?

- AI Studio Gemini API는 **선불 크레딧(prepay)** 으로 과금되며, 이 지갑은 **Google AI Pro/Ultra 구독이 주는 Google Cloud 크레딧과 분리**돼 있다.
- Gemini를 **Vertex AI 경로**로 호출하면 **Google Cloud 빌링**으로 과금 → 구독 크레딧($10/월 Pro, $100/월 Ultra)을 그대로 사용할 수 있어 **이중 과금을 피한다**.

## 코드는 어떻게 바뀌나 (이미 반영됨)

`GEMINI_BACKEND` 환경변수로 백엔드를 선택한다. **기본값 `aistudio` → 기존 동작 무변경.**

| 백엔드 | 인증 | 오디오 전달 | prepare/check-file |
|--------|------|------------|--------------------|
| `aistudio` (기본) | `GEMINI_API_KEY` | Files API(`files.upload` → `fileUri`) | 사용 |
| `vertex` | GCP 프로젝트 + 서비스 계정 | **인라인(base64)** — Files API 미지원 | prepare는 즉시 ACTIVE 반환, 폴링 생략 |

> **핵심 제약**: Vertex AI는 Gemini **Files API를 지원하지 않는다.** 그래서 vertex 모드에서는 5분 세그먼트 오디오를 요청에 **인라인 base64**로 실어 보낸다(인라인 한도 100MB, 5분 세그먼트 ~2~5MB라 안전). 클라이언트(`app.js`)는 수정 불필요 — `prepare-segment`가 `state:'ACTIVE'`를 반환하면 기존 폴링 로직이 자동으로 건너뛴다.

## GCP 설정 단계

### 1. GCP 프로젝트 + Vertex AI API
1. https://console.cloud.google.com 에서 프로젝트 생성(또는 선택).
2. **Vertex AI API** 활성화: `APIs & Services → Enable APIs → "Vertex AI API"`.
3. 프로젝트에 **결제 계정 연결**(Billing). 구독 Cloud 크레딧이 이 결제 계정에 적용되는지 `Billing → Credits`에서 확인.

### 2. 서비스 계정 (서버용 인증)
1. `IAM & Admin → Service Accounts → Create service account`.
2. 역할: **Vertex AI User** (`roles/aiplatform.user`) 부여.
3. `Keys → Add key → JSON` 으로 키 파일 다운로드.
4. **이 JSON 키는 비밀**이다 — 절대 git에 커밋하지 말 것(`.gitignore`로 보호됨).

### 3. Vercel 환경변수
프로젝트 `Settings → Environment Variables`에 (Production/Preview/Development):

| 변수 | 값 |
|------|-----|
| `GEMINI_BACKEND` | `vertex` |
| `GOOGLE_CLOUD_PROJECT` | GCP 프로젝트 ID |
| `GOOGLE_CLOUD_LOCATION` | 리전 (예: `us-central1`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 위 JSON 키 **파일 내용 전체**를 한 줄로 붙여넣기 |

> 로컬 개발은 `GOOGLE_SERVICE_ACCOUNT_JSON` 대신 `GOOGLE_APPLICATION_CREDENTIALS`(키 파일 경로)로 ADC를 써도 된다.

### 4. 검증
1. 작은 회의를 녹음해 전체 파이프라인(전사 → 요약 → Notion)이 도는지 확인.
2. `Billing → Credits`에서 크레딧이 차감되는지 확인(카드가 아니라 크레딧에서 빠져야 함).

## ⚠️ 확인이 필요한 부분

1. **모델 ID / 리전 가용성** — `gemini-3.5-flash`, `gemini-3.1-pro-preview`가 **Vertex AI에서도 동일 ID로, 선택한 리전에 제공**되는지 확인. AI Studio와 Vertex는 모델 이름·가용 리전이 다를 수 있다. 404가 나면 `Model Garden`에서 정확한 ID/리전을 확인해 상수를 맞춘다.
2. **크레딧 한도** — Pro는 월 $10. 회의 1건당 수십~수백 원이라 가벼운 사용이면 충분하지만, 많이 돌리면 소진된다(소진 시 카드로 넘어가거나 실패).
3. **긴 단일 녹음(로컬 스크립트)** — 인라인 100MB 한도. 수 시간짜리 단일 webm은 초과할 수 있다(스크립트가 90MB 초과 시 경고). 웹앱 세그먼트(5분) 경로는 무관.

## 롤백

문제가 생기면 `GEMINI_BACKEND` 를 `aistudio`(또는 변수 삭제)로 되돌리면 즉시 기존 Files API 경로로 복귀한다. (AI Studio 선불 크레딧 잔액 필요.)
