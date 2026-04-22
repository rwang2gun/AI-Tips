# 전사 품질 개선 계획 (후반부 누락/부실 대응)

> **배경**: 2026-04-22 AI 스터디 모임 세션(d1f0030f-3f08-4dff-a03c-293fc9085ff2) 분석 중 "후반부 대화가 회의록에 잘 반영되지 않는다"는 체감 문제 확인. 1차 초안은 요약 단계 truncation이 아니라 **전사 단계 Gemini Flash generation loop**을 주범으로 지목했고, 2026-04-22 Codex 독립 리뷰로 **증거 보존/retention 타이밍/파괴적 치환**의 3대 결함을 교정. 이 문서는 **evidence-first** 로 재구성한 개정판이다.

---

## 🔍 증상과 원인 가설 (교정 후)

### 증상 (2026-04-22 세션 기준)

- 72분 회의 · 15개 세그먼트 · 전사문 57,427 bytes / 24,883자
- merge는 정상(누락 인덱스 없음), 요약(Pro)도 구조적으로 충실
- 그러나 **두 세그먼트가 심각하게 망가짐**:
  - **seg 01 (5:00~10:00)**: 첫 2~3문장 정상 전사 후 "그"라는 한 글자가 수천 번 반복 → 실내용 95%+ 소실. 전형적 **generation loop**.
  - **seg 13 (65:00~70:00)**: 1,483 bytes로 짧음. "컴파일된 걸로 만들고" 미니 loop + 도메인 용어(UbiGi·언리얼 블루프린트) 음절 짜깁기.

### 코드로 확정된 사실

**1. 현재 파이프라인에 출력 loop 방어 장치가 전혀 없다**
- `api/handlers/transcribe-segment.js`는 Flash 응답 텍스트를 그대로 저장. `maxOutputTokens: 65536`, `thinkingBudget: 0`만 설정.
- `lib/prompts/transcribe.js` 프롬프트에 anti-loop 지시 없음.
- `lib/transcript/post-process.js`는 문장 개행(`enforceSentenceBreaks`)과 유의어 치환(`applySynonymReplacements`)만 수행.
- → "5분 분할 후에도 loop가 재발할 수 있다"는 진술은 코드와 모순되지 않음 (완화책이 길이 축소뿐).

**2. per-segment 진단 데이터가 한 조각도 남지 않는다**
- 전사 응답에서 `finishReason`/`usageMetadata`를 꺼내는 경로가 없음.
- `transcribe-segment.js` 응답은 `transcriptLength`만 반환.
- `finalize-notion.js`가 전사 완료 직후 `deleteByPrefix(prefix)`로 전체 세션 Blob을 삭제 → 사후 진단 불가.
- `scripts/recover-session.js`는 Blob의 `seg-NN/chunk-*.bin`을 전제로 동작하므로 cleanup 뒤에는 복구 경로 자체가 사라짐.

**3. 잠재 버그 (계획과 같이 정리할 만한 규모)**
- `lib/audio/chunking.js:42`의 `transcript-\d{2}.txt` regex는 100+ 세그먼트에서 누락 유발. `transcribe-segment.js:18`은 `segmentIndex <= 999`를 허용하므로 현 설계와 불일치.
- `scripts/recover-session.js:67`의 `seg-(\d{2})` regex도 동일 문제.

### 가설로만 남는 것 (코드로 확정 불가)

- **"트리거는 오디오 길이가 아니라 발화 밀도/명확도"** — 현재 파이프라인이 세그먼트별 음량/밀도 진단을 수집하지 않아 **단일 세션 관찰에 기반한 추정**. Phase 1의 진단 sidecar로 데이터 축적 후 검증.
- **요약 truncation 배제** — `summarize.js`에 커버리지 검증/truncation 감지 로직은 없으므로 "코드상 방어 없음". 이번 세션에 한해 Notion 요약이 구조적으로 충실해 기각 판단은 유지하되, 일반 명제로 확장하지 않음.
- **하울링/음향 피드백 배제** — 사용자 현장 확인에 근거 (스피커 OFF, 대화 외 소음 없음). 코드 재검증 불가.
- **merge regex 2-digit 제한이 현 시나리오 무관** — 15개 세그먼트에 한해 맞음. 하지만 **버그는 실재**하므로 Phase 1에 같이 잡음 (아래 참조).

---

## 🛠 수정 방향 (재구성된 3단계)

### Phase 1 — 증거 보존 + 진단 + 프롬프트 방어 (최우선, 파괴적 변경 없음)

**목표**: 다음 회의부터 "왜 망가졌는지"를 확정 가능한 수준으로 기록. transcript 본문은 건드리지 않음. Phase 2 결정을 위한 데이터 기반 구축.

- [ ] **loop 탐지 (non-destructive)** — `lib/transcript/post-process.js`에 `detectLoop(text)` 추가
  - 반환: `{ hasLoop: boolean, longestRun: { token, count, start } | null, totalRepeatedChars: number }`
  - 동일 어절/음절이 연속 N회(예: 20회) 이상 반복되면 loop로 판정
  - **텍스트 치환 안 함** — 검출만. 원본 transcript는 그대로 저장.
  - 서버/로컬(`scripts/process-recording-locally.js`) 양쪽 호출 경로 공유.

