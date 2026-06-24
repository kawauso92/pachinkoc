"use strict";

const STORAGE_KEYS = {
  records: "site7RecordsV1",
  pending: "site7PendingV1",
  settings: "site7SettingsV1",
  session: "site7SessionV1",
  appaMasters: "site7AppaMastersV1",
  kishuBreakdowns: "site7KishuBreakdownsV1"
};

const APPA_MASTERS_URL = "https://script.google.com/macros/s/AKfycbzFtMJ354oeVAeNVTGLckNVXX9I1URLJTrlMTafDNO6UPOf7yo3bnaac_yPKYV8hVv8/exec?action=masters";
const APPA_MASTERS_TTL_MS = 6 * 60 * 60 * 1000;
// appb機種一覧シート（出玉内訳 B〜U列: 出玉/R数の最大10ペア）をCSVで直接取得する。
const APPB_BREAKDOWN_CSV_URL = "https://docs.google.com/spreadsheets/d/1TwWuiMgih5ZKst27bP8TePoacnr85gEORPxF8GDLFfg/export?format=csv&gid=531908353";

const DEFAULT_SETTINGS = {
  enabled: true,
  autoSave: false,
  soundEnabled: false,
  manualStoreName: "",
  manualMachineName: "",
  manualDai: "",
  manualBusinessDate: "",
  manualDiffBalls: "",
  // 自動巡回の入力（popupを閉じても保持する）
  crawlDn: "",
  crawlGraph: true,
  crawlHistory: true,
  crawlDetail: true,
  crawlMinDelay: 2000,
  crawlMaxDelay: 5000,
  crawlDryRun: false,
  // 巡回前に指定する機種（appa/appb名）。""=自動取得。指定時は全台に適用。
  crawlMachine: "",
  // 推定払出に対する出玉補正(%)。実出玉はスペックより少なめなことが多い。例 -1。
  payoutAdjustPercent: 0,
  // 機種ごとの超中小→出玉(玉数)の上書き。{ "エヴァ17": { cho, chu, sho } }
  payoutMapOverrides: {}
};

// 混雑ページ検出時のバックオフ設定（負荷制御に行儀よく退避する）。
const CRAWL_BUSY = { baseMs: 60000, maxMs: 300000, maxRetries: 4 };

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  if (!stored[STORAGE_KEYS.settings]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: DEFAULT_SETTINGS });
  }
  getAppaMasters(true).catch(() => null);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message, _sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

// ----- Auto-crawl controller -------------------------------------------------
// Drives the existing per-page capture across many 台 by navigating the active
// Site7 tab through each screen URL at a human-like pace. The active tab keeps
// the user's paid session and (via the DNR rule) the iPad UA, so this is a real
// browser doing real navigations.
const SITE7_SCREEN_FILES = { graph: "D2600.do", history: "D2700.do", detail: "D4000.do" };
let crawlState = null;

function parseDnList(spec) {
  const out = [];
  const seen = new Set();
  for (const token of String(spec || "").split(/[\s,、]+/).filter(Boolean)) {
    const range = token.match(/^(\d+)\s*[-~〜]\s*(\d+)$/);
    if (range) {
      const [start, end] = [Number(range[1]), Number(range[2])].sort((a, b) => a - b);
      for (let dn = start; dn <= end && dn - start < 1000; dn++) addDn(dn);
    } else if (/^\d+$/.test(token)) {
      addDn(Number(token));
    }
  }
  function addDn(dn) { const key = String(dn); if (!seen.has(key)) { seen.add(key); out.push(dn); } }
  return out;
}

function buildCrawlUrl(baseUrl, screenFile, dn) {
  const url = new URL(baseUrl);
  if (!/[^/]*\.do$/i.test(url.pathname)) throw new Error("base URL is not a Site7 .do page");
  url.pathname = url.pathname.replace(/[^/]*\.do$/i, screenFile);
  url.searchParams.set("dn", String(dn));
  return url.toString();
}

function crawlProgress() {
  if (!crawlState) return { running: false };
  return {
    running: crawlState.running,
    dryRun: crawlState.dryRun,
    total: crawlState.steps.length,
    done: crawlState.index, // 進行済みステップ数（再試行で水増ししない）
    index: crawlState.index,
    current: crawlState.steps[crawlState.index] ? { dn: crawlState.steps[crawlState.index].dn, screen: crawlState.steps[crawlState.index].screen } : null,
    results: crawlState.results.slice(-60),
    backoffUntil: crawlState.backoffUntil || null,
    stoppedReason: crawlState.stoppedReason || null,
    startedAt: crawlState.startedAt,
    finishedAt: crawlState.finishedAt || null
  };
}

async function getCrawlStatus() { return { ok: true, ...crawlProgress() }; }

async function stopCrawl() {
  if (crawlState?.running) crawlState.stop = true;
  return { ok: true, stopping: Boolean(crawlState?.running) };
}

async function startCrawl(message) {
  if (crawlState?.running) return { ok: false, error: "巡回はすでに実行中です" };
  const tabId = Number(message.tabId);
  if (!Number.isInteger(tabId)) return { ok: false, error: "対象タブが不明です" };
  // 出玉推移(D2600)ページを雛形に dn/画面ファイルだけ差し替える方式のため、
  // 他ページ（D2400等）はパラメータ構成が異なり生成URLが壊れる。必ずD2600から開始させる。
  if (!/D2600\.do/i.test(String(message.baseUrl || ""))) {
    return { ok: false, error: "出玉推移ページ（D2600.do）から開始してください" };
  }
  const dnList = parseDnList(message.dnSpec);
  if (!dnList.length) return { ok: false, error: "台番号（dn）が指定されていません" };
  const screens = (Array.isArray(message.screens) && message.screens.length ? message.screens : ["graph", "history", "detail"])
    .filter((screen) => SITE7_SCREEN_FILES[screen]);
  if (!screens.length) return { ok: false, error: "取得する画面が選ばれていません" };

  let steps;
  try {
    steps = [];
    for (const dn of dnList) for (const screen of screens) {
      steps.push({ dn, screen, url: buildCrawlUrl(message.baseUrl, SITE7_SCREEN_FILES[screen], dn) });
    }
  } catch (error) {
    return { ok: false, error: `${error.message}（対象機種・日付のSite7ページを開いた状態で開始してください）` };
  }

  const minDelayMs = clamp(Number(message.minDelayMs) || 4000, 1500, 60000);
  const maxDelayMs = clamp(Number(message.maxDelayMs) || 8000, minDelayMs, 120000);
  if (message.dryRun) {
    return { ok: true, dryRun: true, total: steps.length, dnCount: dnList.length,
      urls: steps.map((step) => ({ dn: step.dn, screen: step.screen, url: step.url })) };
  }

  const forceMachine = (await getSettings()).settings.crawlMachine || "";
  crawlState = { running: true, dryRun: false, steps, index: 0, tabId, results: [], stop: false,
    minDelayMs, maxDelayMs, settleMs: clamp(Number(message.settleMs) || 2000, 500, 15000),
    forceMachine, backoffUntil: null, stoppedReason: null, startedAt: Date.now(), finishedAt: null };
  runCrawl();
  return { ok: true, started: true, total: steps.length, dnCount: dnList.length };
}

async function runCrawl() {
  // Strip manual overrides so each 台 is auto-detected; a fixed manual 台番号 or
  // 差玉 would otherwise be written onto every machine in the crawl.
  const stored = (await getSettings()).settings;
  const settings = { ...stored, enabled: true, manualStoreName: "", manualMachineName: "", manualDai: "", manualBusinessDate: "", manualDiffBalls: "" };
  let consecutiveBusy = 0;
  while (crawlState.index < crawlState.steps.length && !crawlState.stop) {
    const step = crawlState.steps[crawlState.index];
    let busy = false;
    try {
      await chrome.tabs.update(crawlState.tabId, { url: step.url, active: true });
      await waitForTabComplete(crawlState.tabId);
      if (crawlState.stop) break;
      await interruptibleDelay(crawlState.settleMs);
      if (crawlState.stop) break;
      const response = await captureViaContentScript(crawlState.tabId, settings);
      busy = Boolean(response?.busy);
      if (busy) {
        crawlState.results.push({ dn: step.dn, screen: step.screen, ok: false, status: "busy" });
      } else {
        const saved = response?.results?.filter((result) => result.status !== "unchanged").length || 0;
        crawlState.results.push({ dn: step.dn, screen: step.screen, ok: Boolean(response?.ok),
          status: response?.skipped ? "skipped" : (saved ? "saved" : "unchanged") });
      }
    } catch (error) {
      crawlState.results.push({ dn: step.dn, screen: step.screen, ok: false, status: "error", error: error.message });
    }

    if (busy) {
      // 混雑検出：同じ台を進めず、指数バックオフで待ってから再試行する。
      // 連続で上限に達したら、叩き続けず巡回を停止する。
      consecutiveBusy += 1;
      if (consecutiveBusy >= CRAWL_BUSY.maxRetries) { crawlState.stoppedReason = "busy_limit"; break; }
      const backoff = Math.min(CRAWL_BUSY.baseMs * 2 ** (consecutiveBusy - 1), CRAWL_BUSY.maxMs);
      crawlState.backoffUntil = Date.now() + backoff;
      await interruptibleDelay(backoff);
      crawlState.backoffUntil = null;
      continue; // index を進めず同じステップを再試行
    }

    consecutiveBusy = 0;
    crawlState.index += 1;
    if (crawlState.index < crawlState.steps.length && !crawlState.stop) {
      await interruptibleDelay(randomBetween(crawlState.minDelayMs, crawlState.maxDelayMs));
    }
  }
  crawlState.running = false;
  crawlState.backoffUntil = null;
  crawlState.finishedAt = Date.now();
}

