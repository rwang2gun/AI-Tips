# AI Tips × Claude × Notion

Claude × Notion 활용 가이드 + 실제로 만들어본 앱 모음.

> 🤖 **새 Claude 세션에서 이 프로젝트를 이어 작업하시나요?**  
> [meeting-notes/docs/HANDOFF.md](./meeting-notes/docs/HANDOFF.md)를 먼저 읽으세요. 아키텍처, 설계 결정, 현재 상태가 모두 정리되어 있습니다.

---

## 🔗 관리 링크

| 서비스 | 링크 | 용도 |
|--------|------|------|
| **Vercel Dashboard** | [vercel.com/rwang2guns-projects/ai-tips](https://vercel.com/rwang2guns-projects/ai-tips) | 배포 관리, 환경변수, Blob, 로그 |
| **Gemini API 사용량** | [aistudio.google.com/spend](https://aistudio.google.com/spend)| API 호출 횟수, 무료 한도 확인 |
| **Notion Integrations** | [notion.so/my-integrations](https://www.notion.so/my-integrations) | Integration 토큰 관리 |
| **GitHub 리포** | [github.com/rwang2gun/AI-Tips](https://github.com/rwang2gun/AI-Tips) | 소스 코드 |
| **자동 회의록 DB** | [Notion](https://www.notion.so/343b23cf3720805a885aef6795242b77) | 회의록 페이지 확인 |

---

## 🗂️ 파일 구성

```
AI-Tips/
├── index.html                         # 메인 랜딩 페이지
├── claude-notion-guide.html           # 업무 가이드
├── claude-notion-personal-guide.html  # 일상 가이드
├── meeting-notes-deck.html            # 스터디 발표용 슬라이드 (11장)
│
├── meeting-notes/                     # PWA — 회의록 자동 생성기
│   ├── index.html                     # 녹음 UI
│   ├── app.js                         # MediaRecorder + 청크 업로드
│   ├── recover.html                   # 실패 세션 재처리 페이지
│   ├── style.css                      # 다크 테마
│   ├── manifest.json                  # PWA 매니페스트
│   ├── icon-192.png / icon-512.png    # 앱 아이콘
│   └── docs/                          # 회의록 앱 관련 문서 모음
│       ├── HANDOFF.md                 # Claude 세션 인계
│       ├── SETUP.md                   # 배포 9단계 체크리스트
│       ├── PIPELINE.md                # 현재 7단계 파이프라인 명세 (MEETING-NOTES-PIPELINE.md)
│       ├── WORK-LOG.md                # 작업 히스토리 (PR별 상세 링크)
│       ├── RECOVERY-PLAN.md           # 4단계 복구/개선 계획
│       ├── REFACTOR-PLAN.md           # 모듈 리팩터 계획
│       └── work_log_*.md              # PR별/이벤트별 상세 (17개)
│
├── api/
│   ├── process-meeting.js             # 서버리스: Gemini 전사 + Notion 생성
│   └── version.js                     # 배포 버전 배지용
│
├── scripts/                           # 로컬 처리/복구 스크립트
│   ├── process-recording-locally.js   # Gemini 직접 호출 전사+요약
│   ├── upload-to-notion.js            # result.json → Notion 페이지
│   ├── recover-session.js             # 세그먼트 실패 세션 복구
│   ├── download-session-audio.js      # Vercel Blob → 로컬 webm
│   ├── split-audio-segments.js        # ffmpeg 5분 분할
│   ├── extract-term-candidates.js     # 유의어 후보 추출
│   └── preview-summarize-prompt.js    # 요약 프롬프트 미리보기
│
├── shared/
│   └── version-badge.js               # 모든 페이지 우하단 버전 배지
│
├── package.json                       # 의존성 (@google/genai, @notionhq/client, @vercel/blob)
├── vercel.json                        # 함수 maxDuration 60s
├── .env.example                       # 환경변수 템플릿
├── .gitignore
└── README.md                          # ← 지금 보는 문서
```

---

## 🎙️ 회의록 자동 생성기

### 동작 원리

```
📱 모바일 PWA (녹음)
    ↓ 3.5MB 청크 분할 업로드
▲ Vercel 서버리스 (Blob 임시 저장 → 결합)
    ↓ Gemini Files API 업로드
✨ Gemini 2.5 Flash (한국어 전사 + 구조화 JSON)
    ↓ Notion API 호출
📝 Notion "자동 회의록 DB"에 페이지 생성
```

### 비용

| 항목 | 무료 한도 | 1시간 회의당 |
|------|----------|-----------|
| Vercel Hobby | 무료 | 0원 |
| Vercel Blob | 0.5GB / 5GB 대역폭 | 0원 (처리 후 즉시 삭제) |
| Gemini 2.5 Flash | 일 1,500 요청 | 무료 티어 내 |
| Notion API | 무제한 | 0원 |

> ⚠️ Gemini 무료 티어는 입력 데이터가 모델 학습에 사용될 수 있음 — 회사 기밀 회의면 유료 티어 전환 권장

---

## 📚 문서 안내

| 문서 | 용도 |
|------|------|
| **[meeting-notes/docs/SETUP.md](./meeting-notes/docs/SETUP.md)** | 처음 배포할 때 따라가는 9단계 체크리스트 |
| **[meeting-notes/docs/HANDOFF.md](./meeting-notes/docs/HANDOFF.md)** | 새 Claude 세션에서 이 프로젝트를 이어 작업할 때 읽는 인계 문서 |
| **[meeting-notes/docs/WORK-LOG.md](./meeting-notes/docs/WORK-LOG.md)** | 작업 히스토리 · 시행착오 · 교훈 (PR별 상세 링크 포함) |
| **[meeting-notes/docs/MEETING-NOTES-PIPELINE.md](./meeting-notes/docs/MEETING-NOTES-PIPELINE.md)** | 현재 7단계 파이프라인 단계별 명세 |
| **[meeting-notes-deck.html](./meeting-notes-deck.html)** | 스터디 발표용 HTML 슬라이드 (14장, 16:9) |

---

## 🔧 로컬 개발

```bash
npm install
cp .env.example .env.local   # 환경변수 채우기
npx vercel dev
```

---

## 📊 현재 상태

| 항목 | 상태 |
|------|------|
| Vercel 배포 | ✅ 완료 |
| 환경변수 + Blob | ✅ 완료 |
| Notion Integration 권한 | ✅ 완료 |
| PWA 모바일 설치 | ✅ 완료 |
| 짧은 테스트 녹음 (30~40초) | ✅ 성공 |
| 1시간 실제 회의 | ⏳ 미검증 |

---

## ⚠️ TODO

- [ ] 1시간+ 실제 회의 검증 (청크 분할은 구현됨, 실측 필요)
- [ ] Service Worker 추가 (오프라인 캐싱)
- [ ] 처리 진행률 SSE/스트리밍
- [ ] 화자 구분 옵션 (AssemblyAI 통합, 유료)
