// ============================================================
// 현재 배포의 버전 정보를 반환 (앱 반영 여부 확인용 배지)
// ============================================================
//
// [응답 예]
//   {
//     "version": "2026-04-17 · 7537a16",
//     "sha": "7537a16",
//     "ref": "main",
//     "env": "production",
//     "deployedAt": "2026-04-17T...Z"
//   }
//
// [버전 포맷]
//   production : "{YYYY-MM-DD} · {sha7}"  — 배포 날짜 + 7자리 커밋 해시
//   preview    : "preview · {sha7}"       — Vercel Preview
//   development: "dev"                    — 로컬/환경변수 미주입
//
// [날짜 근거]
//   Vercel은 배포 시각을 환경변수로 직접 제공하지 않으므로, 이 모듈이
//   서버리스 인스턴스에 처음 로드된 시각(= cold start)을 근사값으로 사용.
//   cold start는 새 배포 직후에 발생하므로 실제 배포 날짜와 하루 단위로는
//   일치할 가능성이 높음. warm 상태에서는 같은 값을 계속 반환.
// ============================================================

// 모듈 최초 로드 시 한 번만 평가됨 (handler 호출 시마다 X)
const BOOTED_AT = new Date();

export default function handler(req, res) {
  const sha = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7);
  const ref = process.env.VERCEL_GIT_COMMIT_REF || 'local';
  const env = process.env.VERCEL_ENV || 'development';

  // YYYY-MM-DD (UTC)
  const deployDate = BOOTED_AT.toISOString().slice(0, 10);

  let version;
  if (env === 'production' && sha) {
    version = `${deployDate} · ${sha}`;
  } else if (env === 'preview' && sha) {
    version = `preview · ${sha}`;
  } else {
    version = 'dev';
  }

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(200).json({
    version,
    sha: sha || null,
    ref,
    env,
    deployedAt: BOOTED_AT.toISOString(),
  });
}
