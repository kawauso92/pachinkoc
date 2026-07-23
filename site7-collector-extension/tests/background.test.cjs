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

