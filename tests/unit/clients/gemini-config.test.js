import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getGeminiBackend,
  isVertexBackend,
  primaryBackend,
  withBillingFallback,
  resolveVertexConfig,
} from '../../../lib/clients/gemini-config.js';

test('getGeminiBackend: 미설정 시 aistudio 기본', () => {
  assert.equal(getGeminiBackend({}), 'aistudio');
});

test('getGeminiBackend: 대소문자/공백 정규화', () => {
  assert.equal(getGeminiBackend({ GEMINI_BACKEND: '  Vertex ' }), 'vertex');
  assert.equal(getGeminiBackend({ GEMINI_BACKEND: 'AISTUDIO' }), 'aistudio');
});

test('getGeminiBackend: auto도 유효', () => {
  assert.equal(getGeminiBackend({ GEMINI_BACKEND: 'auto' }), 'auto');
});

test('getGeminiBackend: 알 수 없는 값은 throw', () => {
  assert.throws(() => getGeminiBackend({ GEMINI_BACKEND: 'openai' }), /Invalid GEMINI_BACKEND/);
});

test('primaryBackend: auto의 1차 백엔드는 aistudio', () => {
  assert.equal(primaryBackend({ GEMINI_BACKEND: 'auto' }), 'aistudio');
  assert.equal(primaryBackend({ GEMINI_BACKEND: 'vertex' }), 'vertex');
  assert.equal(primaryBackend({}), 'aistudio');
});

const DEPLETED = Object.assign(new Error('Your prepayment credits are depleted'), { status: 429 });

test('withBillingFallback: 단일 모드는 해당 백엔드로 한 번만 실행', async () => {
  const calls = [];
  const out = await withBillingFallback((b) => { calls.push(b); return Promise.resolve(b); }, { GEMINI_BACKEND: 'vertex' });
  assert.equal(out, 'vertex');
  assert.deepEqual(calls, ['vertex']);
});

test('withBillingFallback: auto + 정상이면 aistudio 결과 사용(폴백 없음)', async () => {
  const calls = [];
  const out = await withBillingFallback((b) => { calls.push(b); return Promise.resolve(`ok-${b}`); }, { GEMINI_BACKEND: 'auto' });
  assert.equal(out, 'ok-aistudio');
  assert.deepEqual(calls, ['aistudio']);
});

test('withBillingFallback: auto + 크레딧 소진이면 vertex로 폴백', async () => {
  const calls = [];
  const out = await withBillingFallback((b) => {
    calls.push(b);
    if (b === 'aistudio') throw DEPLETED;
    return Promise.resolve('ok-vertex');
  }, { GEMINI_BACKEND: 'auto' });
  assert.equal(out, 'ok-vertex');
  assert.deepEqual(calls, ['aistudio', 'vertex']);
});

test('withBillingFallback: auto + 소진 아닌 오류는 폴백 없이 전파', async () => {
  const boom = Object.assign(new Error('boom'), { status: 500 });
  await assert.rejects(
    () => withBillingFallback((b) => { if (b === 'aistudio') throw boom; return 'nope'; }, { GEMINI_BACKEND: 'auto' }),
    /boom/,
  );
});

test('isVertexBackend: vertex일 때만 true', () => {
  assert.equal(isVertexBackend({ GEMINI_BACKEND: 'vertex' }), true);
  assert.equal(isVertexBackend({ GEMINI_BACKEND: 'aistudio' }), false);
  assert.equal(isVertexBackend({}), false);
});

test('resolveVertexConfig: project 없으면 throw', () => {
  assert.throws(() => resolveVertexConfig({}), /GOOGLE_CLOUD_PROJECT is not set/);
});

test('resolveVertexConfig: location 기본값 global (최신 모델은 global 전용 서빙)', () => {
  const cfg = resolveVertexConfig({ GOOGLE_CLOUD_PROJECT: 'my-proj' });
  assert.equal(cfg.project, 'my-proj');
  assert.equal(cfg.location, 'global');
  assert.equal(cfg.credentials, undefined);
});

test('resolveVertexConfig: location 오버라이드 + 서비스 계정 JSON 파싱', () => {
  const sa = { type: 'service_account', client_email: 'x@y.iam.gserviceaccount.com' };
  const cfg = resolveVertexConfig({
    GOOGLE_CLOUD_PROJECT: 'my-proj',
    GOOGLE_CLOUD_LOCATION: 'asia-northeast3',
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(sa),
  });
  assert.equal(cfg.location, 'asia-northeast3');
  assert.deepEqual(cfg.credentials, sa);
});

test('resolveVertexConfig: 잘못된 서비스 계정 JSON은 throw', () => {
  assert.throws(
    () => resolveVertexConfig({ GOOGLE_CLOUD_PROJECT: 'my-proj', GOOGLE_SERVICE_ACCOUNT_JSON: '{not json' }),
    /not valid JSON/,
  );
});
