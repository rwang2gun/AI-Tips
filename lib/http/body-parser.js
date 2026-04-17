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
  return JSON.parse(buf.toString('utf-8'));
}

export function jsonResponse(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}
