// @vercel/blob 래퍼.
//
// 라이브러리 자체가 충분히 얇아 직접 re-export 위주. 추가로 자주 쓰는 패턴
// (단일 객체 조회, 텍스트/JSON 가져오기) 만 헬퍼로 추가.
//
// 모든 put 호출은 회의록 파이프라인에서 동일 옵션을 사용하므로
// putPublic 헬퍼가 기본값(public/no random suffix/overwrite)을 적용.
import { put, list, del } from '@vercel/blob';

export { put, list, del };

const DEFAULT_PUT_OPTIONS = {
  access: 'public',
  addRandomSuffix: false,
  allowOverwrite: true,
};

export async function putPublic(key, body, opts = {}) {
  return put(key, body, { ...DEFAULT_PUT_OPTIONS, ...opts });
}

// prefix와 정확히 일치하는 단일 blob (없으면 null).
export async function findBlob(key) {
  const { blobs } = await list({ prefix: key });
  return blobs.find((b) => b.pathname === key) || null;
}

export async function fetchBlobText(key) {
  const blob = await findBlob(key);
  if (!blob) return null;
  const r = await fetch(blob.url);
  return r.text();
}

export async function fetchBlobJson(key) {
  const text = await fetchBlobText(key);
  return text == null ? null : JSON.parse(text);
}

// prefix 하위 모든 blob 정리 (없으면 no-op).
// 호출자가 try/catch로 감싸서 정리 실패가 메인 응답을 깨지 않게 처리.
export async function deleteByPrefix(prefix) {
  const { blobs } = await list({ prefix });
  if (!blobs.length) return 0;
  await del(blobs.map((b) => b.url));
  return blobs.length;
}
