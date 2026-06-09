import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBillingDepleted,
  isRetriable,
  isModelNotFound,
  extractRequestedModel,
  describeModelNotFound,
} from '../../../lib/http/gemini-error.js';

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

// 2026-06-09 'gemini-3.1-pro'(존재하지 않음) 호출로 관측된 404 메시지.
const MODEL_404_MSG =
  '{"error":{"code":404,"message":"models/gemini-3.1-pro is not found for API version v1beta, or is not supported for generateContent. Call ModelService.ListModels to see the list of available models and their supported methods.","status":"NOT_FOUND"}}';

test('isModelNotFound: 모델 404 메시지를 인식', () => {
  assert.equal(isModelNotFound({ status: 404, message: MODEL_404_MSG }), true);
  // 메시지에 status 단어만 있어도 인식 (status 필드가 없는 경우 대비)
  assert.equal(isModelNotFound({ status: 404, message: 'NOT_FOUND' }), true);
});

test('isModelNotFound: 404가 아닌 다른 오류는 false', () => {
  assert.equal(isModelNotFound({ status: 503, message: 'overloaded' }), false);
  assert.equal(isModelNotFound({ status: 400, message: 'NOT_FOUND but actually bad request' }), false);
  assert.equal(isModelNotFound({}), false);
});

test('isRetriable: 모델 404는 재시도 대상이 아님', () => {
  assert.equal(isRetriable({ status: 404, message: MODEL_404_MSG }), false);
});

test('extractRequestedModel: 오류 메시지에서 모델 식별자 추출', () => {
  assert.equal(extractRequestedModel({ message: MODEL_404_MSG }), 'gemini-3.1-pro');
  assert.equal(extractRequestedModel({ message: 'no model here' }), null);
  assert.equal(extractRequestedModel({}), null);
});

test('describeModelNotFound: 모델 이름 + 위치 + 가이드 + 원본 일부를 포함', () => {
  const msg = describeModelNotFound(
    { status: 404, message: MODEL_404_MSG },
    { location: 'lib/handlers/summarize.js SUMMARIZE_MODEL' },
  );
  assert.match(msg, /모델 부재/);
  assert.match(msg, /gemini-3\.1-pro/);
  assert.match(msg, /lib\/handlers\/summarize\.js/);
  assert.match(msg, /preview/);
  assert.match(msg, /원본:/);
});

test('describeModelNotFound: 모델 식별자가 없어도 안전하게 메시지 생성', () => {
  const msg = describeModelNotFound({ status: 404, message: 'NOT_FOUND' });
  assert.match(msg, /모델 부재/);
  // 모델 추출 실패 → 일반화된 머리말
  assert.match(msg, /Gemini가 요청한 모델을 찾지 못했습니다/);
});