// 停止フラグを監視し、待機中でも停止ボタンに即応できる中断可能な遅延。
function interruptibleDelay(ms) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (!crawlState || crawlState.stop || Date.now() - start >= ms) { resolve(); return; }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    const timer = setTimeout(() => finish(new Error("ページ読込がタイムアウトしました")), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => { if (tab?.status === "complete") finish(); }).catch((error) => finish(error));
  });
}

async function captureViaContentScript(tabId, settings, attempts = 6) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "CAPTURE_PAGE", settings });
      if (response) return response;
    } catch (error) { lastError = error; }
    await delay(700);
  }
  throw new Error(`取得スクリプトに接続できません${lastError ? `（${lastError.message}）` : ""}`);
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function randomBetween(min, max) { return Math.round(min + Math.random() * (max - min)); }

async function handleMessage(message, sender = null) {
  switch (message?.type) {
    case "SAVE_CAPTURE":
      return saveCapture(message.record);
    case "CAPTURE_VISIBLE_GRAPH":
      return captureVisibleGraph(message, sender);
    case "GET_DATA":
      return getData();
    case "START_SESSION":
      return ensureSession();
    case "GET_SETTINGS":
      return getSettings();
    case "SET_SETTINGS":
      return setSettings(message.settings || {});
    case "EXPORT_DATA":
      return exportData(message.format, message.scope, { businessDate: message.businessDate, machineKey: message.machineKey });
    case "GET_MASTERS":
      return getMachineOptions();
    case "CLEAR_DATA":
      return deleteCapturedData({ scope: "all" });
    case "START_CRAWL":
      return startCrawl(message);
    case "STOP_CRAWL":
      return stopCrawl();
    case "GET_CRAWL_STATUS":
      return getCrawlStatus();
    default:
      throw new Error("Unknown message type");
  }
}

async function captureVisibleGraph(message, sender) {
  const tab = sender?.tab;
  if (!tab?.windowId) throw new Error("Active Site7 tab information is unavailable");
  if (tab.active === false) throw new Error("Graph screenshot requires the Site7 tab to be active");
  const rect = message.rect;
  if (!rect || rect.width < 50 || rect.height < 50) throw new Error("Graph crop rectangle is invalid");

  const screenshotUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const response = await fetch(screenshotUrl);
  const bitmap = await createImageBitmap(await response.blob());
  const screenshotWidth = bitmap.width;
  const screenshotHeight = bitmap.height;
  const viewportWidth = Number(message.viewportWidth) || bitmap.width;
  const viewportHeight = Number(message.viewportHeight) || bitmap.height;
  const scaleX = bitmap.width / viewportWidth;
  const scaleY = bitmap.height / viewportHeight;
  const sx = clamp(Math.round(rect.left * scaleX), 0, bitmap.width - 1);
  const sy = clamp(Math.round(rect.top * scaleY), 0, bitmap.height - 1);
  const sw = clamp(Math.round(rect.width * scaleX), 1, bitmap.width - sx);
  const sh = clamp(Math.round(rect.height * scaleY), 1, bitmap.height - sy);
  const canvas = new OffscreenCanvas(sw, sh);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close?.();

  const pixels = context.getImageData(0, 0, sw, sh);
  const analysis = analyzeSite7ScreenshotGraph(pixels);
  const cropBlob = await canvas.convertToBlob({ type: "image/png" });
  const cropDataUrl = await blobToDataUrl(cropBlob);
  const manualOverride = parseOptionalNumber(message.manualOverride);
  const raw = analysis.diffBallsRaw;
  const estimatedAxis = analysis.status === "calculated_estimated_axis";
  const finalValue = manualOverride ?? raw;

  return {
    ok: true,
    graph: {
      status: "captured",
      capturedAt: new Date().toISOString(),
      graphImage: cropDataUrl,
      graphCaptureMethod: "captureVisibleTab_crop",
      screenshotPixelWidth: screenshotWidth,
      screenshotPixelHeight: screenshotHeight,
      graphImageWidth: sw,
      graphImageHeight: sh,
      selectedGraphRect: rect,
      captureRectStrategy: message.captureRectStrategy || "selected_graph_only",
      cropPixelRect: { x: sx, y: sy, width: sw, height: sh, scaleX, scaleY },
      diffBallsRaw: raw,
      diffBallsCandidate: null,
      diffBallsManualOverride: manualOverride,
      diffBallsFinal: finalValue,
      diffBallsStatus: manualOverride !== null ? "manual_override" : analysis.status,
      diffBallsMethod: manualOverride !== null ? "manual" : analysis.method,
      diffBallsConfidence: manualOverride !== null ? "A" : analysis.diffBallsConfidence,
      axisAssumption: analysis.axisAssumption,
      axisConfidence: analysis.axisConfidence,
      graphUpperValue: analysis.graphUpperValue,
      graphLowerValue: analysis.graphLowerValue,
      graphUpperLineY: analysis.graphUpperLineY,
      graphLowerLineY: analysis.graphLowerLineY,
      graphZeroY: analysis.graphZeroY,
      graphEndY: analysis.graphEndY,
      graphEndX: analysis.graphEndX,
      graphScaleBallsPerPixel: analysis.graphScaleBallsPerPixel,
      horizontalGridLines: analysis.horizontalGridLines,
      lineColorCandidates: analysis.lineColorCandidates,
      graphAnalysisError: analysis.error
    }
  };
}

