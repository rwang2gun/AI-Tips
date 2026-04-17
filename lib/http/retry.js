// Gemini 503/429/일시적 거절을 지수 백오프로 재시도.
// Vercel 60초 한도 안에 끝나도록 maxAttempts/maxDelay 보수적으로 설정.
export async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 2000, maxDelayMs = 8000 } = {}) {
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
        /overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED|503|429/i.test(msg);
      if (!retriable || attempt === maxAttempts) throw err;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      console.warn(`[withRetry] attempt ${attempt}/${maxAttempts} failed (${status || 'unknown'}): ${msg.slice(0, 120)}; retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
