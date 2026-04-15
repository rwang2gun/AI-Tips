# AI Tips × Claude × Notion

Claude × Notion 활용 가이드 + 실제로 만들어본 앱 모음.

> 🤖 **새 Claude 세션에서 이 프로젝트를 이어 작업하시나요?**  
> [HANDOFF.md](./HANDOFF.md)를 먼저 읽으세요. 아키텍처, 설계 결정, 현재 상태가 모두 정리되어 있습니다.

## 🗂️ 구성

```
AI-Tips/
├── index.html                       # 메인 랜딩
├── claude-notion-guide.html         # 업무 가이드
├── claude-notion-personal-guide.html# 일상 가이드
├── meeting-notes/                   # PWA — 회의록 자동 생성기
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── manifest.json
├── api/
│   └── process-meeting.js           # 서버리스 함수 (Gemini + Notion)
├── vercel.json
└── package.json
```

## 🎙️ 회의록 자동 생성기 — 동작 원리

```
[모바일 브라우저]
  ↓ 마이크 녹음 (WebM/Opus, 32kbps)
  ↓ 3.5MB 청크로 분할 업로드
[Vercel Serverless]
  ↓ Vercel Blob에 청크 임시 저장
  ↓ 결합 → Gemini Files API 업로드
  ↓ Gemini 2.5 Flash로 전사 + 구조화 (JSON 스키마 기반)
[Notion API]
  ↓ "자동 회의록 DB"에 페이지 생성 (서식 자동 적용)
[모바일 브라우저]
  ✅ 생성된 Notion 페이지 링크 표시
```

## 🚀 처음 배포하시나요?

**[👉 SETUP.md — 처음부터 끝까지 체크리스트](./SETUP.md)** 를 따라가세요.  
Gemini API 키 발급 → Notion Integration 생성 → Vercel 배포 → 모바일 PWA 설치까지 9단계로 정리되어 있습니다.

---

## 🚀 Vercel 배포 가이드 (요약)

### 1. GitHub에 푸시
```bash
git add .
git commit -m "feat: meeting-notes PWA + serverless"
git push
```

### 2. Vercel 프로젝트 연결
1. [vercel.com/new](https://vercel.com/new) 접속
2. GitHub 로그인 → `AI-Tips` 리포 Import
3. Framework Preset: **Other**
4. Root Directory: **그대로 (./)**
5. Deploy 클릭

### 3. 환경변수 등록 (Settings → Environment Variables)

| 키 | 값 | 비고 |
|----|-----|------|
| `GEMINI_API_KEY` | `AIza...` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey)에서 발급 |
| `NOTION_TOKEN` | `secret_...` 또는 `ntn_...` | [notion.so/my-integrations](https://www.notion.so/my-integrations)에서 생성 |
| `NOTION_DATABASE_ID` | `343b23cf-3720-805a-885a-ef6795242b77` | 자동 회의록 DB의 ID |
| `NOTION_DATA_SOURCE_ID` | `343b23cf-3720-80d2-b027-000be11d1c08` | 데이터소스 ID (현재는 미사용, 예비) |

### 4. Notion Integration에 DB 권한 부여
1. Notion 워크스페이스에서 **자동 회의록 DB** 페이지 열기
2. 우측 상단 `...` 메뉴 → **Connections** → 방금 만든 Integration 추가
3. (Notion에서 명시적으로 권한을 줘야 API가 페이지 생성 가능)

### 5. Vercel Blob 활성화
1. Vercel Dashboard → Storage 탭 → **Create** → Blob
2. 프로젝트에 연결 (`BLOB_READ_WRITE_TOKEN` 자동 등록됨)

### 6. 모바일에서 PWA 설치
1. 배포된 URL의 `/meeting-notes/` 접속
2. **iOS**: 공유 → "홈 화면에 추가"
3. **Android**: Chrome 메뉴 → "홈 화면에 추가"

## 💰 비용

| 항목 | 무료 한도 | 1시간 회의당 |
|------|----------|-----------|
| Vercel | Hobby (개인용) 무료 | 0원 |
| Vercel Blob | 0.5GB / 5GB 대역폭 | 0원 (즉시 삭제) |
| Gemini 2.5 Flash | 일 1,500 요청 | 무료 티어 내 |
| Notion API | 무제한 | 0원 |

⚠️ **무료 티어는 입력 데이터가 모델 학습에 사용될 수 있음** — 회사 기밀 회의면 Gemini 유료 티어로 전환하세요.

## 🔧 로컬 개발

```bash
npm install
npx vercel dev
```

`.env.example`을 참고해서 `.env.local` 작성.

## ⚠️ 한계 / TODO

- [ ] 1시간+ 회의 검증 (현재 청크 분할은 구현되어 있으나 실측 필요)
- [ ] PWA 아이콘 (icon-192.png, icon-512.png) 추가
- [ ] Service Worker로 오프라인 캐싱
- [ ] 처리 진행률 SSE/스트리밍
- [ ] 화자 구분 (선택) — 추후 AssemblyAI 옵션 추가 가능
