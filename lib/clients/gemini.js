// GoogleGenAI 클라이언트 팩토리.
//
// [환경별 사용 패턴 — 의도적 차이 보존]
//   - serverless (lib/handlers/*): per-request 생성 → cold start마다 새 인스턴스
//   - 로컬 CLI (scripts/*): 모듈 최상위 싱글톤 → 프로세스 lifetime 동안 재사용
//
// 두 패턴을 모두 지원하기 위해 createGeminiClient(opts) 단순 팩토리를 노출.
// 호출자가 자체적으로 싱글톤/per-request 결정.
//
// [백엔드 — GEMINI_BACKEND]
//   - aistudio (기본): apiKey 기반. Files API 사용 가능.
//   - vertex: Vertex AI(project/location + 서비스 계정). 구독 Cloud 크레딧으로 과금.
//             Files API 미지원이므로 오디오는 호출 측에서 인라인(base64)으로 보낸다.
//   백엔드 분기/설정 해석은 gemini-config.js(순수 로직)에 위임.
import { GoogleGenAI } from '@google/genai';
import { isVertexBackend, resolveVertexConfig } from './gemini-config.js';

export { getGeminiBackend, isVertexBackend } from './gemini-config.js';

export function createGeminiClient({ apiKey = process.env.GEMINI_API_KEY } = {}) {
  if (isVertexBackend()) {
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