function analyzeSite7ScreenshotGraph(imageData) {
  const { width, height, data } = imageData;
  const colorCounts = new Map();
  const lineMask = new Uint8Array(width * height);
  const coloredMask = new Uint8Array(width * height);
  let linePixelCount = 0;
  let coloredPixelCount = 0;
  const isLinePixel = (r, g, b, a) => a > 150 && g > 95 && b > 115 && g - r > 28 && b - r > 38 && Math.abs(b - g) < 105;
  const isColoredPixel = (r, g, b, a) => a > 150 && Math.max(r, g, b) - Math.min(r, g, b) > 28 && Math.min(r, g, b) < 245;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const r = data[index], g = data[index + 1], b = data[index + 2], a = data[index + 3];
      const colored = isColoredPixel(r, g, b, a);
      if (colored) {
        coloredMask[y * width + x] = 1;
        coloredPixelCount++;
        const key = `${Math.round(r / 16) * 16},${Math.round(g / 16) * 16},${Math.round(b / 16) * 16}`;
        const bucket = colorCounts.get(key) || { count: 0, r: 0, g: 0, b: 0 };
        bucket.count++; bucket.r += r; bucket.g += g; bucket.b += b;
        colorCounts.set(key, bucket);
      }
      if (!isLinePixel(r, g, b, a)) continue;
      lineMask[y * width + x] = 1;
      linePixelCount++;
    }
  }
  // The graph line is the dominant saturated color; build a mask of pixels close
  // to it so pink/blue/green lines all track, not only the Site7 standard cyan.
  const rankedColors = [...colorCounts.values()].sort((a, b) => b.count - a.count);
  const dominant = rankedColors[0] && rankedColors[0].count >= 12
    ? { r: rankedColors[0].r / rankedColors[0].count, g: rankedColors[0].g / rankedColors[0].count, b: rankedColors[0].b / rankedColors[0].count }
    : null;
  const dominantMask = new Uint8Array(width * height);
  let dominantPixelCount = 0;
  if (dominant) {
    for (let index = 0; index < coloredMask.length; index++) {
      if (!coloredMask[index]) continue;
      const i = index * 4;
      if (Math.abs(data[i] - dominant.r) > 70 || Math.abs(data[i + 1] - dominant.g) > 70 || Math.abs(data[i + 2] - dominant.b) > 70) continue;
      dominantMask[index] = 1; dominantPixelCount++;
    }
  }

  const rowScores = [];
  const startX = Math.floor(width * 0.07);
  const endX = Math.ceil(width * 0.94);
  for (let y = Math.floor(height * 0.03); y < Math.ceil(height * 0.97); y++) {
    let score = 0;
    for (let x = startX; x < endX; x++) {
      const index = (y * width + x) * 4;
      const r = data[index], g = data[index + 1], b = data[index + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const above = y > 0 ? index - width * 4 : index;
      const below = y < height - 1 ? index + width * 4 : index;
      const neighborContrast = Math.max(
        Math.abs(r - data[above]), Math.abs(g - data[above + 1]), Math.abs(b - data[above + 2]),
        Math.abs(r - data[below]), Math.abs(g - data[below + 1]), Math.abs(b - data[below + 2])
      );
      const neutralLine = max - min < 35 && max > 45 && max < 253;
      if (neutralLine && (max < 238 || neighborContrast >= 4)) score++;
    }
    rowScores.push({ y, score });
  }
  const threshold = Math.max(10, Math.floor((endX - startX) * 0.035));
  const peaks = rowScores.filter((row, index, rows) => row.score >= threshold &&
    row.score >= (rows[index - 1]?.score || 0) && row.score >= (rows[index + 1]?.score || 0))
    .sort((a, b) => a.y - b.y);
  const gridLines = [];
  for (const peak of peaks) {
    const previous = gridLines[gridLines.length - 1];
    if (!previous || peak.y - previous.y > 8) gridLines.push(peak);
    else if (peak.score > previous.score) gridLines[gridLines.length - 1] = peak;
  }

  const lineColorCandidates = rankedColors.slice(0, 8).map((bucket) => ({
    rgb: `${Math.round(bucket.r / bucket.count)},${Math.round(bucket.g / bucket.count)},${Math.round(bucket.b / bucket.count)}`,
    count: bucket.count
  }));
  // The latest differential is the line's right end. Scan columns right-to-left
  // for the line color and take the rightmost column its neighbors support, so
  // legends/buttons/specks and the long near-zero early segment never win.
  const endpointMethod = linePixelCount >= 20 ? "site7_cyan_rightmost_column"
    : (dominant && dominantPixelCount >= 20 ? "dominant_color_rightmost_column" : "generic_colored_rightmost_column");
  const endpointMask = linePixelCount >= 20 ? lineMask
    : (dominant && dominantPixelCount >= 20 ? dominantMask : coloredMask);
  const graphLine = coloredPixelCount >= 20 || linePixelCount >= 20 ? findLineEndpoint(endpointMask, width, height) : null;
  if (!graphLine) return screenshotGraphFailure("graph_not_detected", "A continuous colored graph line was not detected", gridLines, lineColorCandidates);

  const strongestGridScore = Math.max(0, ...gridLines.map((line) => line.score));
  const strongGridLines = gridLines.filter((line) => line.score >= Math.max(threshold * 2, strongestGridScore * 0.45));
  const detectedAxisGridLines = selectRegularGridLines(strongGridLines);
  const axisGridLines = completeSevenLineAxis(detectedAxisGridLines, height);
  const estimatedAxis = axisGridLines.length < 3;
  const upper = estimatedAxis ? Math.max(1, Math.round(height * 0.08)) : axisGridLines[0].y;
  const lower = estimatedAxis ? Math.min(height - 2, Math.round(height * 0.92)) : axisGridLines[axisGridLines.length - 1].y;
  const midpoint = (upper + lower) / 2;
  const zeroCandidate = estimatedAxis ? null : [...axisGridLines].sort((a, b) => Math.abs(a.y - midpoint) - Math.abs(b.y - midpoint))[0];
  const zero = zeroCandidate?.y ?? midpoint;
  const rightmostX = graphLine.x;
  const endY = graphLine.y;
  const ballsPerPixel = 60000 / Math.abs(lower - upper);
  const raw = (zero - endY) * ballsPerPixel;
  const axisConfidence = estimatedAxis ? "C" : (axisGridLines.length >= 5 && Math.abs(zero - midpoint) <= Math.max(5, height * 0.04) ? "A" : "B");

  return {
    status: estimatedAxis ? "calculated_estimated_axis" : "calculated_screenshot",
    method: `${estimatedAxis ? "captureVisibleTab_standard_axis_estimated_plot_bounds" : "captureVisibleTab_standard_axis_pixel_interpolation"}_${endpointMethod}`,
    diffBallsRaw: raw,
    diffBallsConfidence: axisConfidence,
    axisAssumption: "site7_single_unit_standard_+30000_-30000",
    axisConfidence,
    graphUpperValue: 30000,
    graphLowerValue: -30000,
    graphUpperLineY: upper,
    graphLowerLineY: lower,
    graphZeroY: zero,
    graphEndY: endY,
    graphEndX: rightmostX,
    graphScaleBallsPerPixel: ballsPerPixel,
    horizontalGridLines: gridLines.map((line) => ({ y: line.y, score: line.score })),
    selectedAxisGridLines: axisGridLines.map((line) => ({ y: line.y, score: line.score })),
    lineColorCandidates,
    graphLineComponent: graphLine,
    graphEndpointMethod: endpointMethod,
    error: estimatedAxis ? `Horizontal grid detection was insufficient (${axisGridLines.length} strong of ${gridLines.length}); fixed Site7 axis with 8%-92% plot bounds was used` : null
  };
}

function completeSevenLineAxis(lines, height) {
  if (lines.length !== 6) return lines;
  const spacings = lines.slice(1).map((line, index) => line.y - lines[index].y).sort((a, b) => a - b);
  const spacing = spacings[Math.floor(spacings.length / 2)];
  const topY = Math.round(lines[0].y - spacing);
  const bottomY = Math.round(lines[lines.length - 1].y + spacing);
  const topFits = topY >= 0;
  const bottomFits = bottomY < height;
  if (topFits === bottomFits) return lines;
  return topFits
    ? [{ y: topY, score: 0, inferred: true }, ...lines]
    : [...lines, { y: bottomY, score: 0, inferred: true }];
}

function selectRegularGridLines(lines) {
  if (lines.length < 3) return lines;
  let best = [];
  let bestScore = -Infinity;
  for (let first = 0; first < lines.length - 1; first++) {
    for (let second = first + 1; second < lines.length; second++) {
      const spacing = lines[second].y - lines[first].y;
      if (spacing < 8) continue;
      const tolerance = Math.max(3, spacing * 0.12);
      const sequence = [lines[first], lines[second]];
      let expected = lines[second].y + spacing;
      let totalError = 0;
      for (let index = second + 1; index < lines.length; index++) {
        const error = Math.abs(lines[index].y - expected);
        if (error <= tolerance) {
          sequence.push(lines[index]);
          totalError += error;
          expected += spacing;
        } else if (lines[index].y > expected + tolerance) {
          break;
        }
      }
      const score = sequence.length * 100000 + sequence.reduce((sum, line) => sum + line.score, 0) - totalError * 100;
      if (sequence.length >= 3 && score > bestScore) { best = sequence; bestScore = score; }
    }
  }
  return best.length >= 3 ? best : lines;
}

function findLineEndpoint(mask, width, height) {
  const columnYs = new Array(width).fill(null);
  const columnCounts = new Array(width).fill(0);
  for (let x = 0; x < width; x++) {
    const ys = [];
    for (let y = 0; y < height; y++) if (mask[y * width + x]) ys.push(y);
    if (!ys.length) continue;
    columnYs[x] = ys[Math.floor(ys.length / 2)];
    columnCounts[x] = ys.length;
  }
  let endX = -1;
  for (let x = width - 1; x >= 1; x--) {
    if (columnYs[x] === null) continue;
    const supported = (columnYs[x - 1] !== null && Math.abs(columnYs[x - 1] - columnYs[x]) <= 6) ||
      (x >= 2 && columnYs[x - 2] !== null && Math.abs(columnYs[x - 2] - columnYs[x]) <= 10);
    if (supported) { endX = x; break; }
  }
  if (endX < 0) for (let x = width - 1; x >= 0; x--) if (columnYs[x] !== null) { endX = x; break; }
  if (endX < 0) return null;
  const ys = [columnYs[endX]];
  for (let dx = 1; dx <= 2; dx++) {
    const xn = endX - dx;
    if (xn >= 0 && columnYs[xn] !== null && Math.abs(columnYs[xn] - columnYs[endX]) <= 10) ys.push(columnYs[xn]);
  }
  const y = Math.round(ys.reduce((sum, value) => sum + value, 0) / ys.length);
  return { x: endX, y, pixelCount: columnCounts[endX], confidence: endX > width * 0.6 ? "B" : "C" };
}

function screenshotGraphFailure(status, error, gridLines, lineColorCandidates) {
  return {
    status,
    method: "captureVisibleTab_pixel_analysis",
    diffBallsRaw: null,
    diffBallsConfidence: null,
    axisAssumption: "site7_single_unit_standard_+30000_-30000",
    axisConfidence: "D",
    graphUpperValue: 30000,
    graphLowerValue: -30000,
    graphUpperLineY: null,
    graphLowerLineY: null,
    graphZeroY: null,
    graphEndY: null,
    graphEndX: null,
    graphScaleBallsPerPixel: null,
    horizontalGridLines: gridLines.map((line) => ({ y: line.y, score: line.score })),
    lineColorCandidates,
    error
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const normalized = String(value).replace(/[＋,\s]/g, "").replace(/[−－]/g, "-");
  return /^[-+]?\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : null;
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${blob.type || "image/png"};base64,${btoa(binary)}`;
}

async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return { ok: true, settings: { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) } };
}

async function setSettings(patch) {
  const current = (await getSettings()).settings;
  const settings = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  return { ok: true, settings };
}

async function getData() {
  const session = await ensureSession();
  const masters = await getAppaMasters().catch(() => null);
  const breakdowns = await getKishuBreakdowns().catch(() => null);
  const settings = (await getSettings()).settings;
  const payoutConfig = { adjustPercent: Number(settings.payoutAdjustPercent) || 0, overrides: settings.payoutMapOverrides || {} };
  const stored = await chrome.storage.local.get([STORAGE_KEYS.records, STORAGE_KEYS.pending]);
  const records = Object.values(stored[STORAGE_KEYS.records] || {})
    .map((record) => applyMasterData(structuredClone(record), masters, breakdowns, payoutConfig))
    .sort(sortRecords);
  const rawPending = stored[STORAGE_KEYS.pending] || [];
  const dedupedPending = dedupePending(rawPending);
  const pending = dedupedPending.map((record) => applyMasterData(structuredClone(record), masters, breakdowns, payoutConfig)).sort(sortRecords);
  if (dedupedPending.length !== rawPending.length) await chrome.storage.local.set({ [STORAGE_KEYS.pending]: dedupedPending });
  const all = [...records, ...pending];
  const sessionRecords = all.filter((record) => isInSession(record, session.startedAt));
  const complete = all.filter((record) => record.mergeStatus === "complete").length;
  return {
    ok: true, records, pending, sessionStartedAt: session.startedAt,
    counts: { saved: all.length, session: sessionRecords.length, complete, incomplete: all.length - complete }
  };
}

async function getAppaMasters(forceRefresh = false) {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.appaMasters);
  const cached = stored[STORAGE_KEYS.appaMasters];
  const cachedAt = Date.parse(cached?.fetchedAt || "");
  if (!forceRefresh && cached?.data && Number.isFinite(cachedAt) && Date.now() - cachedAt < APPA_MASTERS_TTL_MS) return cached.data;
  try {
    const response = await fetch(APPA_MASTERS_URL, { redirect: "follow", cache: "no-store" });
    if (!response.ok) throw new Error(`appa masters HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data?.shops) || !Array.isArray(data?.kishus)) throw new Error("appa masters response is invalid");
    await chrome.storage.local.set({ [STORAGE_KEYS.appaMasters]: { fetchedAt: new Date().toISOString(), data } });
    return data;
  } catch (error) {
    if (cached?.data) return cached.data;
    throw error;
  }
}

