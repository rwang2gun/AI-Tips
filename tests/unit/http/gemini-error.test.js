import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBillingDepleted, isRetriable } from '../../../lib/http/gemini-error.js';

// 실제 제보(2026-06-09)에서 관측된 크레딧 소진 오류 메시지.
const DEPLETED_MSG =
  '{"error":{"code":429,"message":"Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.","status":"RESOURCE_EXHAUSTED"}}';

test('isBillingDepleted: 크레딧 소진 메시지를 인식', () => {
  assert.equal(isBillingDepleted({ message: DEPLETED_MSG }), true);
  assert.equal(isBillingDepleted({ message: 'prepayment credits are depleted' }), true);
});

test('isBillingDepleted: 일시적 RESOURCE_EXHAUSTED(분당 한도)는 소진이 아님', () => {
  const rateLimit = { status: 429, message: 'Quota exceeded for quota metric ... RESOURCE_EXHAUSTED' };
  assert.equal(isBillingDepleted(rateLimit), false);
});

test('isBillingDepleted: 일반 오류는 false', () => {
  assert.equal(isBillingDepleted({ status: 503, message: 'model is overloaded' }), false);
  assert.equal(isBillingDepleted({}), false);
  assert.equal(isBillingDepleted(null), false);
});

test('isRetriable: 크레딧 소진은 재시도하지 않음(429여도 false)', () => {
  assert.equal(isRetriable({ status: 429, message: DEPLETED_MSG }), false);
});

test('isRetriable: 일시적 429/503/500은 재시도 대상', () => {
  assert.equal(isRetriable({ status: 429, message: 'Quota exceeded ... RESOURCE_EXHAUSTED' }), true);
  assert.equal(isRetriable({ status: 503, message: 'model is overloaded, high demand' }), true);
  assert.equal(isRetriable({ status: 500, message: 'internal' }), true);
  assert.equal(isRetriable({ message: 'UNAVAILABLE' }), true);
});

test('isRetriable: 재시도 불가 오류(400/빈 오류)는 false', () => {
  assert.equal(isRetriable({ status: 400, message: 'Invalid argument' }), false);
  assert.equal(isRetriable({}), false);
});
