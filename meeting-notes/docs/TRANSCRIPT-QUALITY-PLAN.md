# 전사 품질 개선 계획 (후반부 누락/부실 대응)

> **배경**: 2026-04-22 AI 스터디 모임 세션(d1f0030f-3f08-4dff-a03c-293fc9085ff2) 분석 중 "후반부 대화가 회의록에 잘 반영되지 않는다"는 체감 문제의 구조적 원인 확인. 요약 단계가 아닌 **전사 단계**의 Gemini Flash generation loop + 비정형 오디오 구간 취약성이 주 원인.

---

## 🔍 증상과 확정된 원인

### 증상 (2026-04-22 세션 기준)

- 72분 회의 · 15개 세그먼트 · 전사문 57,427 bytes / 24,883자
- merge는 정상(누락 인덱스 없음), 요약(Pro)도 구조적으로 충실
- 그러나 **두 세그먼트가 심각하게 망가짐**:
  - **seg 01 (5:00~10:00)**: 첫 2~3문장 정상 전사 후 "그"라는 한 글자가 수천 번 반복 → 실내용 95%+ 소실. 전형적 **generation loop**.
  - **seg 13 (65:00~70:00)**: 1,483 bytes로 짧음. "컴파일된 걸로 만들고" 미니 loop + 도메인 용어(UbiGi·언리얼 블루프린트) 음절 짜깁기 + 다중 화자 오버랩 추정.

### 확정된 원인

**1. Gemini 2.5 Flash의 generation loop (5분 분할로도 재발)**
- PR #12에서 "긴 오디오 단일 전사 시 loop 발생 → 5분 분할로 해소"로 박제했으나, **5분 내에서도 발생 가능** 확인.
- 트리거: 오디오 길이가 아니라 **발화 밀도/명확도**.
  - 짧은 지시성 발언 + 침묵 섞인 구간("저거요. 네. 저거 저거요. 음 님." → "그그그..." 진입)
  - 화자의 자연스러운 구절 반복을 "패턴을 이어가라"로 오인

**2. 도메인 용어 집중 구간의 전사 품질 저하**
- seg 13의 UbiGi/언리얼 기술 용어 연속 등장 → Flash가 음절 단위로 엉뚱하게 매핑 ("인데리스트", "웬데스크", "마이크로 만들기")
- 현재 유의어 DB에 해당 분야 용어 커버리지 확인 필요

### 제외된 가설 (디버깅 학습 보존)

- ~~요약(summarize) 단계에서 truncation~~: Notion 회의록과 전사 대조 결과, Pro 요약은 주변 세그먼트 맥락으로 소실된 내용을 부분 복구함. 구조/커버리지 충실.
- ~~하울링/음향 피드백~~: 사용자 확인 — 회의실에서 동영상/유튜브를 켰지만 스피커는 OFF, 대화 외 소음 없음.
- ~~merge regex 2-digit 제한~~: 15개 세그먼트로 현재 시나리오 무관(SEGMENT_SECONDS=300 기준 8시간+ 회의에서만 문제).

---

## 🛠 수정 방향 (3단계)

### Phase 1 — loop 탐지 + 진단 매니페스트 (최우선)

**목표**: 다음 회의부터 즉시 방어 + 원인 확정 데이터 수집. 과금 증가 없음.

- [ ] **loop 탐지 로직** (`lib/transcript/post-process.js` 신규 또는 확장)
  - 같은 어절/음절이 연속 N회(예: 5회) 이상 반복되면 loop 의심
  - 탐지된 loop 구간은 `[불명확 N자]` 마커로 치환 + flag 기록
- [ ] **자동 1회 재시도** ([api/handlers/transcribe-segment.js](../../api/handlers/transcribe-segment.js))
  - loop 탐지 시 같은 Flash로 `temperature: 0.3` 정도 흔들어서 1회 재호출
  - 재시도 결과도 loop면 원본 유지 + Phase 2의 Pro fallback으로 넘김
