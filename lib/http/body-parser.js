// Vercel serverless handler 용 raw body / JSON body 파서.
// bodyParser: false 설정한 엔드포인트에서만 사용.

export async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJsonBody(req) {
  const buf = await readRawBody(req);
  const parsed = JSON.parse(buf.toString('utf-8'));
  // 라우터 catch 블록이 에러 로그를 세션별 Blob에 남길 수 있도록 sessionId 캐시.
  // 대부분의 핸들러는 X-Session-Id 헤더 대신 JSON body에만 sessionId를 실어서 보내기 때문.
  if (parsed && typeof parsed.sessionId === 'string') {
    req._sessionId = parsed.sessionId;
  }
  return parsed;
}

export function jsonResponse(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}
