# 🤝 프로젝트 인계 문서

새 Claude 세션 (claude.ai 웹 또는 PC Claude Code)에서 이 프로젝트를 이어 작업할 때 가장 먼저 읽는 문서.

> 새 세션 시작할 때 이 한 줄로 충분: **"이 리포의 HANDOFF.md 읽고 이어서 작업해줘. https://github.com/rwang2gun/AI-Tips"**

---

## 🎯 프로젝트 목적

회의실에서 모바일(iPad / Android) 하나로:
1. 마이크 녹음 시작 → 회의 진행
2. 종료 버튼 한 번
3. → 자동으로 Notion 회의록 페이지가 생성됨

**핵심 가치**: PC/노트북 안 가져가도 회의록이 정리됨

---

## 👤 사용자 정보

- **GitHub**: `rwang2gun`
- **메인 디바이스**: Windows 11 PC (D:\Claude\AI-Tips), 안드로이드 폰, iPad
- **회의 길이**: 보통 1시간
- **회의 종류**: 게임 기획 (전투, 시스템, 밸런스, UI 관련 토론)
- **Google AI Pro 구독자** (단, API는 별개라서 AI Studio에서 별도 API 키 사용)
- **이미 Notion MCP 연결되어 있음** (claude.ai 웹 + Claude Code 양쪽)

---

## 🏗️ 아키텍처

```
[모바일 PWA — meeting-notes/]
  ├─ MediaRecorder API (WebM/Opus, 32kbps mono)
  └─ 3.5MB 청크로 분할 → 순차 업로드
        ↓
[Vercel 서버리스 — api/process-meeting.js]
  ├─ X-Action: upload-chunk → Vercel Blob에 임시 저장
  └─ X-Action: process     →
        ├─ 모든 청크 결합
        ├─ Gemini Files API에 업로드 → ACTIVE 상태 폴링
        ├─ Gemini 2.5 Flash 호출 (responseSchema로 구조화 JSON)
        ├─ Notion API: 자동 회의록 DB에 페이지 생성 (서식 자동)
        └─ Vercel Blob 청크 정리
        ↓
[모바일에 Notion 페이지 URL 표시]
```

---

## 💡 주요 설계 결정 + 이유

| 결정 | 이유 / 다른 선택지 검토 |
|------|---------------------|
| **Vercel 호스팅** | 무료 티어 충분, GitHub push로 자동 배포. Cloudflare도 검토했으나 친숙도 우선 |
| **Gemini 2.5 Flash** | 오디오 직접 입력 지원 → 전사+요약 1콜로 끝. Whisper+Claude는 2단계 + 비용 더 듦. AssemblyAI는 화자 구분 가능하지만 유료 |
| **무료 Gemini 티어** | 사용자가 비용 0원 원함. ⚠️ 무료는 데이터가 학습에 사용될 수 있음 — 회사 기밀 회의면 유료 전환 권장 (사용자에게 설명 완료) |
| **화자 구분 미구현** | 유료 STT(AssemblyAI 등)가 필요하고 사용자가 무료 우선해서 빼기로 결정 |
| **청크 분할 (3.5MB)** | Vercel Hobby 함수 4.5MB 본문 한도. 1시간 32kbps 오디오 ≈ 14MB → 4청크 |
| **Vercel Blob 임시 저장** | 서버리스 함수는 stateless. 청크 간 상태 공유 필요. 무료 0.5GB 충분 |
| **Notion DB는 사용자가 직접 만듦** | 사용자가 이미 회의록 페이지 + DB(`자동 회의록 DB`)를 만들어둠. 우리는 거기에 페이지를 추가만 함 |
| **참석자/작성자는 수동** | Notion `person` 타입은 워크스페이스 유저 ID 필요 → 음성에서 자동 매핑 어려움 |
| **AI-Tips 리포에 통합** | 사용자가 "클로드로 만든 것들" 포트폴리오 느낌 원함. index.html에 카드 추가 |

---

## 📂 파일 맵

```
AI-Tips/
├── index.html                         # 메인 랜딩 (다크 테마, "실제로 만든 앱" 섹션 포함)
├── claude-notion-guide.html           # 기존 — 업무 가이드 (건드리지 않음)
├── claude-notion-personal-guide.html  # 기존 — 일상 가이드 (건드리지 않음)
│
├── meeting-notes/
│   ├── index.html      # 녹음 UI (녹음 버튼 + 타이머 + 시각화)
│   ├── app.js          # MediaRecorder + 청크 분할 업로드 로직
│   ├── style.css       # 다크 테마 (메인과 통일: --bg #0c0b10, --accent #7c6aef)
│   └── manifest.json   # PWA 매니페스트 (아이콘 PNG는 미작성, TODO)
│
├── api/
│   └── process-meeting.js  # 단일 함수, X-Action 헤더로 분기
│
├── package.json        # @google/genai, @notionhq/client, @vercel/blob
├── vercel.json         # maxDuration 60s, no-store 헤더
├── .env.example        # 환경변수 템플릿
├── .gitignore
│
├── README.md           # 개요
├── SETUP.md            # 9단계 배포 체크리스트 (사용자가 실제 따라가는 문서)
└── HANDOFF.md          # 지금 읽는 이 문서
```

---

## 🔑 환경변수 (Vercel에 등록되어야 함)

