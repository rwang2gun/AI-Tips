// GoogleGenAI 클라이언트 팩토리.
//
// [환경별 사용 패턴 — 의도적 차이 보존]
//   - serverless (lib/handlers/*): per-request 생성 → cold start마다 새 인스턴스
//   - 로컬 CLI (scripts/*): 모듈 최상위 싱글톤 → 프로세스 lifetime 동안 재사용
//
// 두 패턴을 모두 지원하기 위해 createGeminiClient(opts) 단순 팩토리를 노출.
// 호출자가 자체적으로 싱글톤/per-request 결정.
import { GoogleGenAI } from '@google/genai';

export function createGeminiClient({ apiKey = process.env.GEMINI_API_KEY } = {}) {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }
  return new GoogleGenAI({ apiKey });
}