- [ ] **per-segment sidecar 저장** — `api/handlers/transcribe-segment.js`에서 transcript-NN.txt 저장과 함께
  - `transcript-NN.meta.json`: `{ model, finishReason, usageMetadata, rawLength, normalizedLength, loopDetected, longestRun, synonymAppliedCount, timestamp }`
  - `transcript-NN.raw.txt`: 유의어 치환 전 원문 (loop 탐지 또는 짧은 transcript인 경우에만 — 일반 세그먼트는 공간 절약을 위해 생략)
  - 서버는 sidecar 저장 실패해도 transcript.txt 업로드는 성공 처리 (진단은 best-effort).

- [ ] **anti-loop 프롬프트 보강** — `lib/prompts/transcribe.js`
  - 규칙 추가: "같은 어절이 3회 이상 반복되는 것으로 들리면 한 번만 적고 `[불분명]`으로 표시 후 다음 발화로 넘어가세요"
  - 새 마커 도입하지 않음 — **기존 `[불분명]` 어휘 재사용**. downstream summarize 호환.
  - `buildSegmentTranscribePrompt`, `buildLocalTranscribePrompt` 양쪽에 반영.

- [ ] **flagged 세그먼트 오디오 retention** — `api/handlers/finalize-notion.js`의 cleanup 정책 수정
  - cleanup 직전 sidecar(`transcript-NN.meta.json`)를 수집해 `loopDetected || rawLength < THRESHOLD`인 세그먼트 식별.
  - 해당 세그먼트의 `seg-NN/chunk-*.bin` + `transcript-NN.raw.txt` + `transcript-NN.meta.json`은 삭제 대상에서 제외.
  - 플래그되지 않은 세그먼트의 오디오는 기존대로 즉시 삭제 (비용 안정).
  - retention 만료: 별도 cron 없이 Phase 2의 `recover-session.js` 재전사 모드에서 사후 cleanup.

- [ ] **manifest에 전사 품질 경고 섹션 추가** — `lib/notion/manifest.js`
  - `buildManifest`가 Blob 나열 시 `transcript-NN.meta.json`도 같이 집계.
  - 새 섹션 `## 전사 품질 경고`: flagged 세그먼트 인덱스 + rawLength + longestRun 요약 + retention 상태.
  - flagged 세그먼트가 0개면 섹션 자체 생략.

- [ ] **regex 동시 정리** — `\d{2}` → `\d+`
  - `lib/audio/chunking.js:42` `selectSegmentTranscriptBlobs`
  - `scripts/recover-session.js:67` seg-NN 매칭
  - 테스트 커버리지 확인 (`tests/unit/audio/chunking.test.js`, recover 스크립트는 통합 테스트 없음)
  - finalize cleanup에서 sidecar 접근 시 같은 패턴 사용.

- [ ] **테스트 추가**
  - `tests/unit/transcript/post-process.test.js`: `detectLoop` 케이스 (정상/loop/짧은 loop/한글 어절 반복).
  - `tests/unit/notion/manifest.test.js` (신규): `buildManifest` 기본 출력 + flagged 세그먼트 섹션 포함 경로 스냅샷.
  - 기존 `chunking.test.js`에 100+ 세그먼트 케이스 추가.

**비용/운영 영향 (Phase 1)**
- Gemini 추가 호출 없음.
- Blob retention: flagged 세그먼트만 선택적 보존 → 평균 세션당 0~2개 × ~1MB 수준 증가.
- Notion 첨부 크기: manifest 몇 KB 증가.

### Phase 2 — 결정론적 Pro fallback + 세그먼트 재전사 경로

**목표**: Phase 1으로 수집한 데이터에서 loop/단축 전사가 반복되는 트리거가 확인되면, 결정적으로 복구 가능한 경로 구축.

- [ ] **서버 인라인 Pro fallback** — `api/handlers/transcribe-segment.js`
  - **Flash → Flash 재시도 경로는 채택하지 않음**. 동일 입력·동일 프롬프트에서 loop가 구조적으로 유발되는 경우 temperature 흔들기만으로는 실패 반복 가능.
  - 대신 loop 탐지 OR 짧은 transcript(N bytes 이하) 시 **즉시 `gemini-2.5-pro` 재호출**.
  - sidecar에 `fallbackUsed: true`, `fallbackFinishReason`, `fallbackUsage` 기록.
  - Vercel 60s 타임아웃 내에 들어가는지 확인 필요 — 초과 시 클라가 같은 세그먼트를 Pro 지정으로 별도 요청하는 경로 설계 (초안: `POST /api/transcribe-segment`에 `?model=pro` 허용).

