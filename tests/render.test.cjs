const { test } = require('node:test');
const assert = require('node:assert/strict');
const { content } = require('../dist/render.js');

test('recovery messages escape project-controlled errors and show actionable advice', () => {
  const html = content({ error: '<img src=x onerror=alert(1)>', recovery: { title: '依赖冲突', advice: '核对版本约束', stage: '解析依赖' }, projectNames: [], ignored: [] });
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('核对版本约束'));
  assert.ok(html.includes('停在：解析依赖'));
  assert.ok(html.includes('data-action="refresh"'));
});
