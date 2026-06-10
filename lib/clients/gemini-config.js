// Gemini 백엔드 선택 + Vertex 설정 해석.
//
// SDK(@google/genai)를 import하지 않는 순수 로직만 모아 단위 테스트가 의존성 없이
// 돌도록 분리한다(gemini.js는 이 모듈 + SDK를 합쳐 클라이언트를 만든다).
//
// [두 백엔드]
//   - aistudio (기본): GEMINI_API_KEY + Google AI Studio. Files API 사용 가능.
//   - vertex: GOOGLE_CLOUD_PROJECT + 서비스 계정/ADC로 Vertex AI 호출.
//     → Google AI Pro/Ultra 구독이 주는 Google Cloud 크레딧으로 과금.
//     ※ Vertex는 Files API 미지원 → 오디오는 인라인(base64)으로 전송한다
//       (prepare-segment/transcribe-segment가 backend로 분기).
//
// GEMINI_BACKEND 미설정 시 aistudio — 기존 동작을 그대로 보존(안전 기본값).

export function getGeminiBackend(env = process.env) {
  const v = (env.GEMINI_BACKEND || 'aistudio').trim().toLowerCase();
  if (v !== 'aistudio' && v !== 'vertex') {
    throw new Error(`Invalid GEMINI_BACKEND="${v}" (expected "aistudio" or "vertex")`);
  }
  return v;
}

export function isVertexBackend(env = process.env) {
  return getGeminiBackend(env) === 'vertex';
}

// Vertex 모드 설정 해석.
//   - project: GOOGLE_CLOUD_PROJECT (필수)
//   - location: GOOGLE_CLOUD_LOCATION (기본 global)
//     ※ 최신 Gemini 모델(2.5+/3.x)은 us-central1 같은 개별 리전이 아니라 global
//       엔드포인트로만 서빙되는 경우가 많음. us-central1로 호출하면 GA 모델인데도
//       404 "Publisher Model ... was not found"가 남 (2026-06-10 gemini-3.5-flash 실측).
//   - credentials: GOOGLE_SERVICE_ACCOUNT_JSON 이 있으면 파싱한 서비스 계정 객체.
//     없으면 undefined → SDK가 ADC(GOOGLE_APPLICATION_CREDENTIALS 파일/메타데이터 서버)에 위임.
//     Vercel 서버리스엔 파일이 없으므로 GOOGLE_SERVICE_ACCOUNT_JSON 주입을 권장.
export function resolveVertexConfig(env = process.env) {
  const project = env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    throw new Error('GOOGLE_CLOUD_PROJECT is not set (required when GEMINI_BACKEND=vertex)');
  }
  const location = env.GOOGLE_CLOUD_LOCATION || 'global';

  let credentials;
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw && raw.trim()) {
    try {
      credentials = JSON.parse(raw);
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is set but is not valid JSON');
    }
  }
  return { project, location, credentials };
}
