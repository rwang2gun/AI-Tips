### PR #13 — 앱 버전 배지

**문제**: 코드 수정 후 "실제 배포에 반영됐는지" 즉시 확인할 수단이 없어 잘못된 캐시/버전으로 디버깅하는 실수 반복.

**구현**:
- `api/version.js`: Vercel 환경변수(`VERCEL_GIT_COMMIT_SHA/REF/ENV`)로 버전 JSON 반환. 모듈 cold-start 시각을 배포일 근사값으로 사용. `Cache-Control: no-store`.
- `shared/version-badge.js`: 공통 삽입 스크립트. 우하단 fixed 칩 생성 후 `/api/version` fetch해 채움.
- 5개 페이지에 `<script defer>` 주입: index / meeting-notes / claude-notion-guide / claude-notion-personal-guide / meeting-notes-deck

**버전 표시 규칙**:
- production: `{YYYY-MM-DD} · {sha7}`
- preview: `preview · {sha7}` (주황)
- dev/local: `dev` / offline: `offline` (회색)
