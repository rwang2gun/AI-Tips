### PR #3 — videoMetadata 세그먼트 전사 (**실패한 시도**)

**가설**: Gemini Files API의 `videoMetadata.startOffset/endOffset`으로 오디오 구간을 지정해 10분 단위로 쪼개면 각 호출이 짧아진다.

**구현**:
- `transcribe` 호출에 `videoMetadata: { startOffset: "Ns", endOffset: "Ms" }` 주입
- 클라이언트가 `durationSec / 600` 회 반복 호출

**결과**: ❌ **완전 실패**. Gemini가 오프셋을 **silently ignore** (video 전용이라 audio엔 효과 없음). 매 호출마다 전체 오디오 처리 → 60초 초과.

**중요한 교훈**:
- 📌 [Gemini Files API는 audio에 `videoMetadata`를 지원하지 않음 (feature request만 열려 있음)](https://discuss.ai.google.dev/t/feature-request-adding-audiometadata-support-in-google-ai-files-api/39869)
- 📌 [video_metadata SDK 이슈](https://github.com/googleapis/python-genai/issues/854)
- 📌 가정을 실제 API 동작으로 검증하지 않고 구현한 것이 잘못. 공식 문서에 "video 전용"이라고 분명히 적혀 있었음.