- [ ] **recover-session.js 세그먼트 지정 재전사 모드**
  - `node scripts/recover-session.js <sid> --retranscribe-seg=01,13 --model=gemini-2.5-pro`
  - 전제: Phase 1의 selective retention으로 flagged 세그먼트 오디오가 Blob에 남아 있을 것.
  - 결과물: `transcript-NN.txt` 덮어쓰기 + `transcript-NN.meta.json.retry-*.json` 이력.
  - 사용 후 수동 merge + summarize 재실행 절차 문서화.

- [ ] **비용 영향 명시**
  - 공식 Gemini Developer API 가격 기준 (출처: https://ai.google.dev/gemini-api/docs/pricing).
  - 입력 토큰: Flash $1/M → Pro $1.25/M → **1.25배**.
  - 출력 토큰: Flash $2.5/M → Pro $10/M → **4배**.
  - 전사는 대체로 입력 >> 출력이라 세그먼트당 증분은 1.5~2배 근방 예상, 단 출력이 큰 loop 재시도에서는 4배에 근접 가능.
  - loop 발생 빈도가 세션당 0~2개 수준이라는 Phase 1 가정 하에 월 비용 미미.

### Phase 3 — 사후 분석 기반 장기 관찰

**목표**: loop이 아닌 "전사 품질 저하" 및 구조적 패턴 분석.

- [ ] **오프라인 RMS/밀도 분석** — **클라 AnalyserNode 실시간 측정 채택하지 않음**
  - 이유: `meeting-notes/app.js`의 AnalyserNode는 UI 시각화에만 쓰이고 세그먼트별 상태 저장 구조 없음. 또한 `autoGainControl: true`라 절대 음량 해석 왜곡.
  - 대안: Phase 1에서 retention된 flagged 세그먼트 오디오를 ffmpeg/librosa로 오프라인 분석 → RMS, 발화 밀도, 침묵 비율 집계.
  - `scripts/analyze-flagged-segments.js` 신규 — flagged 세그먼트 webm에 대해 통계 CSV 출력.

- [ ] **유의어 DB 커버리지 점검**
  - UbiGi, 언리얼(블루프린트/라이브 코딩/엔진 빌드), Claude Code/Codex 생태계 용어 등록 여부 확인.
  - 부족 시 `scripts/extract-term-candidates.js`로 기존 전사에서 후보 추출.

- [ ] **품질 스코어 누적**
  - Phase 1의 sidecar 데이터를 여러 회의에 걸쳐 축적.
  - 장기 관찰 포인트:
    - 동일 세그먼트 시간대(녹음 60분+ 지점)에서 품질 저하 패턴? → Android MediaRecorder 장시간 품질 이슈 가능성.
    - 특정 RMS 임계 이하에서 품질 저하? → AGC/마이크 이슈.
    - 특정 화자 발화 패턴에서 loop 빈발? → 프롬프트 튜닝 방향.

---

## 📝 WORK-LOG 갱신 사항

[WORK-LOG.md 교훈 #6](./WORK-LOG.md) 개정 필요:

```
Before:
6. 긴 오디오 단일 전사 시 generation loop 발생 — 같은 문장 반복 출력.
   thinking OFF로도 해결 안 됨, 입력 자체를 잘라야 함 (PR #12)

After:
6. Gemini Flash generation loop — 입력 분할만으로 완전 방어 불가.
   5분 분할 내부에서도 재발 관찰(2026-04-22 세션 seg 01·13).
   - 코드상 loop 탐지/진단 장치 없었음 → transcript-NN.meta.json sidecar로 수집.
   - 대응은 "치환"이 아니라 "검출 + 원본 보존 + Pro fallback" 순서.
   - 트리거가 발화 밀도/명확도인지는 데이터 축적 후 검증.
```

## ✅ 검증 방법

- **Phase 1 직후**: 다음 회의에서 manifest에 `## 전사 품질 경고` 섹션이 생성되는지 + sidecar가 Blob에 남는지 확인. loop이 없으면 섹션 생략 확인.
- **Phase 1 + 3~5회 누적 후**: flagged 세그먼트가 1건이라도 발생하면 retention된 오디오로 오프라인 재전사 → Flash vs Pro 결과 비교.
- **Phase 2 이후**: Pro fallback 자동 발동률, Vercel 60s 내 완료율, 실사용 비용 증분 측정.
- **회귀**: `npm test` 통과 + manifest 스냅샷/`chunking` 100+ 세그먼트 케이스 통과.

## 🧭 리뷰 기록

- **1차 초안 (2026-04-22)**: Flash 재시도 + `[불명확 N자]` 치환 + temperature 흔들기 중심.
- **Codex 독립 리뷰 (2026-04-22)**: Top 3 결함 지적 — ①per-segment 진단 sidecar 누락, ②retention이 Phase 2로 밀림, ③파괴적 치환이 raw 증거 소실을 야기. 추가로 비용 가정 부정확(1.25x~4x), `[불명확]` 마커 어휘 충돌, `\d{2}` regex 같이 잡을 것 권고.
- **2차 개정본 (현재 문서)**: 위 지적 전면 반영. Phase 1을 evidence-first로 재구성, Flash 재시도 제거, Pro fallback은 Phase 2로 이동하면서 결정론적 발동으로 단순화.
