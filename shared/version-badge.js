// ============================================================
// 앱 버전 배지 — 페이지 우하단 반투명 표시 (모든 페이지 공통)
// ============================================================
//
// [사용법]
//   각 HTML의 </body> 직전에:
//     <script defer src="/shared/version-badge.js"></script>
//
// [동작]
//   로드되면 document.body 우하단에 작은 칩을 띄우고
//   /api/version을 fetch해서 내용 채움.
//   hover/tap 시 더 진하게 표시.
//   fetch 실패 시 "offline"로 표시.
// ============================================================

(function () {
  'use strict';

  // 이미 삽입돼 있으면 중복 방지 (다른 페이지로 soft-nav 시 재로드 대비)
  if (document.getElementById('app-version-badge')) return;

  const badge = document.createElement('div');
  badge.id = 'app-version-badge';
  badge.setAttribute('aria-label', '앱 버전');
  badge.style.cssText = [
    'position:fixed',
    'right:8px',
    'bottom:8px',
    'z-index:2147483647',
    'font-family:ui-monospace,"SF Mono",Consolas,Menlo,monospace',
    'font-size:11px',
    'line-height:1',
    'color:#fff',
    'background:rgba(0,0,0,0.45)',
    'padding:4px 8px',
    'border-radius:6px',
    'opacity:0.35',
    'transition:opacity 0.2s ease',
    'user-select:none',
    'pointer-events:auto',
    'cursor:default',
    'backdrop-filter:blur(4px)',
    '-webkit-backdrop-filter:blur(4px)',
  ].join(';');
  badge.textContent = '…';

  const showStrong = () => { badge.style.opacity = '0.9'; };
  const showWeak = () => { badge.style.opacity = '0.35'; };
  badge.addEventListener('mouseenter', showStrong);
  badge.addEventListener('mouseleave', showWeak);
  // 모바일: 탭하면 잠깐 진하게
  badge.addEventListener('touchstart', showStrong, { passive: true });
  badge.addEventListener('touchend', () => setTimeout(showWeak, 1500), { passive: true });

  document.body.appendChild(badge);

  fetch('/api/version', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((data) => {
      badge.textContent = data.version || 'unknown';
      // 환경 따라 색상 힌트
      if (data.env === 'preview') {
        badge.style.background = 'rgba(255,140,0,0.55)';
      } else if (data.env === 'development') {
        badge.style.background = 'rgba(120,120,120,0.45)';
      }
    })
    .catch(() => {
      badge.textContent = 'offline';
      badge.style.background = 'rgba(120,120,120,0.45)';
    });
})();
