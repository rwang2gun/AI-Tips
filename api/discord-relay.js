// ============================================================
// Discord 웹훅 릴레이 — Claude Code 원격 루틴용 프록시
// ============================================================
//
// [용도]
//   Claude Code 원격 루틴(CCR) 샌드박스가 discord.com 으로의
//   아웃바운드 요청을 차단하므로, vercel.app 도메인을 경유해
//   디스코드 웹훅으로 forward 한다.
//
// [요청]
//   POST /api/discord-relay
//   Header: x-relay-key: <RELAY_KEY 환경변수와 일치>
//   Body  : Discord 웹훅이 받는 표준 JSON (content / embeds 등 그대로)
//
// [응답]
//   디스코드 응답 코드를 그대로 passthrough (성공 시 204)
//   인증 실패: 401, 메서드 오류: 405, 웹훅 미설정: 500
//
// [환경변수] (Vercel Project Settings → Environment Variables)
//   DISCORD_WEBHOOK_URL : 실제 디스코드 웹훅 URL (Production)
//   RELAY_KEY           : 임의 시크릿 (16자+ 권장). 루틴 헤더와 비교용
// ============================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const expectedKey = process.env.RELAY_KEY;
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

  if (!expectedKey || !webhookUrl) {
    return res.status(500).json({ error: 'relay_not_configured' });
  }

  const providedKey = req.headers['x-relay-key'];
  if (providedKey !== expectedKey) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Vercel은 Content-Type 이 application/json 이면 req.body 를 파싱해줌.
  // 다른 형태로 들어와도 그대로 forward 하기 위해 객체면 stringify, 아니면 그대로.
  const payload =
    typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});

  try {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });

    // 디스코드는 성공 시 204 No Content 를 반환. 실패 시 본문에 에러.
    if (r.status === 204) {
      return res.status(204).end();
    }

    const text = await r.text();
    return res.status(r.status).json({
      error: 'discord_returned_error',
      status: r.status,
      body: text.slice(0, 500),
    });
  } catch (err) {
    return res.status(502).json({
      error: 'fetch_failed',
      message: String(err?.message || err).slice(0, 300),
    });
  }
}
