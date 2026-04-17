### PR #12 — 5분 세그먼트 분할(로컬) + 유의어 DB + 전사 원문 Notion 첨부

**발견한 새 문제**: 63분 단일 전사 시 Gemini가 generation loop에 빠져 **같은 문장을 70회 반복** 출력. 전사 "내용 자체 품질 저하"의 실체였음.

**구현**:
- `scripts/split-audio-segments.js`: ffmpeg `-c copy`로 5분 단위 stream copy 분할 (재인코딩 없음, 빠름)
- `scripts/process-recording-locally.js`
  - 줄바꿈 후처리: Gemini가 규칙 무시 시 강제 개행
  - `--transcribe-only` 플래그: 세그먼트별 전사 워크플로우 지원
  - **유의어 DB 양단 연동** (NOTION_SYNONYM_DB_ID):
    - 전사 프롬프트엔 **정답 용어만** 주입 (오답을 보여주면 프라이밍 역효과)
    - 전사 후처리: 한글 단어 경계 regex로 "무조건 치환"
    - 요약 프롬프트엔 오인식→정답 **매핑 전체** 주입 → Pro가 맥락 기반으로 전사 오류 복구
- `scripts/upload-to-notion.js`
  - `--transcript` 인자 추가
  - Notion File Upload API 3단계(create → send → attach) 직접 호출
  - 페이지 하단에 `전사원문_{date}_{title}.txt` 파일 블록 첨부 → 사후 품질 검토 가능
- `scripts/extract-term-candidates.js`: 전사 빈도 집계로 유의어 후보 추출 (DB 초기 구축용)
- `scripts/preview-summarize-prompt.js`: API 호출 없이 요약 프롬프트 구성 확인

**중요한 교훈**:
- 📌 긴 오디오 단일 전사 시 **generation loop** 발생 — "thinking OFF + maxOutputTokens 최대"만으로는 부족, 입력 자체를 짧게 잘라야 함
- 📌 유의어 프라이밍은 **정답만** 보여줄 것 — 오답 포함 시 모델이 오답을 선택하는 역효과
