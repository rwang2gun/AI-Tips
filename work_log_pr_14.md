### PR #14 — 회의록 레이아웃 정리 + 작성 가이드 Notion 연동

**문제 1**: 회의록 페이지가 **파란 콜아웃 덩어리**로만 보여 가독성 저하.
**문제 2**: `topic` 필드가 실질적으로 **아젠다 나열식**(같은 내용이 topic과 agenda에 중복)으로 생성됨.

**구현**:
- **레이아웃** (`upload-to-notion.js`):
  - 메타(기본정보/후속진행): blue_background → gray_background 콜아웃
  - 본문 4섹션: callout 제거 → `heading_2` + bullets
  - 논의 사항: 토픽을 `heading_3`로 승격, 포인트는 평평한 bullets
  - divider로 메타/본문/첨부 3영역 명확히 구분
- **가이드 Notion 연동** (`process-recording-locally.js`):
  - `NOTION_GUIDE_PAGE_ID`에 "회의록 작성 가이드" 페이지 두고 요약 단계에서 자동 로드
  - `fetchGuide()`: 페이지 블록을 markdown-like 평문으로 변환 (heading/paragraph/list/quote/divider/callout/table)
  - 프롬프트에 `[회의록 작성 가이드]` 섹션 주입, 규칙 0번에 "가이드 우선" 명시
  - 결과: **코드 수정 없이 Notion에서만 규칙 튜닝 가능**
- `meetingSchema().topic` description 강화: "50자 이내, 아젠다 나열 금지" (Pro는 schema description을 매우 중시함)

**검증 상태**: 가이드 연동 후 agenda 빈 배열 → 4개 항목으로 자동 재구성 **실증 완료**. topic 간결화는 Pro 503 연속 실패로 **당일 재검증 실패** → PR #15에서 2-pass 방식으로 보강.
