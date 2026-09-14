"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadBackground() {
  const sourcePath = path.join(__dirname, "..", "background.js");
  const source = fs.readFileSync(sourcePath, "utf8") + `
    globalThis.__testExports = {
      applyAppaCalculations,
      applyMasterData,
      flattenRecord,
      autoMapHitPayout,
      findShopRate,
      normalizePayoutBreakdown,
      positiveNumberOrNull
    };
  `;
  const noopListener = { addListener() {}, removeListener() {} };
  const context = {
    Blob,
    URL,
    console,
    structuredClone,
    setInterval,
    setTimeout,
    clearInterval,
    clearTimeout,
    chrome: {
      runtime: { onInstalled: noopListener, onMessage: noopListener },
      storage: {
        local: { async get() { return {}; }, async set() {} },
        session: { async get() { return {}; }, async set() {} }
      },
      tabs: { onUpdated: noopListener },
      downloads: { async download() { return 1; } }
    }
  };
  vm.runInNewContext(source, context, { filename: sourcePath });
  return context.__testExports;
}

const background = loadBackground();

test("内訳も履歴出玉もない店で、31回×指定1400玉から払出を推定する", () => {
  const record = { machineName: "test", parts: {
    summary: { jackpot: 31, normalStarts: 2000 },
    history: { status: "captured", rows: Array.from({ length: 31 }, (_, i) => ({ no: i + 1, payout: null })) },
    graph: { diffBallsFinal: 10000 }
  } };
  const result = background.applyMasterData(record, null, null, { overrides: { test: { singleType: true, singleBalls: 1400 } } });
  assert.equal(result.parts.history.payoutTotal, null);
  assert.equal(result.parts.calculation.effectivePayoutTotal, 43400);
  assert.equal(result.parts.calculation.estimatedUsedBalls, 33400);
  assert.equal(result.parts.calculation.payoutMethod, "single_hit_count");
  assert.equal(background.flattenRecord(result, true).payoutTotal, 43400);
});

test("1種類設定は補正率を適用し、実測出玉があれば実測を優先する", () => {
  const make = () => ({ machineName: "test", parts: { summary: { jackpot: 1 }, history: {}, graph: {} } });
  const config = { adjustPercent: -1, overrides: { test: { singleType: true, singleBalls: 1400 } } };
  const estimated = background.applyMasterData(make(), null, null, config);
  assert.equal(estimated.parts.calculation.effectivePayoutTotal, 1386);
  const measured = make();
  measured.parts.history.rows = [{ no: 1, payout: 1300 }];
  assert.equal(background.applyMasterData(measured, null, null, config).parts.calculation.effectivePayoutTotal, 1300);
});

test("未入力・当たり回数不明・設定OFFでは単一出玉を推定しない", () => {
  for (const [jackpot, enabled, balls] of [[31, true, null], [null, true, 1400], [31, false, 1400]]) {
    const result = background.applyMasterData({ machineName: "test", parts: { summary: { jackpot }, history: {}, graph: {} } }, null, null,
      { overrides: { test: { singleType: enabled, singleBalls: balls } } });
    assert.equal(result.parts.calculation.effectivePayoutTotal, null);
  }
});

test("一部だけ出玉がある履歴も全額実測とは扱わず、通常回転不明は補完しない", () => {
  const result = background.applyMasterData({ machineName: "test", parts: { summary: { jackpot: 2 },
    history: { rows: [{ no: 1, payout: 1400 }, { no: 2, payout: null }] }, graph: { diffBallsFinal: 1000 } } }, null, null,
    { overrides: { test: { singleType: true, singleBalls: 1400 } } });
  assert.equal(result.parts.calculation.effectivePayoutTotal, 2800);
  assert.equal(result.parts.calculation.rotationRate, null);
});

test("交換率上書きは正の数だけを採用する", () => {
  assert.equal(background.positiveNumberOrNull("27.5"), 27.5);
  assert.equal(background.positiveNumberOrNull(""), null);
  assert.equal(background.positiveNumberOrNull(-1), null);
});

test("appa rounds を出玉候補へ正規化できる", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(background.normalizePayoutBreakdown([
      { name: "10R", balls: 1400 },
      { name: "3R", balls: 280 },
      { name: "duplicate", balls: 280 }
    ]))),
    [{ balls: 280, rounds: 3 }, { balls: 1400, rounds: 10 }]
  );
});

test("4種類以上の出玉は超中小へ自動割当しない", () => {
  const auto = background.autoMapHitPayout([
    { balls: 280 }, { balls: 560 }, { balls: 700 }, { balls: 1400 }
  ]);
  assert.equal(auto.tooMany, true);
});

test("設定した交換率は保存済み値や店舗マスターより優先される", () => {
  const record = background.applyMasterData({
    storeName: "ABC掛川細田店",
    machineName: "エヴァ",
    calculationInputs: { exchangeRate: 28 },
    parts: { summary: {}, history: {}, graph: {} }
  }, {
    shops: [{ name: "ABC掛川細田店", kokan: 30 }],
    kishus: []
  }, null, { exchangeRate: 27.5 });
  assert.equal(record.calculationInputs.exchangeRate, 27.5);
  assert.equal(record.calculationInputs.exchangeRateSource, "settings_override");
});

test("交換率27.5玉なら回転率から期待時給と仕事量を計算できる", () => {
  const spec = { heikin: 1167, total: 78.675, total1R: 9.436, jikan: 220, hatsua: 319.7, heiren: 4.06 };
  const calculation = {
    rotationRate: 16.31,
    inputs: { machineSpec: spec, exchangeRate: 27.5, holdingRatio: 1, holdingRatioSource: "appa_default_100" }
  };
  const record = { parts: { summary: { normalStarts: 1666 } } };
  const reasons = [];
  const assumptions = [];
  background.applyAppaCalculations(record, calculation, reasons, assumptions);

  const cashValuePerBall = 100 / 27.5;
  const expectedHourlyRaw = spec.heikin * spec.jikan / spec.total * cashValuePerBall
    - 250 * spec.jikan / calculation.rotationRate * cashValuePerBall;
  assert.equal(calculation.expectedHourly, Math.round(expectedHourlyRaw));
  assert.equal(calculation.workValue, Math.round(expectedHourlyRaw * (1666 / spec.jikan)));
  assert.deepEqual(reasons, []);
});

