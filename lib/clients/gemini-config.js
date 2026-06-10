// Gemini 백엔드 선택 + Vertex 설정 해석 + 크레딧 소진 폴백.
//
// SDK(@google/genai)를 import하지 않는 순수 로직만 모아 단위 테스트가 의존성 없이
// 돌도록 분리한다(gemini.js는 이 모듈 + SDK를 합쳐 클라이언트를 만든다).
//
// [백엔드 모드 — GEMINI_BACKEND]
//   - aistudio (기본): GEMINI_API_KEY + Google AI Studio(선불 크레딧). Files API 사용 가능.
//   - vertex: GOOGLE_CLOUD_PROJECT + 서비스 계정/ADC로 Vertex AI 호출(Cloud 후불 과금).
//             Files API 미지원 → 오디오는 인라인(base64) 전송.
//   - auto: aistudio(선불)를 먼저 쓰다가, 선불 크레딧 소진(prepayment depleted) 시
//           해당 요청을 Vertex로 자동 폴백. 선불을 다 쓰면서도 앱은 멈추지 않는다.
//
// 미설정 시 aistudio — 기존 동작을 그대로 보존(안전 기본값).
import { isBillingDepleted } from '../http/gemini-error.js';

const VALID_BACKENDS = new Set(['aistudio', 'vertex', 'auto']);

export function getGeminiBackend(env = process.env) {
  const v = (env.GEMINI_BACKEND || 'aistudio').trim().toLowerCase();
  if (!VALID_BACKENDS.has(v)) {
    throw new Error(`Invalid GEMINI_BACKEND="${v}" (expected "aistudio", "vertex", or "auto")`);
  }
  return v;
}

// 단일 호출에 실제로 쓸 구체 백엔드. 'auto'의 1차 시도는 aistudio.
// createGeminiClient가 backend 미지정 시 이걸로 해석한다.
export function primaryBackend(env = process.env) {
  const mode = getGeminiBackend(env);
  return mode === 'auto' ? 'aistudio' : mode;
}

export function isVertexBackend(env = process.env) {
  return getGeminiBackend(env) === 'vertex';
}

// 크레딧 소진 폴백 실행기.
//   fn(backend) — 주어진 구체 백엔드('aistudio'|'vertex')로 1회 실행하는 비동기 함수.
// auto 모드에서만: aistudio 시도 → isBillingDepleted면 vertex로 1회 재시도.
// aistudio/vertex 단일 모드는 해당 백엔드로 한 번만 실행(폴백 없음).
// 호출 측은 fn 안에서 backend에 맞는 오디오 경로(Files API URI vs 인라인)를 구성해야 한다.
export async function withBillingFallback(fn, env = process.env) {
  const mode = getGeminiBackend(env);
  if (mode !== 'auto') {
    return fn(mode);
  }
  try {
    return await fn('aistudio');
  } catch (err) {
    if (isBillingDepleted(err)) {
      console.warn('[gemini] AI Studio 선불 크레딧 소진 → Vertex로 폴백');
      return fn('vertex');
    }
    throw err;
  }
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
