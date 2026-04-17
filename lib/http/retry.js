// Gemini 503/429/일시적 거절을 지수 백오프로 재시도.
// API 기본값은 Vercel 60초 한도 안에 끝나도록 보수적(3회/8s cap).
// 로컬 CLI는 타임아웃 제약이 없어 maxAttempts=6, maxDelayMs=32000 으로
// 오버라이드해 기존 로컬 재시도 정책(2→4→8→16→32s)을 재현한다.
// label 은 진단 로그 prefix — 여러 단계(transcribe/summarize/refine-topic)를
// 병렬로 돌릴 때 어느 호출인지 구분하기 위함.
export async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 2000, maxDelayMs = 8000, label = 'withRetry' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.status || err?.response?.status;
      const msg = err?.message || '';
      const retriable =
        status === 429 || status === 500 || status === 503 ||
        /overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|503|429/i.test(msg);
      if (!retriable || attempt === maxAttempts) throw err;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      console.warn(`[${label}] attempt ${attempt}/${maxAttempts} failed (${status || 'unknown'}): ${msg.slice(0, 120)}; retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
