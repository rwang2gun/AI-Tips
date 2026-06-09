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

// 일시적 오류 — 지수 백오프 재시도 대상. 크레딧 소진/모델 부재는 명시적으로 제외.
export function isRetriable(err) {
  if (isBillingDepleted(err)) return false;
  if (isModelNotFound(err)) return false;
  const status = err?.status || err?.response?.status;
  const msg = err?.message || '';
  return (
    status === 429 || status === 500 || status === 503 ||
    /overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|503|429/i.test(msg)
  );
}

// 모델 미존재(404 NOT_FOUND) — 재시도 무의미. Gemini가 preview 접미사 정리/모델 폐기/오타 등으로
// 우리가 호출한 이름을 모를 때 발생. Vercel에서 발생 시 UI에 원본 JSON이 노출되어 진단이 어렵기 때문에
// 호출 측에서 본 헬퍼로 분기하고 `describeModelNotFound`로 사람 친화적 메시지로 변환할 것.
// 2026-06-09 'gemini-3.1-pro' (정식판 미출시, preview만 존재) 호출로 발생한 실 사고로 도입.
export function isModelNotFound(err) {
  const status = err?.status || err?.response?.status;
  const msg = err?.message || '';
  if (status === 404 && /is not found for API version|is not supported for generateContent|NOT_FOUND/i.test(msg)) {
    return true;
  }
  return false;
}

// 404 메시지에서 모델 식별자를 추출 (실패 시 null). UI에 노출할 짧은 안내를 만들 때 사용.
export function extractRequestedModel(err) {
  const msg = err?.message || '';
  // Gemini 응답 형식: "models/gemini-3.1-pro is not found for API version v1beta, ..."
  const m = msg.match(/models\/([\w.\-]+)/i);
  return m ? m[1] : null;
}

// 호출 측 catch에서 throw할 때 쓰는 사람 친화적 메시지.
// 원본 메시지도 끝에 200자까지 보존 — 모델 식별자/버전 등 단서가 거기 있을 수 있음.
export function describeModelNotFound(err, { location } = {}) {
  const model = extractRequestedModel(err);
  const where = location ? ` (${location})` : '';
  const head = model
    ? `[모델 부재] Gemini 모델 '${model}'을(를) 찾을 수 없습니다 (404 NOT_FOUND)${where}.`
    : `[모델 부재] Gemini가 요청한 모델을 찾지 못했습니다 (404 NOT_FOUND)${where}.`;
  const hint = `모델이 폐기/이름 변경되었거나 preview 접미사가 정리되었을 수 있습니다. 정확한 이름으로 상수를 갱신하세요. 예: 'gemini-3.1-pro-preview' (정식판 미출시 단계에서는 '-preview' 필수).`;
  const orig = err?.message ? ` (원본: ${err.message.slice(0, 200)})` : '';
  return `${head} ${hint}${orig}`;
}
