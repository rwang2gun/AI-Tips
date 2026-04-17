import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetingSchema } from '../../../lib/schemas/meeting.js';

test('meetingSchema: 최상위 required 필드 전부 포함', () => {
  const schema = meetingSchema();
  assert.equal(schema.type, 'object');
  assert.deepEqual(
    schema.required,
    ['title', 'topic', 'meetingType', 'labels', 'agenda', 'discussion', 'decisions', 'todos'],
  );
});

test('meetingSchema: meetingType enum 4종', () => {
  const schema = meetingSchema();
  assert.deepEqual(
    schema.properties.meetingType.enum,
    ['킥오프', '내부 논의', '실무 논의', '기타'],
  );
});

test('meetingSchema: labels enum 4종', () => {
  const schema = meetingSchema();
  assert.deepEqual(
    schema.properties.labels.items.enum,
    ['전투', '시스템', '밸런스', 'UI'],
  );
});

test('meetingSchema: decisions/todos 항목은 {text, sourceQuote} 형태', () => {
  const schema = meetingSchema();
  const decisionItem = schema.properties.decisions.items;
  assert.equal(decisionItem.type, 'object');
  assert.deepEqual(decisionItem.required, ['text', 'sourceQuote']);

  const todoItem = schema.properties.todos.items;
  assert.deepEqual(todoItem.required, ['text', 'sourceQuote']);
});

test('meetingSchema: discussion.points 도 evidenced 타입', () => {
  const schema = meetingSchema();
  const discussionItem = schema.properties.discussion.items;
  assert.deepEqual(discussionItem.required, ['topic', 'points']);
  assert.deepEqual(discussionItem.properties.points.items.required, ['text', 'sourceQuote']);
});
