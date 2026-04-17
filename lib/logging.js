// 에러 로그를 Vercel Blob에 보존하는 유틸.
//
// Vercel Hobby 플랜은 함수 로그를 1시간만 보관하므로, 운영 중 장애 추적을 위해
// 핸들러 예외 정보를 별도 Blob(`logs/session-<sid>-<ts>.txt`)으로 저장.
// 본 함수는 fire-and-forget 용도 — 업로드 실패가 본 응답을 깨뜨리지 않도록
// 내부에서 모든 예외를 삼키고 console.error로만 폴백한다.
//
// 호출자(api/process-meeting.js 라우터 catch)는 await 하지만, 실패 시에도
// throw 하지 않아 상위 500 응답 경로를 막지 않는다.

import { putPublic } from './clients/blob.js';

function ts() {
  // ISO-ish 타임스탬프 (파일명에 쓰기 위해 콜론 제거).
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sanitizeSessionId(sessionId) {
  if (typeof sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(sessionId)) {
    return sessionId;
  }
  return 'unknown';
}

function formatBody({ sessionId, action, err, meta }) {
  const lines = [
    `[${new Date().toISOString()}]`,
    `sessionId: ${sessionId ?? 'unknown'}`,
    `action: ${action ?? 'unknown'}`,
    `message: ${err?.message ?? String(err)}`,
  ];
  if (err?.name) lines.push(`name: ${err.name}`);
  if (err?.code != null) lines.push(`code: ${err.code}`);
  if (err?.cause) {
    const cause = err.cause;
    lines.push(`cause: ${cause?.message ?? String(cause)}`);
  }
  lines.push('');
  lines.push('--- stack ---');
  lines.push(err?.stack ?? '(no stack)');
  if (meta && Object.keys(meta).length) {
    lines.push('');
    lines.push('--- meta ---');
    try {
      lines.push(JSON.stringify(meta, null, 2));
    } catch {
      lines.push('(meta not JSON-serializable)');
    }
  }
  return lines.join('\n');
}

// opts.put 주입 시 해당 함수를 사용 (테스트용 DI). 기본값은 Vercel Blob의 putPublic.
export async function logError(sessionId, err, meta = {}, opts = {}) {
  const put = opts.put || putPublic;
  try {
    const safeId = sanitizeSessionId(sessionId);
    const key = `logs/session-${safeId}-${ts()}.txt`;
    const body = formatBody({
      sessionId: safeId,
      action: meta?.action,
      err,
      meta,
    });
    await put(key, body, { contentType: 'text/plain; charset=utf-8' });
    return key;
  } catch (logErr) {
    console.error('[logging] blob upload failed:', logErr?.message);
    return null;
  }
}

// 테스트 전용 export — 포맷만 검증하는 용도.
export const _internal = { formatBody, sanitizeSessionId };
