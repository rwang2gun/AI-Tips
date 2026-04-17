# 세션 78ef84bf 실전 실패 · 복구 · 서버 가이드 반영 — 2026-04-17 저녁

두 번째 실전 실패 케이스. 근본 구조(PR #15 5분 세그먼트 녹음) 도입 이후에도 **운영 관점의 복구 경로**와 **서버/로컬 드리프트** 문제가 드러남.

## 상황

- **세션 ID**: `78ef84bf-19f1-4691-b24c-e8999c072e3e`
- **길이**: 약 45분 (14 세그먼트 예정, 9/14 지점에서 실패)
- **증상**: PWA UI에 "세그먼트 9/14" 표기 후 중단. 재시도 버튼 클릭 시 녹음 초기화면으로 리셋됨

## 증거 분석

Vercel Blob 검사 결과:
- `meetings/<sid>/seg-00/` ~ `seg-08/` (9개 세그먼트 청크 폴더 존재, 각 1.0~1.12MB)
- `meetings/<sid>/transcript-00.txt` ~ `transcript-07.txt` (8개 전사문)
- **seg-08의 transcript 없음** → seg-08 upload-chunk는 성공, 후속 단계에서 실패

실패 지점 가능 범위: `prepare-segment` / `check-file 폴링` / `transcribe-segment` 중 하나.

## 원인 단정 불가 — Vercel Hobby 로그 1시간 보존 제약

사후 분석 시점엔 Vercel 로그 이미 소실. 앞으로 앱 레벨에서 Blob에 에러 JSON을 남기지 않으면 같은 미스터리 반복됨.

## 정황 증거로 추정

로컬 복구 중 seg-08만 Gemini 2.5 Flash 전사에 **106초** 소요 (다른 세그먼트 11초). 이 오디오 내용이 Flash 인식을 지연시키는 특성 있음 → Vercel 60초 한도에선 kill됐을 가능성 높음.

유료 티어라 429 rate limit은 가능성 거의 없음 (사용량 1% 미만).

## 복구 절차

### 1. `scripts/recover-session.js` 신규 작성 (커밋 022900f)

Blob의 `seg-NN/chunk-NNNN.bin` 레이아웃을 인식해 복구:
- seg-NN 폴더별 청크 결합 → `recovered-<prefix>.seg-NN.webm` 개별 파일 생성
- ffmpeg-static `-f concat -c copy`로 병합 (실패 시 libopus 재인코딩 fallback)
- 출력: `recovered-78ef84bf.webm` (9.31MB)

### 2. 잘못된 단일 전사 시도 (중단)

병합본을 `process-recording-locally.js`에 바로 입력 → 45분 단일 오디오 전사 시작. **이건 WORK-LOG PR #12 "generation loop" 시나리오**였음. Claude(나)가 먼저 그 명령을 제시 → 사용자가 "단일오디오면 전사 실패하는거 아니야?" 하고 잡아줌. 즉시 중단.

→ 이 경험이 `feedback_gemini_cost_vigilance` 메모리로 기록됨: 과금 API 명령 제안 전 WORK-LOG의 known-bug와 입력 조건 대조 필수.

### 3. 세그먼트별 순차 전사 (성공)

9개 `recovered-78ef84bf.seg-NN.webm`을 각각 `--transcribe-only`로 전사:
- 세그먼트당 11~12초, seg-08만 106초
- loop 없이 모든 세그먼트 정상 전사 (총 ~3.5분)

### 4. 병합 + 요약 + Notion 업로드

```bash
# 수동 병합 (시간 헤더 포함)
for f in recovered-78ef84bf.seg-*.transcript.txt; do
  printf -- "--- [%d:00 ~ %d:00] ---\n" $((i*5)) $((i*5+5)) >> recovered-78ef84bf.transcript.txt
  cat "$f" >> recovered-78ef84bf.transcript.txt
  i=$((i+1))
done

# 요약 (transcript.txt 있으면 전사 스킵, 요약만 실행)
node --env-file=.env scripts/process-recording-locally.js recovered-78ef84bf.webm

# Notion
node --env-file=.env scripts/upload-to-notion.js recovered-78ef84bf.result.json --transcript=...
```

## 1차 요약 시 agenda 0 발견 → 서버/로컬 드리프트 인지

로컬 요약 결과:
- Title: "몬스터 전투 AI 및 경험 디자인 논의"
- **Agenda: 0 항목** (비어 있음)
- Topic: 52자 (초과)

확인해보니 로그에 `Guide loaded: none`. `.env`에 `NOTION_GUIDE_PAGE_ID` 미설정. 사용자가 추가 후 재확인하려다 **중요한 파생 이슈 발견**:

### 서버(`api/process-meeting.js`)에도 가이드 연동이 빠져 있음 (커밋 038ed82로 수정)

PR #14에서 가이드 Notion 연동을 **로컬 스크립트에만 반영**하고 서버 `handleSummarize`에는 누락. 즉 **PWA 경로로 생성된 모든 회의록은 가이드 규칙(agenda 추출·topic 간결화) 미적용** 상태였음.

수정 내용:
- `fetchGuide()` / `renderPageBlocks()` 헬퍼 신규 추가 (로컬과 동일 로직)
- `handleSummarize`에서 `fetchGlossary()` 옆에 `fetchGuide()` 호출
- promptText에 `${guideText}` 주입
- 작성 규칙 0번 "가이드 우선" 조항 추가

Vercel 환경변수 `NOTION_GUIDE_PAGE_ID` 등록돼 있어야 실 반영. 미등록 시 기존처럼 가이드 없이 진행.

## 로컬 재요약 실증 (가이드 효과)

| 항목 | 가이드 없음 | 가이드 있음 |
|---|---|---|
| Title | 몬스터 전투 AI 및 경험 디자인 논의 | 몬스터 AI 및 전투 편의성 방향성 논의 |
| Topic | 52자 ("상계(흩어지기)" 어색) | 55자 ("산개" 정확, 2-pass 실패) |
| **Agenda** | **0 항목** | **3 항목** ✅ |
| Discussion / Decisions | 3 / 1 | 3 / 2 |

가장 큰 개선은 agenda 0→3. 용어 정확도도 개선됨 (업데이트된 유의어 46개 활용). topic은 가이드로도 50자 내 강제하기 어려운 내용 있음.

## 드러난 구조적 문제 (TODO · 우선순위 높음)

1. **클라이언트 upload-chunk 재시도 없음** — 단일 네트워크 blip 한 번에 전체 abort
2. **재시도 버튼이 실제 재전송이 아님** — `reset()`만 호출하여 녹음 초기 화면으로. 인메모리 `segments[]` 활용 불가
3. **세션 재개 불가** — 실패한 세그먼트부터 이어 처리 못함. 전체 재시작 아니면 로컬 수동 복구만 가능
4. **Vercel Hobby 로그 1시간 보존** → 앱 레벨 에러 로깅 (세션 폴더에 `errors.log.json` 등) 필요

## 비용 정리

| 단계 | 비용 |
|---|---|
| 전사 9회 (Flash, 세그먼트별) | ~20원 |
| 요약 1차 (Pro, 가이드 없이) | ~40원 |
| 요약 2차 (Pro, 가이드 포함 재실행) | ~40원 |
| Topic 재압축 2회 (Pro, 결과 미적용) | ~10원 |
| Notion API · Blob 다운로드 | 무료 |
| **합계** | **~110원** |

원인 명확히 잡았으면 한 번에 끝났을 비용인데, 가이드 로드 누락 → 재실행으로 ~40원 추가 지출. env 설정 및 서버 드리프트 조기 점검이었다면 절감 가능했음.

## 교훈 요약

- 한쪽 경로(로컬)에만 기능 추가하면 반대쪽(서버)의 사용자 체감 품질이 조용히 저하됨. "코드 중복"이 아니라 "사용자 경험이 갈라지는 버그"
- 재시도 버튼이라는 이름이 무색할 만큼 기능 비어 있으면 사용자에게 더 나쁜 시그널 (버튼 있으니 작동한다고 믿음)
- 무료 로그 보존으로는 원인 추적 불가능한 구간이 계속 생김 → 앱이 스스로 증거 남겨야 함
