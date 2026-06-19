"use strict";

const STORAGE_KEYS = {
  records: "site7RecordsV1",
  pending: "site7PendingV1",
  settings: "site7SettingsV1",
  session: "site7SessionV1",
  appaMasters: "site7AppaMastersV1"
};

const APPA_MASTERS_URL = "https://script.google.com/macros/s/AKfycbzFtMJ354oeVAeNVTGLckNVXX9I1URLJTrlMTafDNO6UPOf7yo3bnaac_yPKYV8hVv8/exec?action=masters";
const APPA_MASTERS_TTL_MS = 6 * 60 * 60 * 1000;

const DEFAULT_SETTINGS = {
  enabled: true,
  autoSave: false,
  soundEnabled: false,
  manualStoreName: "",
  manualMachineName: "",
  manualDai: "",
  manualBusinessDate: "",
  manualDiffBalls: ""
};

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
      return exportData(message.format, message.scope);
    case "CLEAR_DATA":
      return deleteCapturedData({ scope: "all" });
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
  const stored = await chrome.storage.local.get([STORAGE_KEYS.records, STORAGE_KEYS.pending]);
  const records = Object.values(stored[STORAGE_KEYS.records] || {})
    .map((record) => applyMasterData(structuredClone(record), masters))
    .sort(sortRecords);
  const rawPending = stored[STORAGE_KEYS.pending] || [];
  const dedupedPending = dedupePending(rawPending);
  const pending = dedupedPending.map((record) => applyMasterData(structuredClone(record), masters)).sort(sortRecords);
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
  const forbidden = ["閲覧履歴", "出玉情報", "出玉推移", "大当り履歴", "大当たり履歴", "出玉詳細", "運日データ", "大当り一覧", "大当たり一覧", "出玉推移一覧", "マイページ", "メニュー", "HYPER ARROW美原店"]
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
  if (!isFiniteNumber(normalStarts)) reasons.push("normalStartsMissing");
  if (!isFiniteNumber(payoutTotal)) reasons.push("payoutTotalMissing");
  if (!isFiniteNumber(diffBallsFinal)) reasons.push("diffBallsMissing");
  if (historyMismatch) reasons.push(`historyHitCountMismatch(summary=${jackpot},history=${historyHitCount})`);

  if (!reasons.length) {
    const estimatedUsedBalls = payoutTotal - diffBallsFinal;
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
  calculation.assumptions = [];
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

function applyMasterData(record, masters) {
  if (!record) return record;
  if (!masters) return applyCalculations(record);
  const machineSpec = findMachineSpec(record.machineName, masters.kishus || []);
  const shop = findShopRate(record.storeName, masters.shops || []);
  const previousInputs = record.calculationInputs || record.parts?.calculation?.inputs || {};
  const inputs = {
    ...previousInputs,
    machineSpec: previousInputs.machineSpec || machineSpec?.spec || null,
    exchangeRate: previousInputs.exchangeRate || shop?.exchangeRate || null,
    holdingRatio: Number.isFinite(Number(previousInputs.holdingRatio)) ? Number(previousInputs.holdingRatio) : 1,
    holdingRatioSource: previousInputs.holdingRatioSource || "appa_default_100",
    machineMasterName: previousInputs.machineMasterName || machineSpec?.name || null,
    shopMasterName: previousInputs.shopMasterName || shop?.name || null,
    mastersSource: APPA_MASTERS_URL
  };
  record.calculationInputs = inputs;
  record.parts = { ...(record.parts || {}), calculation: { ...(record.parts?.calculation || {}), inputs } };
  return applyCalculations(record);
}

function normalizeMasterText(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[~〜～・･\s_\-]/g, "").replace(/^(?:e|p)+(?=[^a-z])/i, "");
}

function findMachineSpec(machineName, kishus) {
  const normalized = normalizeMasterText(machineName);
  if (!normalized) return null;
  const aliasName = /はじまりの記憶|エヴァ(?:ンゲリオン)?17/.test(normalized) ? "エヴァ17" :
    (/新世紀エヴァンゲリオン|エヴァンゲリオン/.test(normalized) ? "エヴァ" : null);
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

async function exportData(format, scope = "all") {
  const { records, pending } = await getData();
  const session = await ensureSession();
  const allRecords = [...records, ...pending];
  const selectedRecords = scope === "session" ? allRecords.filter((record) => isInSession(record, session.startedAt)) : allRecords;
  let content;
  let mime;
  let extension;
  if (format === "json") {
    const selectedRecordsOnly = scope === "session" ? records.filter((record) => isInSession(record, session.startedAt)) : records;
    const selectedPendingOnly = scope === "session" ? pending.filter((record) => isInSession(record, session.startedAt)) : pending;
    content = JSON.stringify({ exportedAt: new Date().toISOString(), scope, sessionStartedAt: session.startedAt, records: selectedRecordsOnly, pending: selectedPendingOnly }, null, 2);
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
  const downloadId = await chrome.downloads.download({
    url,
    filename: `site7-collector-${format === "debugCsv" ? "debug" : format}-${scope}-${stamp}.${extension}`,
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
  ["回転率", "rotationRate"], ["総当り", "jackpot"], ["初当り", "initialHits"], ["獲得数合計", "payoutTotal"],
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
