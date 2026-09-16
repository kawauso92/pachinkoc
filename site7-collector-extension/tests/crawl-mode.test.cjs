const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../popup.js'), 'utf8');
const functionSource = source.slice(source.indexOf('function crawlScreens()'), source.indexOf('function updateCrawlMode()'));
test('単画面モードは通常回転の履歴必須設定に関係なく指定の1画面だけ取得する', () => {
  for (const mode of ['history', 'graph', 'detail', 'custom']) {
    const elements = { '#crawlMode': { value: mode }, '#crawlMachine': { value: '大海5' },
      '#crawlGraph': { checked: true }, '#crawlHistory': { checked: false }, '#crawlDetail': { checked: true } };
    const context = { $: id => elements[id], payoutOverrides: { 大海5: { historyNormalEnabled: true } } };
    vm.createContext(context);
    vm.runInContext(functionSource + '\nglobalThis.screens = crawlScreens();', context);
    assert.deepEqual(Array.from(context.screens), mode === 'custom' ? ['graph', 'history', 'detail'] : [mode]);
  }
});
