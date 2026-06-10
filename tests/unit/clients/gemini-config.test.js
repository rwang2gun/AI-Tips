import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getGeminiBackend,
  isVertexBackend,
  resolveVertexConfig,
} from '../../../lib/clients/gemini-config.js';

test('getGeminiBackend: 미설정 시 aistudio 기본', () => {
  assert.equal(getGeminiBackend({}), 'aistudio');
});

test('getGeminiBackend: 대소문자/공백 정규화', () => {
  assert.equal(getGeminiBackend({ GEMINI_BACKEND: '  Vertex ' }), 'vertex');
  assert.equal(getGeminiBackend({ GEMINI_BACKEND: 'AISTUDIO' }), 'aistudio');
});

test('getGeminiBackend: 알 수 없는 값은 throw', () => {
  assert.throws(() => getGeminiBackend({ GEMINI_BACKEND: 'openai' }), /Invalid GEMINI_BACKEND/);
});

test('isVertexBackend: vertex일 때만 true', () => {
  assert.equal(isVertexBackend({ GEMINI_BACKEND: 'vertex' }), true);
  assert.equal(isVertexBackend({ GEMINI_BACKEND: 'aistudio' }), false);
  assert.equal(isVertexBackend({}), false);
});

test('resolveVertexConfig: project 없으면 throw', () => {
  assert.throws(() => resolveVertexConfig({}), /GOOGLE_CLOUD_PROJECT is not set/);
});

test('resolveVertexConfig: location 기본값 us-central1', () => {
  const cfg = resolveVertexConfig({ GOOGLE_CLOUD_PROJECT: 'my-proj' });
  assert.equal(cfg.project, 'my-proj');
  assert.equal(cfg.location, 'us-central1');
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