// appbシートの1行をCSVパース（このシートはセル内にカンマ・引用符を含まない前提の簡易版）。
function parseCsvLine(line) {
  return line.split(",");
}

// appb機種一覧から「機種名 → 出玉内訳[{balls,rounds}]」を作る。
// B〜U列（index 1〜20）が (出玉, R数) の最大10ペア。出玉が正のペアのみ採用。
function parseKishuBreakdownCsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter((line) => line.length);
  const map = {};
  for (const line of lines.slice(1)) { // 先頭はヘッダ
    const cells = parseCsvLine(line);
    const name = (cells[0] || "").trim();
    if (!name || name === "試し打ち") continue;
    const breakdown = [];
    for (let i = 1; i <= 19; i += 2) {
      const balls = Number(cells[i]);
      const rounds = Number(cells[i + 1]);
      if (Number.isFinite(balls) && balls > 0) breakdown.push({ balls, rounds: Number.isFinite(rounds) ? rounds : null });
    }
    if (breakdown.length) map[name] = breakdown;
  }
  return map;
}

// popup向け: 機種名一覧（試し打ち除く）＋各機種の出玉内訳＋超中小の自動マッピング。
async function getMachineOptions() {
  const masters = await getAppaMasters().catch(() => null);
  const breakdowns = await getKishuBreakdowns().catch(() => null);
  const names = (masters?.kishus || []).map((item) => item.name).filter((name) => name && name !== "試し打ち");
  const machines = names.map((name) => {
    const breakdown = breakdowns?.[name] || [];
    return { name, breakdown, auto: autoMapHitPayout(breakdown) };
  });
  return { ok: true, machines };
}

async function getKishuBreakdowns(forceRefresh = false) {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.kishuBreakdowns);
  const cached = stored[STORAGE_KEYS.kishuBreakdowns];
  const cachedAt = Date.parse(cached?.fetchedAt || "");
  if (!forceRefresh && cached?.data && Number.isFinite(cachedAt) && Date.now() - cachedAt < APPA_MASTERS_TTL_MS) return cached.data;
  try {
    const response = await fetch(APPB_BREAKDOWN_CSV_URL, { redirect: "follow", cache: "no-store" });
    if (!response.ok) throw new Error(`appb breakdown HTTP ${response.status}`);
    const data = parseKishuBreakdownCsv(await response.text());
    await chrome.storage.local.set({ [STORAGE_KEYS.kishuBreakdowns]: { fetchedAt: new Date().toISOString(), data } });
    return data;
  } catch (error) {
    if (cached?.data) return cached.data;
    throw error;
  }
}

// 出玉内訳から 超(最大出玉)/中(中間)/小(最小) の代表出玉を自動マッピングする。
// 4種以上は超中小に収まらないので推定対象外として null を返す。
function autoMapHitPayout(breakdown) {
  if (!Array.isArray(breakdown) || !breakdown.length) return null;
  if (breakdown.length > 3) return { tooMany: true, cho: null, chu: null, sho: null };
  const sorted = [...breakdown].sort((a, b) => a.balls - b.balls);
  if (sorted.length === 1) return { cho: sorted[0].balls, chu: null, sho: null };
  if (sorted.length === 2) return { cho: sorted[1].balls, chu: null, sho: sorted[0].balls };
  return { cho: sorted[2].balls, chu: sorted[1].balls, sho: sorted[0].balls };
}

async function ensureSession() {
  const stored = await chrome.storage.session.get(STORAGE_KEYS.session);
  const existing = stored[STORAGE_KEYS.session];
  if (existing?.startedAt) return { ok: true, ...existing };
  const session = { startedAt: new Date().toISOString() };
  await chrome.storage.session.set({ [STORAGE_KEYS.session]: session });
  return { ok: true, ...session };
}

async function deleteCapturedData(criteria) {
  if (criteria?.scope !== "all") throw new Error("Unsupported delete scope");
  const clearedAt = new Date().toISOString();
  await chrome.storage.local.set({
    [STORAGE_KEYS.records]: {},
    [STORAGE_KEYS.pending]: []
  });
  await chrome.storage.session.set({ [STORAGE_KEYS.session]: { startedAt: clearedAt } });
  return { ok: true, deletedScope: criteria.scope, clearedAt };
}

function isInSession(record, startedAt) {
  const timestamp = record.updatedAt || record.captureDateTime || record.createdAt || "";
  return Boolean(timestamp && timestamp >= startedAt);
}

function sortRecords(a, b) {
  return String(b.captureDateTime || "").localeCompare(String(a.captureDateTime || ""));
}

function isKnown(value) {
  return Boolean(value && value !== "unknown");
}

function canonicalKey(record) {
  const identity = isKnown(record.site7Pmc) && isKnown(record.site7Mdc)
    ? ["site7_ids", record.site7Pmc, record.site7Mdc]
    : ["names", record.storeName, record.machineName];
  return [record.source, ...identity, record.daiNormalized, record.businessDate]
    .map((part) => String(part || "").trim())
    .join("|");
}

function secondaryIdentityKey(record) {
  return [record.source, normalizeIdentityText(record.storeName), record.daiNormalized, record.businessDate]
    .map((part) => String(part || "").trim()).join("|");
}

function capturedPartScore(record) {
  return ["summary", "history", "graph"].reduce((score, name) => {
    const part = record.parts?.[name];
    if (part?.status !== "captured") return score;
    if (name === "graph" && hasVerifiedDiff(part)) return score + 3;
    return score + 1;
  }, 0);
}

function hasVerifiedDiff(part) {
  return Number.isFinite(part?.diffBallsFinal);
}

function chooseStoredPart(left, right, name) {
  if (!left) return right;
  if (!right) return left;
  const quality = (part) => part.status === "captured" ? (name === "graph" && hasVerifiedDiff(part) ? 3 : 2) : 0;
  const leftQuality = quality(left), rightQuality = quality(right);
  if (leftQuality !== rightQuality) return rightQuality > leftQuality ? right : left;
  const leftTime = left.updatedAt || left.capturedAt || "";
  const rightTime = right.updatedAt || right.capturedAt || "";
  return rightTime > leftTime ? right : left;
}

function combineStoredRecords(base, candidate) {
  if (!base) return structuredClone(candidate);
  const candidateMachineValid = !isForbiddenMachineName(candidate.machineName, candidate.storeName) && !String(candidate.machineName || "").includes("…");
  const baseMachineValid = !isForbiddenMachineName(base.machineName, base.storeName) && !String(base.machineName || "").includes("…");
  return {
    ...base,
    ...(String(candidate.updatedAt || candidate.captureDateTime || "") > String(base.updatedAt || base.captureDateTime || "") ? candidate : {}),
    machineName: candidateMachineValid ? candidate.machineName : (baseMachineValid ? base.machineName : (candidate.machineName || base.machineName)),
    parts: {
      summary: chooseStoredPart(base.parts?.summary, candidate.parts?.summary, "summary"),
      history: chooseStoredPart(base.parts?.history, candidate.parts?.history, "history"),
      graph: chooseStoredPart(base.parts?.graph, candidate.parts?.graph, "graph"),
      calculation: { ...(base.parts?.calculation || {}), ...(candidate.parts?.calculation || {}) }
    },
    notes: [...new Set([...(base.notes || []), ...(candidate.notes || [])])]
  };
}

function canMerge(record) {
  return record?.source === "site7" &&
    isKnown(record.storeName) &&
    isKnown(record.machineName) &&
    !isForbiddenMachineName(record.machineName, record.storeName) &&
    isKnown(record.daiNormalized) &&
    isKnown(record.businessDate) &&
    !record.identityConflict;
}

