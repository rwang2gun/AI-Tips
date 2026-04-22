import { listAllBlobs } from '../../lib/clients/blob.js';
import { summarizeBlobs } from '../../lib/storage/usage.js';
import { readJsonBody, jsonResponse } from '../../lib/http/body-parser.js';

// meetings/ 전체를 스캔해 세션별 스토리지 사용량 집계 반환.
// body는 비어도 됨(빈 JSON `{}` 허용). X-Action 라우터가 POST 전용이라 POST로 받음.
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export default async function handleStorageUsage(req, res) {
  // body는 쓰지 않지만 readJsonBody 호출로 라우터의 sessionId 캐싱 규칙을 깨지 않도록 함.
  // (sessionId가 없어도 readJsonBody는 정상 동작; JSON.parse('') 는 실패하지만 빈 POST는
  // 실제로 `{}` 또는 생략을 받음 — 클라에서 '{}' 보내기로 계약)
  try {
    await readJsonBody(req);
  } catch {
    // 빈 body 허용 — parse 실패해도 진행.
  }

  const blobs = await listAllBlobs('meetings/');
  const now = Date.now();
  const result = summarizeBlobs(blobs, {
    nowMs: now,
    cutoffMs: now - TWENTY_FOUR_HOURS_MS,
  });
  return jsonResponse(res, 200, result);
}
