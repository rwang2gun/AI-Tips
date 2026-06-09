// Gemini/Google API 오류 분류 유틸.
//
// 429 RESOURCE_EXHAUSTED 는 두 가지 전혀 다른 상황에서 발생한다:
//   ① 일시적 한도 초과(분당 요청 수 초과, 모델 과부하) → 잠시 후 재시도하면 성공.
//   ② 결제 크레딧 소진(prepayment credits depleted) → 결제를 해결하기 전엔
//      몇 번을 재시도해도 영구 실패. 재시도는 시간/비용 낭비일 뿐이며 사용자에겐
//      Gemini 원본 JSON 덩어리가 그대로 노출된다.
//
// 두 케이스를 구분해 ②는 재시도하지 않고 즉시 사용자에게 결제 안내를 보여준다.
// 2026-06-09 회의록 앱 전송 오류 제보(크레딧 소진)로 도입.

// 결제 크레딧 소진/결제 미설정 — 재시도 무의미. 사용자가 AI Studio에서 결제를 해결해야 함.
export function isBillingDepleted(err) {
  const msg = err?.message || '';
  return /prepayment|credits?\b[^.]*\bdepleted|manage your project and billing|please go to ai\.?\s?studio/i.test(msg);
}

// 일시적 오류 — 지수 백오프 재시도 대상. 크레딧 소진은 명시적으로 제외.
export function isRetriable(err) {
  if (isBillingDepleted(err)) return false;
  const status = err?.status || err?.response?.status;
  const msg = err?.message || '';
  return (
    status === 429 || status === 500 || status === 503 ||
    /overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|503|429/i.test(msg)
  );
}