function normalizeIdentityText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, "").trim().toLowerCase();
}

function isForbiddenMachineName(value, storeName = "") {
  const normalized = normalizeIdentityText(value);
  const forbidden = ["閲覧履歴", "出玉情報", "出玉推移", "大当り履歴", "大当たり履歴", "出玉詳細", "運日データ", "連日データ", "大当り一覧", "大当たり一覧", "出玉推移一覧", "マイページ", "メニュー", "HYPER ARROW美原店",
    "名無しさん", "名無し", "匿名", "ゲスト", "マイリスト", "マイメモリー", "マイリストに追加", "マイメモリーに追加", "設置機種", "全体を見る", "前の台", "次の台"]
    .map(normalizeIdentityText);
  return !normalized || forbidden.includes(normalized) || normalized === normalizeIdentityText(storeName);
}

function prepareIncomingRecord(existing, incoming) {
  const incomingMachineValid = !isForbiddenMachineName(incoming.machineName, incoming.storeName);
  const existingMachineValid = existing && !isForbiddenMachineName(existing.machineName, existing.storeName);
  return {
    ...incoming,
    machineName: incomingMachineValid ? incoming.machineName : (existingMachineValid ? existing.machineName : "unknown")
  };
}

async function saveCapture(incoming) {
  if (!incoming || typeof incoming !== "object") throw new Error("Capture data is missing");
  // 巡回で機種を指定している場合は、全台をその機種名(appa/appb名)で固定する。
  // これで表記ゆれ店でもスペック・内訳が確実に解決する。
  if (crawlState?.running && crawlState.forceMachine) {
    incoming = { ...incoming, machineName: crawlState.forceMachine };
  }
  await ensureSession();

  const stored = await chrome.storage.local.get([STORAGE_KEYS.records, STORAGE_KEYS.pending]);
  const records = stored[STORAGE_KEYS.records] || {};
  const pending = dedupePending(stored[STORAGE_KEYS.pending] || []);

  const key = canonicalKey(incoming);
  const secondaryKey = secondaryIdentityKey(incoming);
  const matchingRecordEntries = Object.entries(records)
    .filter(([, record]) => secondaryIdentityKey(record) === secondaryKey)
    .sort((a, b) => capturedPartScore(b[1]) - capturedPartScore(a[1]));
  const storageKey = matchingRecordEntries[0]?.[0] || key;
  let existing = null;
  for (const [, record] of matchingRecordEntries) existing = combineStoredRecords(existing, record);
  const masters = await getAppaMasters().catch(() => null);
  const prepared = applyMasterData(prepareIncomingRecord(existing, incoming), masters);

  if (!canMerge(prepared)) {
    const signature = pendingSignature(prepared);
    const existingIndex = pending.findIndex((record) => pendingSignature(record) === signature);
    const pendingRecord = {
      ...prepared,
      mergeStatus: "pending",
      pendingId: existingIndex >= 0 ? pending[existingIndex].pendingId : (incoming.pendingId || `${Date.now()}-${crypto.randomUUID()}`),
      createdAt: existingIndex >= 0 ? (pending[existingIndex].createdAt || pending[existingIndex].captureDateTime) : (prepared.createdAt || prepared.captureDateTime || new Date().toISOString()),
      updatedAt: new Date().toISOString(),
      previousValue: existingIndex >= 0 ? compactPrevious(pending[existingIndex]) : null
    };
    if (existingIndex >= 0) pending.splice(existingIndex, 1, pendingRecord);
    else pending.unshift(pendingRecord);
    await chrome.storage.local.set({ [STORAGE_KEYS.pending]: pending.slice(0, 1000) });
    return { ok: true, status: existingIndex >= 0 ? "pending_updated" : "pending", record: pendingRecord };
  }

  const matchingPending = pending
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => secondaryIdentityKey(record) === secondaryKey)
    .sort((a, b) => String(a.record.captureDateTime || "").localeCompare(String(b.record.captureDateTime || "")));
  const targetPart = partNameForScreen(prepared.screenType);
  if (existing && !matchingPending.length && targetPart &&
      stablePartFingerprint(existing.parts?.[targetPart]) === stablePartFingerprint(prepared.parts?.[targetPart]) &&
      stablePartFingerprint(existing.parts?.calculation?.inputs) === stablePartFingerprint(prepared.parts?.calculation?.inputs) &&
      normalizeIdentityText(existing.machineName) === normalizeIdentityText(prepared.machineName) &&
      normalizeIdentityText(existing.storeName) === normalizeIdentityText(prepared.storeName)) {
    return { ok: true, status: "unchanged", record: existing };
  }
  let merged = existing;
  for (const { record } of matchingPending) {
    const recovered = prepareIncomingRecord(merged || prepared, {
      ...record,
      storeName: prepared.storeName,
      machineName: prepared.machineName,
      site7Pmc: prepared.site7Pmc,
      site7Mdc: prepared.site7Mdc,
      daiNormalized: prepared.daiNormalized,
      businessDate: prepared.businessDate
    });
    merged = mergeRecord(merged, recovered);
  }
  merged = mergeRecord(merged, prepared);
  for (const [duplicateKey] of matchingRecordEntries) delete records[duplicateKey];
  records[storageKey] = merged;
  const promotedIndexes = new Set(matchingPending.map(({ index }) => index));
  const remainingPending = pending.filter((_record, index) => !promotedIndexes.has(index));
  await chrome.storage.local.set({ [STORAGE_KEYS.records]: records, [STORAGE_KEYS.pending]: remainingPending });
  return { ok: true, status: existing ? "updated" : "saved", record: merged };
}

function mergeRecord(existing, incoming) {
  if (!existing) return finalizeRecord({
    ...structuredClone(incoming),
    createdAt: incoming.createdAt || incoming.captureDateTime || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const screenType = incoming.screenType;
  const updatesSummary = screenType === "detail" || screenType === "summary";
  const updatesHistory = screenType === "history";
  const updatesGraph = screenType === "graph";
  const merged = {
    ...existing,
    ...incoming,
    parts: {
      summary: updatesSummary ? mergePart(existing.parts?.summary, incoming.parts?.summary, true) : existing.parts?.summary,
      history: updatesHistory ? mergeHistory(existing.parts?.history, incoming.parts?.history) : existing.parts?.history,
      graph: updatesGraph ? mergePart(existing.parts?.graph, incoming.parts?.graph) : existing.parts?.graph,
      calculation: { ...(existing.parts?.calculation || {}), ...(incoming.parts?.calculation || {}) }
    },
    notes: [...new Set([...(existing.notes || []), ...(incoming.notes || [])])],
    updatedAt: new Date().toISOString()
  };
  return finalizeRecord(merged);
}

function partNameForScreen(screenType) {
  if (screenType === "detail" || screenType === "summary") return "summary";
  if (screenType === "history") return "history";
  if (screenType === "graph") return "graph";
  return null;
}

function stablePartFingerprint(part) {
  const omit = new Set(["capturedAt", "updatedAt", "previousValue", "graphImage", "graphCandidateRects", "selectedGraphRect", "cropPixelRect", "lineColorCandidates", "horizontalGridLines"]);
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !omit.has(key)).map(([key, item]) => [key, stable(item)]));
  };
  return JSON.stringify(stable(part || null));
}

function mergePart(previous, next, preserveExistingOnNull = false) {
  if (!next || next.status === "not_present") return previous || next;
  if (!previous) return next;
  if (partFingerprint(previous) === partFingerprint(next)) return { ...previous, updatedAt: new Date().toISOString() };
  const nextValues = preserveExistingOnNull
    ? Object.fromEntries(Object.entries(next).filter(([key, value]) => key === "status" || key === "capturedAt" || (value !== null && value !== undefined && value !== "")))
    : next;
  return {
    ...previous, ...nextValues,
    capturedAt: nextValues.capturedAt || previous.capturedAt,
    updatedAt: new Date().toISOString(),
    previousValue: compactPrevious(previous)
  };
}

function mergeHistory(previous, next) {
  if (!next || next.status === "not_present") return previous || next;
  if (!previous) return next;
  // The 大当り履歴 page is a complete daily list, so the latest capture is
  // authoritative. Unioning across captures accumulates stale rows (e.g. from a
  // momentarily wrong carousel slide) and inflates the payout total, so adopt
  // next's rows when present and only keep previous rows when next has none.
  const source = (next.rows && next.rows.length) ? next.rows : (previous.rows || []);
  const byNo = new Map();
  for (const row of source) byNo.set(String(row.no), { ...byNo.get(String(row.no)), ...row });
  const rows = [...byNo.values()].sort((a, b) => (Number(b.no) || -1) - (Number(a.no) || -1));
  return {
    ...previous,
    ...next,
    rows,
    // Recompute the payout sum from the deduped rows so the stored total always
    // matches the stored row set, never a leftover value from another capture.
    ...payoutTotalsFromRows(rows),
    updatedAt: new Date().toISOString(),
    previousValue: partFingerprint(previous) === partFingerprint({ ...next, rows }) ? previous.previousValue : compactPrevious(previous)
  };
}

