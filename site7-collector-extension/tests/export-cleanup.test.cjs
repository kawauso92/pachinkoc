const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

function setup() {
  const row = dai => ({ source: 'site7', storeName: 'test', machineName: 'machine', dai, daiNormalized: dai,
    businessDate: '2026-09-13', captureDateTime: '2026-09-14T03:00:00Z', updatedAt: '2026-09-14T03:00:00Z',
    parts: { summary: {}, history: {}, graph: {}, calculation: {} } });
  const local = { site7RecordsV1: { a: row('111'), b: row('112') }, site7PendingV1: [] };
  const session = {};
  const area = data => ({
    async get(keys) { return structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, data[k]]))); },
    async set(values) { Object.assign(data, structuredClone(values)); }
  });
  const download = { state: 'in_progress', exists: true };
  const listener = { addListener() {} };
  const context = { console, structuredClone, TextEncoder, crypto: webcrypto, btoa, URL, Blob,
    chrome: { runtime: { onInstalled: listener, onMessage: listener },
      storage: { local: area(local), session: area(session) },
      downloads: { onChanged: listener, download: async () => 42, search: async () => [download] } },
    snapshot: () => ({ records: structuredClone(Object.values(local.site7RecordsV1)), pending: structuredClone(local.site7PendingV1) })
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8') + `
    getData = async () => snapshot();
    ensureSession = async () => ({ startedAt: '2026-09-14T00:00:00Z' });
    globalThis.api = { exportData, finishCsvExport };
  `, context);
  return { local, session, download, api: context.api, row };
}

test('CSVダウンロード完了前は残し、完了後に対象を削除する', async () => {
  const { local, download, api } = setup();
  const result = await api.exportData('csv', 'session');
  assert.equal(result.count, 2);
  assert.equal(Object.keys(local.site7RecordsV1).length, 2);
  download.state = 'complete';
  await api.finishCsvExport(42);
  assert.equal(Object.keys(local.site7RecordsV1).length, 0);
});

test('キャンセル・失敗したCSVの元データは残す', async () => {
  const { local, download, api } = setup();
  await api.exportData('csv', 'all');
  download.state = 'interrupted';
  await api.finishCsvExport(42);
  assert.equal(Object.keys(local.site7RecordsV1).length, 2);
});

test('CSV出力中の更新・新規取得は削除しない', async () => {
  const { local, download, api, row } = setup();
  await api.exportData('csv', 'all');
  local.site7RecordsV1.a.parts.summary.normalStarts = 999;
  local.site7RecordsV1.c = row('113');
  download.state = 'complete';
  await api.finishCsvExport(42);
  assert.deepEqual(Object.keys(local.site7RecordsV1), ['a', 'c']);
});

test('JSONとデバッグCSVは完了しても削除しない', async () => {
  for (const format of ['json', 'debugCsv']) {
    const { local, download, api } = setup();
    download.state = 'complete';
    await api.exportData(format, 'all');
    await api.finishCsvExport(42);
    assert.equal(Object.keys(local.site7RecordsV1).length, 2);
  }
});

test('条件指定の対象外と、消えたダウンロードの元データは残す', async () => {
  const { local, download, api } = setup();
  local.site7RecordsV1.b.businessDate = '2026-09-12';
  download.state = 'complete';
  await api.exportData('csv', 'all', { businessDate: '2026-09-13' });
  assert.deepEqual(Object.keys(local.site7RecordsV1), ['b']);
  download.exists = false;
  await api.exportData('csv', 'all');
  assert.deepEqual(Object.keys(local.site7RecordsV1), ['b']);
});
