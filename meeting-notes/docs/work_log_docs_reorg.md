# 문서 폴더 정리 — 회의록 앱 관련 .md 파일을 meeting-notes/docs/로 이동 — 커밋 6123f22

## 왜

루트에 회의록 앱 관련 `.md` 파일이 23개 깔려 있어 구조가 지저분했음. `work_log_pr_01.md` ~ `work_log_pr_15.md` (15개) + 핵심 문서 6개 + 이벤트 문서 2개 = 24개 `.md` 파일 중 README.md 하나만 루트에 필요.

## 이동 범위

`meeting-notes/docs/`로 `git mv`:

| 파일군 | 개수 |
|---|---|
| 핵심 문서 | 6개 (HANDOFF, SETUP, WORK-LOG, MEETING-NOTES-PIPELINE, RECOVERY-PLAN, REFACTOR-PLAN) |
| PR 상세 | 15개 (work_log_pr_01 ~ pr_15) |
| 이벤트 상세 | 2개 (work_log_deck_redesign, work_log_session_78ef84bf) |
| **합계** | **23개** |

루트에 남은 `.md`: **README.md 1개뿐**.

## git mv의 효과

- 모든 파일 **히스토리 보존** (100% similarity로 rename 감지)
- `git blame`, `git log --follow` 정상 동작
- 파일 수정 이력 연속성 유지

## 링크/경로 업데이트

### README.md (루트 유지)

- 라인 6: `./HANDOFF.md` → `./meeting-notes/docs/HANDOFF.md`
- 파일 구성 다이어그램: 신규 구조로 재작성 (meeting-notes/docs/ 하위 트리 추가)
- 문서 안내 테이블: HANDOFF/SETUP 경로 업데이트 + WORK-LOG, MEETING-NOTES-PIPELINE 항목 신규 추가
- 발표 자료 설명 (11장 → 14장 · 16:9) 최신화

### meeting-notes/docs/REFACTOR-PLAN.md

내부 코드 파일 링크에 `../../` 접두사 추가 (문서가 두 단계 깊어졌기 때문):
- `api/process-meeting.js` → `../../api/process-meeting.js` (3회)
- `scripts/process-recording-locally.js` → `../../scripts/process-recording-locally.js`
- `scripts/upload-to-notion.js` → `../../scripts/upload-to-notion.js`
- `meeting-notes/recover.html` → `../recover.html` (3회, 한 단계 위)

### meeting-notes/docs/HANDOFF.md

- 자기 참조 문구 "이 리포의 HANDOFF.md 읽고" → "meeting-notes/docs/HANDOFF.md 읽고"
- 파일 맵 다이어그램을 신규 구조로 재작성 (docs/ 하위 트리 + scripts/ + shared/ 추가)

### scripts/download-session-audio.js

- 커맨드 출력의 안내 메시지 `RECOVERY-PLAN.md` → `meeting-notes/docs/RECOVERY-PLAN.md`

### 메모리 파일 (`.claude/` 외부, `~/.claude/projects/.../memory/`)

- `feedback_gemini_cost_vigilance.md` 내 WORK-LOG 경로 업데이트

## 영향 없음 (검증 완료)

- **내부 상대 링크**: WORK-LOG → work_log_pr_NN.md 등은 같은 폴더로 함께 이동 → 동작 유지
- **HANDOFF 내 `./SETUP.md` 링크**: 동일 폴더 내 이동 → 유지
- **Vercel 함수/URL**: `api/`, 루트 HTML 변경 없음
- **meeting-notes-deck.html URL**: 루트 유지 (기존 Notion embed 호환)
- **메모리 기반 명령**: `node --env-file=.env scripts/...` 형식 그대로 (scripts/ 위치 불변)

## 의도적으로 옮기지 **않은** 것

- `api/*` — Vercel 규약 (자동 라우팅은 `/api/` 디렉토리 필수)
- `scripts/*` — 사용자가 기억하는 명령 경로, `.claude/settings.local.json` 허용 규칙과 연동
- `shared/version-badge.js` — `<script src="/shared/version-badge.js">` 절대경로 참조
- `meeting-notes-deck.html` — 루트 URL이 외부 임베드에 사용됨 가능성
- `index.html`, `claude-notion-*.html` — 랜딩 페이지와 별개 주제 가이드들

## 결과

루트가 시각적으로 깔끔해지고, "회의록 앱" 문맥의 모든 문서가 `meeting-notes/`로 수렴. 다른 앱을 추가하더라도 동일한 패턴(`<app-name>/docs/`)을 따를 수 있는 구조.