// Sum only numbered jackpot rows (no >= 1) with a numeric payout, mirroring the
// content script's buildPayoutDebug so stored totals stay consistent.
function payoutTotalsFromRows(rows) {
  const included = (rows || []).filter((row) => Number.isInteger(row.no) && row.no >= 1 && typeof row.payout === "number" && Number.isFinite(row.payout))
    .map((row) => ({ no: row.no, payout: row.payout }));
  return {
    payoutTotal: included.reduce((sum, row) => sum + row.payout, 0),
    payoutIncludedRows: included,
    payoutExcludedRows: (rows || []).filter((row) => !included.some((item) => item.no === row.no))
      .map((row) => ({ no: row.no, payout: row.payout, reason: !Number.isInteger(row.no) ? "non_jackpot_row" : "non_numeric_payout" }))
  };
}

function pendingSignature(record) {
  const capturedParts = Object.entries(record.parts || {}).filter(([, part]) => part?.status === "captured").map(([name]) => name).sort().join("+");
  const identity = isKnown(record.site7Pmc) && isKnown(record.site7Mdc)
    ? [record.site7Pmc, record.site7Mdc]
    : [record.storeName, record.machineName];
  return [record.source, ...identity, record.daiNormalized, record.businessDate, capturedParts]
    .map((value) => String(value || "unknown").trim()).join("|");
}

function dedupePending(records) {
  const bySignature = new Map();
  for (const record of records) {
    const key = pendingSignature(record);
    const previous = bySignature.get(key);
    if (!previous || sortRecords(record, previous) < 0) bySignature.set(key, record);
  }
  return [...bySignature.values()];
}

function partFingerprint(part) {
  return JSON.stringify(stripVolatile(part));
}

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["capturedAt", "updatedAt", "previousValue"].includes(key))
    .map(([key, item]) => [key, stripVolatile(item)]));
}

function compactPrevious(value) {
  const previous = structuredClone(value);
  delete previous.previousValue;
  if (previous.graphImage?.startsWith?.("data:")) previous.graphImage = "[data-url omitted]";
  if (previous.parts?.graph?.graphImage?.startsWith?.("data:")) previous.parts.graph.graphImage = "[data-url omitted]";
  return previous;
}

function finalizeRecord(record) {
  const statuses = [record.parts?.summary, record.parts?.history, record.parts?.graph]
    .map((part) => part?.status)
    .filter((status) => status === "captured");
  if (!canMerge(record)) record.mergeStatus = "pending";
  else if (statuses.length === 3) record.mergeStatus = "complete";
  else if (statuses.length === 1 && record.parts?.graph?.status === "captured") record.mergeStatus = "graphOnly";
  else record.mergeStatus = "partial";
  return applyCalculations(record);
}

function applyCalculations(record) {
  const normalStarts = record.parts?.summary?.normalStarts;
  // Derive the payout sum from the stored rows so a stale payoutTotal field can
  // never drive the calculation; fall back to the field only when rows are absent.
  const history = record.parts?.history;
  if (history?.rows?.length) {
    const recomputed = payoutTotalsFromRows(history.rows);
    history.payoutTotal = recomputed.payoutTotal;
    history.payoutIncludedRows = recomputed.payoutIncludedRows;
    history.payoutExcludedRows = recomputed.payoutExcludedRows;
  }
  const payoutTotal = history?.payoutTotal;
  const summary = record.parts?.summary || {};
  // 払出が取れない店向け: 超中小の回数 × 内訳出玉(自動/上書き) × 補正% から払出を推定する。
  // 実測payoutがある台は推定しない（実測優先）。4種以上(tooMany)は推定対象外。
  const hitMap = record.calculationInputs?.hitPayoutMap || record.parts?.calculation?.inputs?.hitPayoutMap;
  let estimatedPayoutTotal = null;
  if (!isFiniteNumber(payoutTotal) && hitMap && !hitMap.tooMany) {
    const counts = [summary.choCount, summary.chuCount, summary.shoCount];
    if (counts.some(isFiniteNumber)) {
      const adjust = 1 + (Number(record.calculationInputs?.payoutAdjustPercent) || 0) / 100;
      const sum = (Number(summary.choCount) || 0) * (Number(hitMap.cho) || 0)
        + (Number(summary.chuCount) || 0) * (Number(hitMap.chu) || 0)
        + (Number(summary.shoCount) || 0) * (Number(hitMap.sho) || 0);
      estimatedPayoutTotal = Math.round(sum * adjust);
    }
  }
  const effectivePayout = isFiniteNumber(payoutTotal) ? payoutTotal : estimatedPayoutTotal;
  const payoutEstimated = !isFiniteNumber(payoutTotal) && isFiniteNumber(estimatedPayoutTotal);
  const graph = record.parts?.graph || {};
  const diffBallsFinal = graph.diffBallsFinal;
  const jackpot = record.parts?.summary?.jackpot;
  // The 大当り履歴 count must equal the summary 大当り回数; a mismatch means the
  // history was read from a different machine/date (e.g. a carousel slide or
  // date tab that did not match the locked context) and merged into this record.
  // Block the calculation rather than emit a payout total from foreign rows.
  const historyHitCount = (history?.rows || []).filter((row) => Number.isInteger(row.no) && row.no >= 1).length;
  const historyMismatch = history?.status === "captured" && isFiniteNumber(jackpot) && historyHitCount !== jackpot;
  const calculation = { ...(record.parts?.calculation || {}) };
  const reasons = [];
  const assumptionsPre = [];
  // 稼働0（総回転0）は未稼働として扱う。
  const idle = isFiniteNumber(summary.totalStarts) ? summary.totalStarts === 0
    : (isFiniteNumber(normalStarts) && normalStarts === 0 && !isFiniteNumber(diffBallsFinal));
  calculation.idle = idle;
  if (!isFiniteNumber(normalStarts)) reasons.push("normalStartsMissing");
  if (!isFiniteNumber(effectivePayout)) reasons.push("payoutTotalMissing");
  if (!isFiniteNumber(diffBallsFinal)) reasons.push("diffBallsMissing");
  if (historyMismatch) reasons.push(`historyHitCountMismatch(summary=${jackpot},history=${historyHitCount})`);
  if (payoutEstimated) assumptionsPre.push("rotationRateEstimated");
  calculation.rotationRateEstimated = payoutEstimated;

  if (!reasons.length) {
    const estimatedUsedBalls = effectivePayout - diffBallsFinal;
    calculation.estimatedUsedBalls = estimatedUsedBalls;
    calculation.rotationRate = estimatedUsedBalls > 0 ? Math.round((normalStarts / estimatedUsedBalls * 250) * 100) / 100 : null;
    if (estimatedUsedBalls <= 0) reasons.push("estimatedUsedBallsInvalid");
    calculation.updatedAt = new Date().toISOString();
  } else {
    calculation.estimatedUsedBalls = null;
    calculation.rotationRate = null;
  }

  calculation.expectedHourly = null;
  calculation.workValue = null;
  calculation.expectedValue = null;
  calculation.assumptions = [...assumptionsPre];
  if (idle) calculation.assumptions.push("idle");
  applyAppaCalculations(record, calculation, reasons, calculation.assumptions);
  calculation.calculationStatus = [...new Set([...reasons, ...calculation.assumptions])];
  calculation.status = calculation.expectedHourly !== null && calculation.workValue !== null
    ? "calculated"
    : (calculation.rotationRate !== null ? "partially_calculated" : "not_calculated");
  record.parts = { ...(record.parts || {}), calculation };
  return record;
}

