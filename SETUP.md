# 🚀 배포 세팅 체크리스트

회의록 자동 생성기를 처음 배포할 때 따라야 할 순서. 위에서 아래로 한 번 끝내면 됩니다.

---

## ✅ 0단계 — 사전 준비

- [ ] GitHub 계정 (이미 있음 — `rwang2gun`)
- [ ] Google 계정 (Gemini API 키 발급용)
- [ ] Notion 계정 + 자동 회의록 DB ([링크](https://www.notion.so/343b23cf3720805a885aef6795242b77))
- [ ] Vercel 계정 (없으면 GitHub 로그인으로 즉시 생성 가능)

---

## ✅ 1단계 — Gemini API 키 발급

- [ ] [aistudio.google.com/apikey](https://aistudio.google.com/apikey) 접속
- [ ] **Create API key** 클릭 → 새 프로젝트 또는 기존 프로젝트 선택
- [ ] 발급된 키 복사해서 **메모장이나 비밀번호 관리자에 안전하게 보관**
  > ⚠️ 채팅·문서·git 어디에도 절대 노출하지 마세요

**예상 키 형식**: `AIzaSy...` (40자 정도)

---

## ✅ 2단계 — Notion Integration 생성

- [ ] [notion.so/my-integrations](https://www.notion.so/my-integrations) 접속
- [ ] **+ New integration** 클릭
- [ ] 입력값:
  - Name: `회의록 자동 생성기` (자유)
  - Associated workspace: 본인 워크스페이스 선택
  - Type: **Internal**
- [ ] **Save** → 다음 화면에서 **Internal Integration Token** **Show** → **Copy**
- [ ] 토큰 안전하게 보관

**예상 토큰 형식**: `secret_...` 또는 `ntn_...`

---

## ✅ 3단계 — Notion DB에 Integration 권한 부여

- [ ] [자동 회의록 DB 페이지](https://www.notion.so/343b23cf3720805a885aef6795242b77) 열기
- [ ] 우측 상단 **`···`** 메뉴 클릭
- [ ] **Connections** 또는 **연결** 선택
- [ ] **Add connection** → 방금 만든 `회의록 자동 생성기` Integration 검색 → 추가
- [ ] **Confirm** 클릭

> ⚠️ 이걸 안 하면 Notion API가 권한 거부 (`object_not_found`)를 반환합니다

---

## ✅ 4단계 — Vercel 프로젝트 생성

- [ ] [vercel.com](https://vercel.com) 접속 → GitHub로 로그인 (처음이면 가입)
- [ ] **Add New...** → **Project** 클릭
- [ ] `rwang2gun/AI-Tips` 리포 옆 **Import** 클릭
- [ ] 설정:
  - Framework Preset: **Other**
  - Root Directory: `./` (그대로)
  - Build Command: 비워둠
  - Output Directory: 비워둠
- [ ] **Deploy** 클릭 (이때는 환경변수 없어서 함수가 동작 안 하지만 일단 배포만)

배포 완료되면 `ai-tips-xxxxx.vercel.app` 같은 URL을 받습니다.

---

## ✅ 5단계 — Vercel Blob 스토리지 활성화

청크 임시 저장용. 무료 티어 0.5GB로 충분.

- [ ] Vercel Dashboard → 방금 만든 프로젝트 클릭
- [ ] 상단 **Storage** 탭 클릭
- [ ] **Create Database** → **Blob** 선택
- [ ] Name: `meeting-audio` (자유)
- [ ] **Create**
- [ ] 생성 후 자동으로 프로젝트에 연결됨 → `BLOB_READ_WRITE_TOKEN` 환경변수가 자동 등록됨 ✨

---

## ✅ 6단계 — 환경변수 등록

- [ ] Vercel 프로젝트 → **Settings** → **Environment Variables**
- [ ] 다음 4개 추가 (Production / Preview / Development 모두 체크):

| Key | Value |
|-----|-------|
| `GEMINI_API_KEY` | 1단계에서 받은 키 |
| `NOTION_TOKEN` | 2단계에서 받은 토큰 |
| `NOTION_DATABASE_ID` | `343b23cf-3720-805a-885a-ef6795242b77` |
| `NOTION_DATA_SOURCE_ID` | `343b23cf-3720-80d2-b027-000be11d1c08` |

> `BLOB_READ_WRITE_TOKEN`은 5단계에서 자동 등록되어 있어야 합니다 (확인만)

---

## ✅ 7단계 — 재배포

환경변수는 새 배포부터 적용됩니다.

- [ ] Vercel 프로젝트 → **Deployments** 탭
- [ ] 가장 최근 배포 우측 **`···`** → **Redeploy**
- [ ] **Use existing Build Cache** 체크 해제 → **Redeploy**

---

## ✅ 8단계 — 모바일에서 PWA 설치

배포 URL: `https://ai-tips-xxxxx.vercel.app/meeting-notes/`

### iPad / iPhone (Safari)
- [ ] Safari로 위 URL 접속
- [ ] 하단 **공유 버튼** (□↑) 탭
- [ ] **홈 화면에 추가** → **추가**
- [ ] 홈 화면의 "회의록" 아이콘으로 실행

### Android (Chrome)
- [ ] Chrome으로 위 URL 접속
- [ ] 우측 상단 **`⋮`** 메뉴
- [ ] **홈 화면에 추가** 또는 **앱 설치**
- [ ] 홈 화면의 "회의록" 아이콘으로 실행

> 🎤 처음 녹음 시 마이크 권한을 묻습니다 → **허용**

---

## ✅ 9단계 — 첫 테스트

- [ ] 짧은 테스트 회의 (1~2분) 녹음
- [ ] 처리 완료까지 대기 (전사+요약+Notion 페이지 생성, 약 30~60초)
- [ ] 화면에 뜬 **Notion에서 열기 →** 링크 클릭
- [ ] 자동 회의록 DB에 새 페이지가 생성됐는지 확인
- [ ] 서식대로 "기본 정보 / 아젠다 / 논의 사항 / 결정 사항 / To-do" 채워졌는지 확인

---

## 🐛 문제 해결

| 증상 | 원인 / 해결 |
|------|-----------|
| `404` 페이지 | URL 끝에 `/meeting-notes/` 슬래시 빠뜨림 |
| `마이크 권한 필요` | Safari/Chrome 설정 → 사이트 권한에서 마이크 허용 |
| 처리 중 무한 로딩 | Vercel Logs 확인 (보통 환경변수 미등록 또는 Notion 권한 누락) |
| `object_not_found` | 3단계 (Notion DB에 Integration 추가) 누락 |
| `Invalid API key` | 환경변수 오타 또는 키 만료 |
| `BLOB_READ_WRITE_TOKEN not found` | 5단계 (Vercel Blob 활성화) 누락 |
| 1시간 회의 처리 시 타임아웃 | Vercel Hobby 함수는 60초 제한. Pro 업그레이드 또는 분할 처리 필요 |

Vercel Logs 보는 법: 프로젝트 → **Logs** 탭 → 최근 함수 호출 클릭

---

## 📊 비용 추적

월 사용량은 Vercel/Google AI Studio 대시보드에서 확인:
- Vercel: Dashboard → Usage
- Gemini: [aistudio.google.com](https://aistudio.google.com) → 좌측 메뉴 → API key → Usage
- Notion: 무료 무제한
- Vercel Blob: Storage 탭에서 사용량 표시
