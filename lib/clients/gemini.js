// GoogleGenAI 클라이언트 팩토리.
//
// [환경별 사용 패턴 — 의도적 차이 보존]
//   - serverless (lib/handlers/*): per-request 생성 → cold start마다 새 인스턴스
//   - 로컬 CLI (scripts/*): 모듈 최상위 싱글톤 → 프로세스 lifetime 동안 재사용
//
// [백엔드 — GEMINI_BACKEND: aistudio | vertex | auto]
//   createGeminiClient({ backend }) 로 구체 백엔드를 명시할 수 있다(폴백 시 사용).
//   backend 미지정이면 primaryBackend(env)로 해석 — auto는 1차로 aistudio.
//   백엔드 분기/설정 해석/크레딧 소진 폴백 로직은 gemini-config.js(순수 로직)에 위임.
import { GoogleGenAI } from '@google/genai';
import { primaryBackend, resolveVertexConfig } from './gemini-config.js';

export {
  getGeminiBackend,
  isVertexBackend,
  primaryBackend,
  withBillingFallback,
} from './gemini-config.js';

export function createGeminiClient({ backend, apiKey = process.env.GEMINI_API_KEY } = {}) {
  const effective = backend || primaryBackend();
  if (effective === 'vertex') {
    const { project, location, credentials } = resolveVertexConfig();
    return new GoogleGenAI({
      vertexai: true,
      project,
      location,
      ...(credentials ? { googleAuthOptions: { credentials } } : {}),
    });
  }
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }
  return new GoogleGenAI({ apiKey });
}