- [ ] **진단 필드 매니페스트에 기록** ([lib/notion/manifest.js](../../lib/notion/manifest.js))
  - 세그먼트별: `finishReason`, `usageMetadata` (토큰 사용량), `transcriptLength`, `loopDetected`, `retried`
  - 추가로 클라에서 `AnalyserNode` peak/RMS 측정해서 `transcribe-segment` 요청에 포함
  - 매니페스트 출력에 "전사 품질 경고" 섹션 — loop 탐지/짧은 전사/낮은 음량 세그먼트 나열
- [ ] **프롬프트 보강** ([lib/prompts/transcribe.js](../../lib/prompts/transcribe.js))
  - "같은 어절/음절이 3회 이상 반복되는 것으로 들리면 한 번만 적고 멈추세요" 룰 추가
  - Flash가 룰을 100% 지키진 않지만 loop 증폭 억제 효과 기대

### Phase 2 — Pro fallback + 오디오 retention

**목표**: Phase 1로도 복구 안 되는 케이스의 안전망.

- [ ] **Pro fallback** (transcribe-segment.js)
  - Phase 1의 Flash 재시도도 loop면 `gemini-2.5-pro`로 재호출
  - 비용: 세그먼트당 2~3배지만 loop 발생 빈도 낮으므로 전체 비용 영향 미미
  - 매니페스트에 `fallbackUsed: true` 기록
- [ ] **오디오 retention 연장**
  - 현재 finalize 후 cleanup → seg-NN webm을 24~48시간 유지 (또는 loop 탐지된 세그먼트만 Notion 자동 첨부)
  - 사후 수동 재처리 경로 확보 (`scripts/recover-session.js`와 연계)
- [ ] **recover-session.js에 재전사 모드 추가**
  - 특정 세그먼트만 지정해서 다른 모델/프롬프트로 재전사 → transcript-NN.txt 덮어쓰기 → merge·summarize 재실행

### Phase 3 — 도메인 용어 커버리지 + 장기 관찰

**목표**: loop이 아닌 "전사 품질 저하" 케이스 대응.

- [ ] **유의어 DB 커버리지 점검**
  - UbiGi, 언리얼(블루프린트/라이브 코딩/엔진 빌드), Claude Code/Codex 생태계 용어 등록 여부 확인
  - 부족 시 `scripts/extract-term-candidates.js`로 기존 전사에서 후보 추출
- [ ] **세그먼트 품질 스코어 누적**
  - Phase 1의 진단 데이터를 여러 회의에 걸쳐 축적
  - 장기 관찰 포인트:
    - 동일 세그먼트 시간대(예: 녹음 60분+ 지점)에서 품질 저하 패턴? → Android MediaRecorder 장시간 품질 이슈 가능성
    - 특정 오디오 RMS 임계 이하에서 품질 저하? → AGC/마이크 이슈
    - 특정 화자 발화 패턴에서 loop 빈발? → 프롬프트 튜닝 방향

---

## 📝 WORK-LOG 갱신 사항

[WORK-LOG.md 교훈 #6](./WORK-LOG.md) 개정 필요:

```
Before:
6. 긴 오디오 단일 전사 시 generation loop 발생 — 같은 문장 반복 출력.
   thinking OFF로도 해결 안 됨, 입력 자체를 잘라야 함 (PR #12)

After:
6. Gemini Flash generation loop — 오디오 길이뿐 아니라 발화 밀도/명확도가 트리거.
   5분 분할로도 재발 가능(2026-04-22 세션 seg 01·13 재확인).
   - 트리거 패턴: 짧은 지시성 발언+침묵 섞인 구간, 화자의 자연스러운 구절 반복
   - 대응: 입력 분할만으로 불충분 → 출력 레벨 loop 탐지 + 재시도 + Pro fallback 필요
   - 예방(회의 환경): 정상적 회의 패턴이라 환경 개선으로 못 막음 → 코드 레벨 방어 필수
```

## ✅ 검증 방법

- Phase 1 머지 후 첫 회의에서 매니페스트에 loop 탐지/재시도 기록 확인
- 기존 2026-04-22 세션은 오디오 cleanup됐으므로 재현 불가 → 다음 회의부터 데이터 수집
- 회의 3~5회 누적 후 Phase 2 효과(Pro fallback 발동 빈도) 및 Phase 3 패턴 분석