| Key | 출처 | 비고 |
|-----|------|------|
| `GEMINI_API_KEY` | aistudio.google.com/apikey | 사용자가 발급해서 Vercel에 직접 입력 (절대 코드/채팅에 노출 금지) |
| `NOTION_TOKEN` | notion.so/my-integrations | Internal Integration 토큰 |
| `NOTION_DATABASE_ID` | `343b23cf-3720-805a-885a-ef6795242b77` | 자동 회의록 DB |
| `NOTION_DATA_SOURCE_ID` | `343b23cf-3720-80d2-b027-000be11d1c08` | 데이터소스 (현재 미사용, 예비) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob 활성화 시 자동 등록 | 수동 입력 X |

---

## 🗂️ Notion 자동 회의록 DB 스키마

**위치**: 회의록 페이지(`343b23cf-3720-8054-8f58-e817d7f6d7dd`) 아래

**속성**:
- `이름` (title)
- `회의 날짜` (date)
- `회의 유형` (select): 킥오프 / 내부 논의 / 실무 논의 / 기타
- `레이블` (multi_select): 전투(green) / 시스템(blue) / 밸런스(orange) / UI(purple)
- `참석자` (person) — **수동 입력**
- `회의록 작성자` (person) — **수동 입력**

**페이지 서식** (회의록 서식 페이지: `343b23cf-3720-80fa-b2e1-e4213af0cee1`):
- 2단 컬럼: 기본 정보(✅) / 후속 진행 업무(🚩)
- 구분선
- 아젠다(📌) — 자동 채움
- 논의 사항(💬) — 자동 채움
- 결정 사항(🎯) — 자동 채움
- To-do(✅) — 자동 채움 (체크박스)

---

## 📊 현재 상태 (2026-04-15 기준)

| 항목 | 상태 |
|------|------|
| 코드 작성 | ✅ 완료 |
| GitHub 푸시 | ✅ 완료 (`9723388`) |
| Vercel 배포 | ⏳ 사용자가 SETUP.md 따라 진행 예정 |
| 환경변수 등록 | ⏳ 미정 |
| Vercel Blob 활성화 | ⏳ 미정 |
| Notion Integration 권한 | ⏳ 미정 |
| 첫 테스트 (1~2분 녹음) | ⏳ 미정 |
| 1시간 회의 실측 | ⏳ 미정 |

---

## ⚠️ 알려진 한계 / TODO

### 미작성
- [ ] PWA 아이콘 (`meeting-notes/icon-192.png`, `icon-512.png`)
- [ ] Service Worker (오프라인 캐싱)
- [ ] favicon

### 미검증
- [ ] 1시간 회의 실측 (청크 분할 로직은 짜뒀음)
- [ ] iOS Safari MediaRecorder 호환성 (코드는 mp4 fallback 포함)
- [ ] Vercel 함수 60초 한도 — 1시간 오디오 처리가 60초 안에 끝나는지

### 후순위 개선
- [ ] 처리 진행률 SSE/스트리밍 (현재는 정적 텍스트만 표시)
- [ ] 화자 구분 옵션 (AssemblyAI/Deepgram 토글)
- [ ] 수동 편집 후 다시 저장 기능
- [ ] 회의 메타 (제목/유형) 입력 UI 개선
- [ ] 음성 명령으로 "회의록 끝" 종료
- [ ] 녹음 중 일시정지 기능

---

## 🚧 다음 작업 후보

사용자가 우선순위 정하면 이걸로 진행:

1. **PWA 아이콘 생성** (SVG → PNG 변환, 5분)
2. **첫 테스트 후 발견된 버그 수정**
3. **실제 1시간 회의 처리 검증 + 필요시 chunked Gemini upload로 전환**
4. **화자 구분 옵션 추가** (AssemblyAI 통합)
5. **다른 "Built with Claude" 앱 추가** (index.html에 새 카드)

---

## 🤝 인계 시 주의사항

### Claude Code (PC, D:\Claude\AI-Tips)
- 로컬 파일 편집 가능
- `git add/commit/push` 가능
- Notion MCP 연결되어 있음 (DB 직접 조회/수정 가능)
- ⚠️ git 사용자: `rwang2gun` / `rwang2gun@gmail.com` (로컬 설정됨)

### claude.ai 웹
- 로컬 파일 편집 불가 → GitHub 웹 편집기 안내만 가능
- 또는 코드 변경사항을 텍스트로 전달 → 사용자가 PC에서 적용
- Notion 커넥터 사용 가능
- 이미지 첨부 가능 (모바일 화면 캡처 디버깅에 유용)

### 절대 하지 말 것
- ❌ `.env.local` 또는 API 키를 git에 커밋
- ❌ 채팅에서 API 키 평문 노출 (Gemini, Notion 모두)
- ❌ `git push --force` (특히 main)
- ❌ 사용자 동의 없이 git config 수정
- ❌ NotebookLM이나 Whisper로 임의 변경 — Gemini 결정한 이유 있음 (위 표 참조)

---

## 📚 참고 링크

- [GitHub 리포](https://github.com/rwang2gun/AI-Tips)
- [SETUP.md (배포 체크리스트)](./SETUP.md)
- [회의록 페이지 (Notion)](https://www.notion.so/343b23cf372080548f58e817d7f6d7dd)
- [자동 회의록 DB (Notion)](https://www.notion.so/343b23cf3720805a885aef6795242b77)
- [회의록 서식 템플릿 (Notion)](https://www.notion.so/343b23cf372080fab2e1e4213af0cee1)
- [Gemini API 키 발급](https://aistudio.google.com/apikey)
- [Notion Integrations 관리](https://www.notion.so/my-integrations)