function applyAppaCalculations(record, calculation, reasons, assumptions) {
  if (!isFiniteNumber(calculation.rotationRate) || calculation.rotationRate <= 0) {
    if (!reasons.includes("rotationRateMissing")) reasons.push("rotationRateMissing");
    return;
  }

  const inputs = calculation.inputs || record.calculationInputs || {};
  const spec = inputs.machineSpec;
  const exchangeRate = Number(inputs.exchangeRate);
  const holdingRatio = Number(inputs.holdingRatio);
  if (!spec || ![spec.heikin, spec.jikan, spec.total, spec.hatsua, spec.heiren].every(isFiniteNumber)) reasons.push("machineSpecMissing");
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) reasons.push("exchangeRateMissing");
  if (!Number.isFinite(holdingRatio) || holdingRatio < 0 || holdingRatio > 1) reasons.push("holdingRatioMissing");
  if (reasons.includes("machineSpecMissing") || reasons.includes("exchangeRateMissing") || reasons.includes("holdingRatioMissing")) return;

  const cashValuePerBall = 100 / exchangeRate;
  const heikin = spec.heikin + (isFiniteNumber(inputs.hitDelta) ? inputs.hitDelta : 0);
  const zenki = heikin * spec.jikan / spec.total * cashValuePerBall;
  const koki = 250 * spec.jikan / calculation.rotationRate * (4 * (1 - holdingRatio) + holdingRatio * cashValuePerBall);
  const expectedHourlyRaw = zenki - koki;
  calculation.expectedHourly = Math.round(expectedHourlyRaw);
  calculation.expectedHourlyMethod = "appa_zenki_minus_koki";
  calculation.expectedValue = Math.round(expectedHourlyRaw * (record.parts.summary.normalStarts / spec.jikan));
  if (inputs.holdingRatioSource === "appa_default_100") assumptions.push("holdingRatioDefault100FromAppa");

  const cashInvestmentYen = Number(inputs.cashInvestmentYen);
  const investedSavedBalls = Number(inputs.investedSavedBalls);
  const recoveredBalls = Number(inputs.recoveredBalls);
  if (![cashInvestmentYen, investedSavedBalls, recoveredBalls].every(Number.isFinite)) {
    calculation.workValue = calculation.expectedValue;
    calculation.workValueMethod = "appa_expected_hourly_x_normal_starts_over_jikan_all_holding";
    assumptions.push("workValueTheoreticalAllHolding");
    return;
  }
  const profit = (recoveredBalls - investedSavedBalls) * cashValuePerBall - cashInvestmentYen;
  const todayHits = Number(inputs.todayHits);
  if (!Number.isFinite(todayHits)) {
    calculation.workValue = calculation.expectedValue;
    calculation.workValueMethod = "appa_expected_hourly_x_normal_starts_over_jikan_all_holding";
    assumptions.push("workValueTheoreticalAllHolding");
    return;
  }
  if (todayHits === 0) {
    const border = spec.hatsua / (heikin * spec.heiren / 250);
    calculation.workValue = Math.round((record.parts.summary.normalStarts / border * 250 * cashValuePerBall) + profit);
    calculation.workValueMethod = "appa_no_hit_exact";
    return;
  }
  const totalRounds = Number(inputs.totalRounds);
  const hitBalls = Number(inputs.hitBalls);
  if (!isFiniteNumber(spec.total1R) || spec.total1R <= 0 || !Number.isFinite(totalRounds) || totalRounds <= 0 || !Number.isFinite(hitBalls)) {
    calculation.workValue = calculation.expectedValue;
    calculation.workValueMethod = "appa_expected_hourly_x_normal_starts_over_jikan_all_holding";
    assumptions.push("workValueTheoreticalAllHolding");
    return;
  }
  const theoreticalRounds = record.parts.summary.normalStarts / spec.total1R;
  const actualBallsPerRound = hitBalls / totalRounds;
  calculation.workValue = Math.round(profit - (totalRounds - theoreticalRounds) * actualBallsPerRound * cashValuePerBall);
  calculation.workValueMethod = "appa_hit_round_adjusted_exact";
}

function applyMasterData(record, masters, breakdowns = null, payoutConfig = {}) {
  if (!record) return record;
  const machineSpec = masters ? findMachineSpec(record.machineName, masters.kishus || []) : null;
  const shop = masters ? findShopRate(record.storeName, masters.shops || []) : null;
  const previousInputs = record.calculationInputs || record.parts?.calculation?.inputs || {};
  // 出玉内訳(超中小→出玉)マッピング。解決後のappa名、無ければ既にappa名で入っているmachineNameで引く。
  const breakdownKey = machineSpec?.name || record.machineName;
  let hitPayoutMap = null;
  if (breakdowns && breakdownKey) {
    const auto = autoMapHitPayout(breakdowns[breakdownKey]);
    const override = payoutConfig?.overrides?.[breakdownKey];
    if (auto?.tooMany) {
      hitPayoutMap = { tooMany: true };
    } else if (auto) {
      hitPayoutMap = override ? {
        cho: isFiniteNumber(Number(override.cho)) ? Number(override.cho) : auto.cho,
        chu: isFiniteNumber(Number(override.chu)) ? Number(override.chu) : auto.chu,
        sho: isFiniteNumber(Number(override.sho)) ? Number(override.sho) : auto.sho
      } : auto;
    }
  }
  const inputs = {
    ...previousInputs,
    machineSpec: previousInputs.machineSpec || machineSpec?.spec || null,
    exchangeRate: previousInputs.exchangeRate || shop?.exchangeRate || null,
    holdingRatio: Number.isFinite(Number(previousInputs.holdingRatio)) ? Number(previousInputs.holdingRatio) : 1,
    holdingRatioSource: previousInputs.holdingRatioSource || "appa_default_100",
    machineMasterName: previousInputs.machineMasterName || machineSpec?.name || null,
    shopMasterName: previousInputs.shopMasterName || shop?.name || null,
    hitPayoutMap: hitPayoutMap || previousInputs.hitPayoutMap || null,
    payoutAdjustPercent: Number(payoutConfig?.adjustPercent) || 0,
    mastersSource: APPA_MASTERS_URL
  };
  record.calculationInputs = inputs;
  record.parts = { ...(record.parts || {}), calculation: { ...(record.parts?.calculation || {}), inputs } };
  return applyCalculations(record);
}

function normalizeMasterText(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[~〜～・･\s_\-]/g, "").replace(/^(?:e|p)+(?=[^a-z])/i, "");
}

// Site7の正式名（長い）→ appa/appbの省略機種名の対応表。
// 正規化したSite7名に test がマッチしたら、その appa名(name)を採用する。
// block:true は「別機種に誤マッチしやすいので未解決(=計算エラー)にする」指定。
// ※順序が重要：先に来たルールが優先。ブロック/限定ルールを汎用ルールより前に置く。
const MACHINE_ALIAS_RULES = [
  // --- 別機種への誤マッチ防止（誤った数値より計算エラーを優先）---
  { test: /大海.*(?:ブラック)?lt/, block: true },        // 大海LT系は通常海と別スペック
  { test: /東京喰種.*(?:超デカ|超一撃)/, block: true },   // 超デカver.は通常東京喰種と別機種
  { test: /傾奇一転/, block: true },                      // appa「慶次」=黄金の一撃。傾奇一転は別機種→エラー
  // --- Re:ゼロ：appaの別機種「異世界」への誤マッチを防ぎつつ判別 ---
  { test: /(?:リゼロ|re:?ゼロ).*249|リゼロ249/, name: "リゼロ249" },
  { test: /(?:リゼロ|re:?ゼロ).*199|リゼロ199/, name: "リゼロ 199" },
  { test: /(?:リゼロ|re:?ゼロ).*m13/, name: "リゼロ 2" },  // season2 M13 → リゼロ2（強欲の可能性あり・要確認）
  { test: /リゼロ|re:?ゼロ/, block: true },               // 上記以外のRe:ゼロ(129ver等)は曖昧→エラー
  // --- 確実な別名（省略名が部分一致で拾えないもの）---
  { test: /はじまりの記憶|エヴァ(?:ンゲリオン)?17/, name: "エヴァ17" },
  { test: /未来への咆哮|エヴァ(?:ンゲリオン)?15/, name: "エヴァ" },
  { test: /新世紀エヴァンゲリオン|エヴァンゲリオン/, name: "エヴァ" },
  { test: /東京喰種|東京グール/, name: "東京グール" },
  { test: /沖縄6|沖海6/, name: "沖海6" },
  { test: /大海物語5|大海5/, name: "大海5" },
  { test: /大海物語4|大海4/, name: "大海4" },
  { test: /転生したらスライム|転スラ/, name: "転スラ" },
  { test: /リコリス|リコイル|リコリコ/, name: "リコリコ" },
  { test: /東京リベンジャー|東リべ/, name: "東リべ" },
  { test: /まどか.?マギカ3|まどマギ3/, name: "まどマギ3" },
  { test: /北斗無双.*夢幻|北斗無双5夢幻/, name: "北斗無双5夢幻" },
  { test: /海物語.*極|極japan|海極/, name: "海極" }
];

function findMachineSpec(machineName, kishus) {
  const normalized = normalizeMasterText(machineName);
  if (!normalized) return null;
  const matchedRule = MACHINE_ALIAS_RULES.find((rule) => rule.test.test(normalized));
  if (matchedRule?.block) return null; // 別機種誤マッチ防止：未解決→計算エラーで告知
  const aliasName = matchedRule?.name || null;
  let row = aliasName ? kishus.find((item) => item.name === aliasName) : null;
  if (!row) row = kishus.find((item) => normalizeMasterText(item.name) === normalized);
  if (!row) {
    row = kishus.filter((item) => normalizeMasterText(item.name).length >= 2 && normalized.includes(normalizeMasterText(item.name)))
      .sort((a, b) => normalizeMasterText(b.name).length - normalizeMasterText(a.name).length)[0];
  }
  if (!row || ![row.heikin, row.total, row.total1R, row.jikan, row.hatsua, row.heiren].every((value) => Number.isFinite(Number(value)))) return null;
  return {
    name: row.name,
    spec: {
      heikin: Number(row.heikin), total: Number(row.total), total1R: Number(row.total1R),
      jikan: Number(row.jikan), hatsua: Number(row.hatsua), heiren: Number(row.heiren)
    }
  };
}

