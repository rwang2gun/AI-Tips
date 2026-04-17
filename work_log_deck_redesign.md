# 발표 자료 전면 개편 (16:9 + 내러티브) — 커밋 9bc51c2

기획자 스터디 AI 활용 사례 발표용으로 `meeting-notes-deck.html`을 전면 재작성.

## 왜 새로 썼나

기존 덱은:
- 풀뷰포트 레이아웃이라 Notion embed 시 비례 축소 안 됨
- PR #11~#15 진화 반영 안 됨 (청크 4조각 설명 등 outdated)
- 기술 스펙 나열 중심이라 "무엇을 하려고 했고 어떤 문제를 해결했는지" 스토리텔링 부재

## 16:9 고정 + 컨테이너 쿼리 스케일링

- `stage` (letterbox) > `deck` (container-type:size, 16:9) 구조
- 루트 font-size = `1.6cqw` → 풀스크린 ~31px, 800px embed ~13px
- 모든 크기를 `em` 단위로 통일 → 컨테이너 축소 시 전체 비례 축소
- `@container deck (max-width: 640px)` 에서 nav-dots/counter 숨김, select 폭 조정

## 14장 내러티브

1. Cover (회의록 생성기 with Claude)
2. Why — 회의실에서 생기는 문제
3. Idea — 원하는 흐름
4. v1 — 처음 만든 구조 (PWA → Vercel → Gemini → Notion)
5. Early Success — 30분짜리 회의에선 잘 됐다 (+ cliffhanger)
6. Incident — 70분 회의 실패 (FUNCTION_INVOCATION_TIMEOUT)
7. Root Cause — 60초 한도 + AI 호출 시간
8. Journey — 4번의 시도 (실패/부분/성공 색상 구분)
9. Quality Issues — 반복/오인식/환각 3종
10. Safeguards — 3중 안전장치 (환각 탐지 hero)
11. How It Works — 실제 동작 파이프라인 플로우차트
12. Differentiator — 용어집/가이드/환각 탐지
13. Takeaway — AI와 대화 개발 / 실전에서 깨진다 / AI 한계는 AI에게
14. Closing

## 파이프라인 슬라이드 병렬 처리 시각화

- 녹음 노드에 빨간 점 펄스 애니메이션 ("진행 중")
- Vercel → 전사 화살표 `⇉` (streaming)
- 전사 노드 카드 스택 그림자 + `⚡ ×N 병렬` 배지
- Notion 참조 박스(용어집/유의어, 가이드) ↑ 화살표로 해당 단계 연결
- 하단 강조 박스: "녹음이 끝나기 전부터 전사 시작 · 병렬 처리로 총 시간 단축"

## 네비게이션 강화

- 페이지 점프 드롭다운 (`<select>` 14장 목록)
- 마우스 X1/X2 버튼 → 이전/다음 (브라우저 뒤로가기 차단)
- 휠 스크롤 → 슬라이드 이동 (450ms 디바운스)
- 기존 좌우 방향키 / 터치 스와이프 / 숫자키 / TOC 오버레이 유지
- TOC 열림 시 · `<select>` 위 휠은 무시 (스크롤 보호)

## 반영 미흡 사항 (후속 수정 필요 알려짐)

- 처음 작성 시점엔 "녹음이 끝나기 전부터 전사 시작" 이 실제 구현과 **불일치**했음 (app.js는 녹음 종료 후 처리 시작)
- 파이프라인 도식화는 서버 의도 기준, 클라이언트 구현은 여전히 순차. 실제 코드와 도식이 맞으려면 `processMeeting`도 병렬/스트리밍 전환 필요
