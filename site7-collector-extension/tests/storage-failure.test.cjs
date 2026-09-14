const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../contentScript.js'), 'utf8');
const capture = source.slice(source.indexOf('  async function captureAndSave('), source.indexOf('  function hasCapturedPart('));

function loadCapture(response) {
  const toasts = [];
  const state = { currentContext: { machineName: 'test' }, saveCount: 0 };
  const record = { dai: '112', businessDate: '2026-09-13' };
  const context = { state, structuredClone,
    detectSiteBusy: () => false, inspectPage: () => ({}),
    applyCurrentContext: x => x, renderStatusBar() {},
    buildRecords: async () => [record], hasCapturedPart: () => true,
    send: async () => response, inspectAndRender: async () => {},
    showToast: (message, type) => toasts.push({ message, type }), notifySound() {},
    summarizeParts: () => 'graph',
  };
  vm.createContext(context);
  vm.runInContext(capture + '\nglobalThis.capture = captureAndSave;', context);
  return { context, state, toasts };
}

test('容量エラーを保存完了として数えず、自動保存でも失敗を表示する', async () => {
  const { context, state, toasts } = loadCapture({ ok: false, error: 'QUOTA_BYTES quota exceeded' });
  const result = await context.capture(true);
  assert.equal(result.ok, false);
  assert.match(result.error, /QUOTA_BYTES/);
  assert.equal(state.saveCount, 0);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].type, 'error');
});

test('応答がない場合も成功にしない', async () => {
  const { context, state } = loadCapture(undefined);
  assert.equal((await context.capture(false)).ok, false);
  assert.equal(state.saveCount, 0);
});

test('保存成功と変更なしを区別して数える', async () => {
  for (const [status, count] of [['saved', 1], ['unchanged', 0]]) {
    const { context, state } = loadCapture({ ok: true, status });
    assert.equal((await context.capture(false)).ok, true);
    assert.equal(state.saveCount, count);
  }
});
