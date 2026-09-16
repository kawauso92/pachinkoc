const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../contentScript.js'), 'utf8');
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end)); }
test('出玉・時刻列のない履歴も取り、回転数を出玉として読まない', () => {
  for (const headers of [['回数', '時刻', 'スタート'], ['回数', 'スタート'], ['回数', '時刻', 'スタート', '獲得数']]) {
    const values = { 回数: '1', 時刻: '10:00', スタート: '477', 獲得数: '1370' };
    const rows = [headers, headers.map(h => values[h])].map(row => row.map(textContent => ({ textContent })));
    const context = { clean: s => String(s).trim(), findHeader: (hs, labels) => hs.findIndex(h => labels.includes(h)),
      findHistoryTable: () => ({}), historyRows: () => rows, rowCells: r => r,
      emptyPart: () => ({ status: 'not_present' }), isChanceHistoryRow: () => false,
      isYutimeHistoryRow: () => false, dedupeRows: r => r };
    vm.createContext(context);
    vm.runInContext(section('  function captureHistory(', '  function findHistoryTable(') +
      section('  function hasHistoryHeaders(', '  function parseParentheticalCount(') + '\nglobalThis.result=captureHistory({}, "test");', context);
    assert.equal(context.result.status, 'captured');
    assert.equal(context.result.rows[0].start, 477);
    assert.equal(context.result.rows[0].payout, headers.includes('獲得数') ? 1370 : null);
    assert.equal(context.result.payoutTotal, headers.includes('獲得数') ? 1370 : null);
  }
});