function findShopRate(storeName, shops) {
  const normalized = normalizeMasterText(storeName).replace(/hyper|arrow|アロー|パチンコ|ホール|店/g, "");
  const row = shops.filter((item) => {
    const name = normalizeMasterText(item.name).replace(/店/g, "");
    return name && (normalized === name || normalized.includes(name) || name.includes(normalized));
  }).sort((a, b) => normalizeMasterText(b.name).length - normalizeMasterText(a.name).length)[0];
  const exchangeRate = Number(row?.kokan);
  return row && Number.isFinite(exchangeRate) && exchangeRate > 0 ? { name: row.name, exchangeRate } : null;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// レコードのマスター解決後の機種名（appa名）。未解決は「未解決」グループにまとめる。
function resolvedMachineName(record) {
  return record.calculationInputs?.machineMasterName
    || record.parts?.calculation?.inputs?.machineMasterName
    || "未解決";
}

async function exportData(format, scope = "all", filter = {}) {
  const { records, pending } = await getData();
  const session = await ensureSession();
  // scope（all/session）に加えて、日付・機種（解決後名）でも絞り込む。
  const matches = (record) => {
    if (scope === "session" && !isInSession(record, session.startedAt)) return false;
    if (filter.businessDate && record.businessDate !== filter.businessDate) return false;
    if (filter.machineKey && resolvedMachineName(record) !== filter.machineKey) return false;
    return true;
  };
  const selectedRecords = [...records, ...pending].filter(matches);
  let content;
  let mime;
  let extension;
  if (format === "json") {
    const selectedRecordsOnly = records.filter(matches);
    const selectedPendingOnly = pending.filter(matches);
    content = JSON.stringify({ exportedAt: new Date().toISOString(), scope, filter, sessionStartedAt: session.startedAt, records: selectedRecordsOnly, pending: selectedPendingOnly }, null, 2);
    mime = "application/json";
    extension = "json";
  } else if (format === "csv") {
    content = toSpreadsheetCsv(selectedRecords);
    mime = "text/csv";
    extension = "csv";
  } else if (format === "debugCsv") {
    content = toDebugCsv(selectedRecords);
    mime = "text/csv";
    extension = "csv";
  } else {
    throw new Error("Unsupported export format");
  }

  const bytes = new TextEncoder().encode(`\uFEFF${content}`);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const url = `data:${mime};base64,${btoa(binary)}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sanitize = (value) => String(value).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 24);
  const filterTag = [filter.businessDate ? sanitize(filter.businessDate) : "", filter.machineKey ? sanitize(filter.machineKey) : ""].filter(Boolean).join("-");
  const downloadId = await chrome.downloads.download({
    url,
    filename: `site7-collector-${format === "debugCsv" ? "debug" : format}-${scope}${filterTag ? `-${filterTag}` : ""}-${stamp}.${extension}`,
    saveAs: true
  });
  let archivedAt = null;
  if (scope === "session" && selectedRecords.length > 0) {
    archivedAt = new Date().toISOString();
    await chrome.storage.session.set({ [STORAGE_KEYS.session]: { startedAt: archivedAt } });
  }
  return { ok: true, downloadId, count: selectedRecords.length, scope, archivedAt };
}

const DEBUG_CSV_COLUMNS = [
  "source", "site7Pmc", "site7Mdc", "storeName", "machineName", "dai", "daiNormalized", "daiConfidence", "businessDate",
  "dateConfidence", "screenType", "screenTypeConfidence", "urlDtdd", "urlDaiCandidate", "urlScreenTypeCandidate", "urlDateCandidate",
  "captureDateTime", "summaryStatus", "historyStatus", "graphStatus",
  "mergeStatus", "jackpot", "initialHits", "totalStarts", "normalStarts", "chanceStarts",
  "highestPayout", "finalStarts", "historyRowCount", "payoutTotal", "diffBallsRaw",
  "diffBallsCandidate", "diffBallsFinal", "diffBallsStatus", "diffBallsMethod", "diffBallsConfidence", "axisAssumption", "axisConfidence",
  "estimatedUsedBalls", "rotationRate", "expectedValue", "expectedHourly", "workValue", "calculationStatus",
  "machineMasterName", "shopMasterName", "exchangeRate", "holdingRatio", "expectedHourlyMethod", "workValueMethod", "graphDebug", "historyDebug", "notes"
];

const SPREADSHEET_CSV_COLUMNS = [
  ["日付", "businessDate"], ["店舗", "storeName"], ["機種", "machineName"], ["台番", "daiNormalized"],
  ["期待時給", "expectedHourly"], ["仕事量", "workValue"], ["総回転", "totalStarts"], ["通常回転", "normalStarts"],
  ["回転率", "rotationRate"], ["総当り", "jackpot"], ["初当り", "initialHits"],
  ["超", "choCount"], ["中", "chuCount"], ["小", "shoCount"], ["獲得数合計", "payoutTotal"],
  ["最終差玉", "diffBallsFinal"], ["推定使用玉", "estimatedUsedBalls"], ["最高出玉", "highestPayout"],
  ["最終スタート", "finalStarts"], ["取得状態", "captureStatus"], ["メモ", "notes"]
];

function flattenRecord(record, spreadsheet = false) {
  const summary = record.parts?.summary || {};
  const history = record.parts?.history || {};
  const graph = record.parts?.graph || {};
  const calculation = record.parts?.calculation || {};
  const calculationInputs = calculation.inputs || record.calculationInputs || {};
  const notes = [...(record.notes || [])];
  if (calculation.idle) notes.push("未稼働");
  if (calculation.rotationRateEstimated) notes.push("回転率は推定値(精度低・超中小×内訳出玉)");
  if (calculation.calculationStatus?.length) notes.push(`calculationStatus: ${calculation.calculationStatus.join("|")}`);
  if (graph.status === "captured" && !Number.isFinite(graph.diffBallsFinal)) {
    notes.push(`diffBallsStatus: ${graph.diffBallsStatus || "missing"}`);
    if (graph.screenshotCaptureError) notes.push(`screenshotCaptureError: ${graph.screenshotCaptureError}`);
    if (graph.graphAnalysisError) notes.push(`graphAnalysisError: ${graph.graphAnalysisError}`);
  }
  const safeMachineName = isForbiddenMachineName(record.machineName, record.storeName) ? "" : record.machineName;
  const diffStatus = graph.status === "captured" && !Number.isFinite(graph.diffBallsFinal) ? "missing" : (graph.diffBallsStatus || "not_analyzed");
  return {
    ...record,
    machineName: safeMachineName,
    summaryStatus: summary.status || "not_present",
    historyStatus: history.status || "not_present",
    graphStatus: graph.status || "not_present",
    jackpot: summary.jackpot,
    initialHits: summary.initialHits,
    totalStarts: summary.totalStarts,
    normalStarts: summary.normalStarts,
    chanceStarts: summary.chanceStarts,
    highestPayout: summary.highestPayout,
    finalStarts: summary.finalStarts,
    choCount: summary.choCount,
    chuCount: summary.chuCount,
    shoCount: summary.shoCount,
    historyRowCount: history.rows?.length || 0,
    payoutTotal: Number.isFinite(history.payoutTotal) ? history.payoutTotal : (history.rows || [])
      .filter((item) => Number.isInteger(item.no) && item.no >= 1 && typeof item.payout === "number" && Number.isFinite(item.payout))
      .reduce((sum, item) => sum + item.payout, 0),
    diffBallsRaw: graph.diffBallsRaw,
    diffBallsCandidate: graph.diffBallsCandidate,
    diffBallsFinal: spreadsheet && Number.isFinite(graph.diffBallsFinal) ? Math.round(graph.diffBallsFinal) : graph.diffBallsFinal,
    diffBallsStatus: graph.diffBallsStatus,
    diffBallsMethod: graph.diffBallsMethod,
    diffBallsConfidence: graph.diffBallsConfidence,
    axisAssumption: graph.axisAssumption,
    axisConfidence: graph.axisConfidence,
    estimatedUsedBalls: spreadsheet && Number.isFinite(calculation.estimatedUsedBalls) ? Math.round(calculation.estimatedUsedBalls) : calculation.estimatedUsedBalls,
    rotationRate: calculation.rotationRate,
    expectedValue: calculation.expectedValue,
    expectedHourly: calculation.expectedHourly,
    workValue: calculation.workValue,
    calculationStatus: calculation.calculationStatus,
    machineMasterName: calculationInputs.machineMasterName,
    shopMasterName: calculationInputs.shopMasterName,
    exchangeRate: calculationInputs.exchangeRate,
    holdingRatio: calculationInputs.holdingRatio,
    expectedHourlyMethod: calculation.expectedHourlyMethod,
    workValueMethod: calculation.workValueMethod,
    captureStatus: `summary:${summary.status || "not_present"} / history:${history.status || "not_present"} / graph:${graph.status || "not_present"} / diff:${diffStatus} / merge:${record.mergeStatus || "unknown"}`,
    graphDebug: compactPrevious(graph),
    historyDebug: {
      rowCount: history.rows?.length || 0,
      payoutTotal: history.payoutTotal,
      rows: (history.rows || []).map((item) => ({ no: item.no, start: item.start, payout: item.payout, status: item.status, isChanceHit: item.isChanceHit })),
      payoutIncludedRows: history.payoutIncludedRows,
      payoutExcludedRows: history.payoutExcludedRows
    },
    notes: notes.join(" | ")
  };
}

function toSpreadsheetCsv(records) {
  const lines = [SPREADSHEET_CSV_COLUMNS.map(([header]) => csvCell(header)).join(",")];
  for (const record of records) {
    const row = flattenRecord(record, true);
    lines.push(SPREADSHEET_CSV_COLUMNS.map(([, key]) => csvCell(row[key])).join(","));
  }
  return lines.join("\r\n");
}

function toDebugCsv(records) {
  const lines = [DEBUG_CSV_COLUMNS.join(",")];
  for (const record of records) {
    const row = flattenRecord(record, false);
    lines.push(DEBUG_CSV_COLUMNS.map((column) => csvCell(row[column])).join(","));
  }
  return lines.join("\r\n");
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
