"use strict";

const $ = (selector) => document.querySelector(selector);
const controls = ["enabled", "autoSave", "soundEnabled", "manualStoreName", "manualMachineName", "manualDai", "manualBusinessDate", "manualDiffBalls"];
let lastInspection = null;
let lastPageDebug = null;
let showPendingOnly = false;

document.addEventListener("DOMContentLoaded", initialize);

async function initialize() {
  bindEvents();
  await chrome.runtime.sendMessage({ type: "START_SESSION" });
  const settingsResponse = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  applySettings(settingsResponse.settings || {});
  await Promise.all([refreshPageState(), refreshRecords()]);
}

function bindEvents() {
  for (const id of controls) {
    $("#" + id).addEventListener(id.startsWith("manual") ? "change" : "change", saveSettings);
  }
  $("#capture").addEventListener("click", capturePage);
  $("#exportSessionCsv").addEventListener("click", () => exportData("csv", "session"));
  $("#exportAllCsv").addEventListener("click", () => exportData("csv", "all"));
  $("#exportDebugCsv").addEventListener("click", () => exportData("debugCsv", "all"));
  $("#exportJson").addEventListener("click", () => exportData("json", "all"));
  $("#copyDebug").addEventListener("click", copyDebug);
  $("#clearData").addEventListener("click", clearData);
  $("#pendingOnly").addEventListener("click", async () => {
    showPendingOnly = !showPendingOnly;
    $("#pendingOnly").textContent = showPendingOnly ? "すべて表示" : "pendingのみ";
    await refreshRecords();
  });
  $("#crawlStart").addEventListener("click", startCrawl);
  $("#crawlStop").addEventListener("click", stopCrawl);
}

let crawlPoll = null;

function crawlScreens() {
  return [
    $("#crawlGraph").checked && "graph",
    $("#crawlHistory").checked && "history",
    $("#crawlDetail").checked && "detail"
  ].filter(Boolean);
}

async function startCrawl() {
  const tab = await activeTab();
  if (!tab?.id || !/^https:\/\/([^/]+\.)?site777\.jp\/.*\.do/i.test(tab.url || "")) {
    setCrawlStatus("対象機種・日付のSite7ページ（…/D2600.do など）を開いてから開始してください", "bad");
    return;
  }
  const dryRun = $("#crawlDryRun").checked;
  const message = {
    type: "START_CRAWL",
    tabId: tab.id,
    baseUrl: tab.url,
    dnSpec: $("#crawlDn").value,
    screens: crawlScreens(),
    dryRun,
    minDelayMs: Number($("#crawlMinDelay").value),
    maxDelayMs: Number($("#crawlMaxDelay").value)
  };
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) { setCrawlStatus(response?.error || "巡回を開始できませんでした", "bad"); return; }
  if (response.dryRun) {
    const sample = response.urls.slice(0, 6).map((item) => `dn${item.dn}/${item.screen}: ${item.url}`).join("\n");
    setCrawlStatus(`ドライラン: ${response.dnCount}台 × 画面 = ${response.total}ステップ`, "ok");
    $("#crawlLog").textContent = `${sample}${response.urls.length > 6 ? `\n…他 ${response.urls.length - 6} 件` : ""}`;
    return;
  }
  setCrawlStatus(`巡回開始: ${response.dnCount}台 / ${response.total}ステップ`, "ok");
  $("#crawlStart").disabled = true;
  $("#crawlStop").disabled = false;
  pollCrawl();
}

async function stopCrawl() {
  await chrome.runtime.sendMessage({ type: "STOP_CRAWL" });
  setCrawlStatus("停止を要求しました（現在のステップ完了後に停止）", "warn");
}

function pollCrawl() {
  if (crawlPoll) clearInterval(crawlPoll);
  crawlPoll = setInterval(async () => {
    const status = await chrome.runtime.sendMessage({ type: "GET_CRAWL_STATUS" });
    renderCrawl(status);
    if (!status.running) {
      clearInterval(crawlPoll);
      crawlPoll = null;
      $("#crawlStart").disabled = false;
      $("#crawlStop").disabled = true;
      await refreshRecords();
    }
  }, 1200);
}

function renderCrawl(status) {
  if (!status || status.running === false && !status.total) return;
  const current = status.current ? `dn${status.current.dn}/${status.current.screen}` : "—";
  setCrawlStatus(`${status.running ? "巡回中" : "完了"} ${status.done}/${status.total}（現在: ${current}）`, status.running ? "" : "ok");
  const errors = (status.results || []).filter((result) => !result.ok).length;
  const log = (status.results || []).slice(-12).reverse()
    .map((result) => `dn${result.dn}/${result.screen}: ${result.status}${result.error ? `（${result.error}）` : ""}`).join("\n");
  $("#crawlLog").textContent = `${errors ? `エラー ${errors}件\n` : ""}${log}`;
}

function setCrawlStatus(text, className = "") {
  const node = $("#crawlStatus");
  node.textContent = text;
  node.className = className;
}

function applySettings(settings) {
  $("#enabled").checked = settings.enabled !== false;
  $("#autoSave").checked = Boolean(settings.autoSave);
  $("#soundEnabled").checked = Boolean(settings.soundEnabled);
  $("#manualStoreName").value = settings.manualStoreName || "";
  $("#manualMachineName").value = settings.manualMachineName || "";
  $("#manualDai").value = settings.manualDai || "";
  $("#manualBusinessDate").value = settings.manualBusinessDate || "";
  $("#manualDiffBalls").value = settings.manualDiffBalls ?? "";
}

function collectSettings() {
  return {
    enabled: $("#enabled").checked,
    autoSave: $("#autoSave").checked,
    soundEnabled: $("#soundEnabled").checked,
    manualStoreName: $("#manualStoreName").value.trim(),
    manualMachineName: $("#manualMachineName").value.trim(),
    manualDai: $("#manualDai").value.trim(),
    manualBusinessDate: $("#manualBusinessDate").value,
    manualDiffBalls: $("#manualDiffBalls").value.trim()
  };
}

async function saveSettings() {
  const settings = collectSettings();
  await chrome.runtime.sendMessage({ type: "SET_SETTINGS", settings });
  const tab = await activeTab();
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "SET_ENABLED", enabled: settings.enabled }).catch(() => {});
  }
  await refreshPageState();
}

async function activeTab() {
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
}

async function refreshPageState() {
  const tab = await activeTab();
  if (!tab?.id || !/^https:\/\/([^/]+\.)?site777\.jp\//i.test(tab.url || "")) {
    $("#pageSummary").textContent = "サイトセブンのページを開いてください";
    renderInspection(null);
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_STATE", settings: collectSettings() });
    lastInspection = response.inspection;
    lastPageDebug = response.debug;
    $("#pageSummary").textContent = `${lastInspection.pageType} ページを検出`;
    renderInspection(lastInspection);
  } catch (error) {
    $("#pageSummary").textContent = "ページを再読み込みしてください";
    renderInspection(null);
  }
}

function renderInspection(info) {
  const details = $("#currentDetails");
  if (!info) {
    details.innerHTML = "<dt>状態</dt><dd>取得スクリプトに接続できません</dd>";
    $("#capture").disabled = true;
    return;
  }
  $("#capture").disabled = !$("#enabled").checked;
  details.innerHTML = [
    ["店舗", info.storeName], ["機種", info.machineName], ["台番号", `${info.dai}（正規化: ${info.daiNormalized}）`],
    ["台番理由", info.selectedDaiReason || "not_detected"],
    ["営業日", `${info.businessDate} / 信頼度 ${info.dateConfidence}`],
    ["日付理由", info.selectedBusinessDateReason || "not_detected"], ["画面", info.pageType]
  ].map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("");
}

async function capturePage() {
  setMessage("取得中…");
  $("#capture").disabled = true;
  try {
    const tab = await activeTab();
    const response = await chrome.tabs.sendMessage(tab.id, { type: "CAPTURE_PAGE", settings: collectSettings() });
    if (!response?.ok) throw new Error(response?.error || "保存できませんでした");
    if (response.skipped) {
      setMessage("現在スライドに取得可能なデータがないため保存を見送りました", "warn");
      await refreshPageState();
      return;
    }
    const pendingCount = response.results.filter((result) => result.status?.startsWith("pending")).length;
    setMessage(pendingCount ? `${response.records.length}件保存（pending ${pendingCount}件）` : `${response.records.length}件を保存しました`, pendingCount ? "warn" : "ok");
    await Promise.all([refreshPageState(), refreshRecords()]);
  } catch (error) {
    setMessage(error.message, "bad");
  } finally {
    $("#capture").disabled = false;
  }
}

async function refreshRecords() {
  const response = await chrome.runtime.sendMessage({ type: "GET_DATA" });
  $("#savedCount").textContent = response.counts?.saved ?? 0;
  $("#sessionCount").textContent = response.counts?.session ?? 0;
  $("#completeCount").textContent = response.counts?.complete ?? 0;
  $("#incompleteCount").textContent = response.counts?.incomplete ?? 0;
  const records = showPendingOnly ? response.pending : [...response.records, ...response.pending];
  const tbody = $("#records");
  tbody.replaceChildren();
  if (!records.length) {
    const row = tbody.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 6;
    cell.textContent = "保存データはありません";
    return;
  }
  for (const record of records) {
    const row = tbody.insertRow();
    const values = [
      record.dai || "?", record.businessDate || "?",
      partMark(record.parts?.summary), partMark(record.parts?.history), partMark(record.parts?.graph), record.mergeStatus
    ];
    values.forEach((value, index) => {
      const cell = row.insertCell();
      cell.textContent = value;
      if (index >= 2 && index <= 4) cell.className = value === "✓" ? "ok" : "warn";
      if (index === 5) cell.className = record.mergeStatus === "complete" ? "ok" : "warn";
    });
    row.title = `${record.storeName}\n${record.machineName}`;
  }
}

function partMark(part) {
  return part?.status === "captured" ? "✓" : "—";
}

async function exportData(format, scope) {
  try {
    const response = await chrome.runtime.sendMessage({ type: "EXPORT_DATA", format, scope });
    if (!response.ok) throw new Error(response.error);
    const label = format === "debugCsv" ? "デバッグCSV" : format.toUpperCase();
    setMessage(`${label}を書き出しました（${response.count}件）${response.archivedAt ? "／今回分を過去データへ移しました" : ""}`, "ok");
    if (response.archivedAt) {
      const tab = await activeTab();
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "SESSION_ARCHIVED" }).catch(() => {});
      await refreshRecords();
    }
  } catch (error) { setMessage(error.message, "bad"); }
}

async function copyDebug() {
  const data = await chrome.runtime.sendMessage({ type: "GET_DATA" });
  const tab = await activeTab();
  try {
    const pageState = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_STATE", settings: collectSettings() });
    lastInspection = pageState.inspection;
    lastPageDebug = pageState.debug;
  } catch (_) { /* Keep the latest available snapshot. */ }
  const savedRecord = data.records.find((record) => record.daiNormalized === lastInspection?.daiNormalized && record.businessDate === lastInspection?.businessDate) || null;
  const savedHistory = savedRecord?.parts?.history || null;
  const savedGraph = savedRecord?.parts?.graph || null;
  const debug = {
    ...(lastPageDebug || {}),
    generatedAt: new Date().toISOString(),
    pageTitle: lastPageDebug?.pageTitle || lastInspection?.title || "",
    currentUrl: lastPageDebug?.currentUrl || tab?.url || "",
    detectedStoreCandidates: lastPageDebug?.detectedStoreCandidates || [],
    detectedMachineCandidates: lastPageDebug?.detectedMachineCandidates || [],
    detectedDaiCandidates: lastPageDebug?.detectedDaiCandidates || [],
    selectedDai: lastPageDebug?.selectedDai || lastInspection?.dai || "unknown",
    selectedDaiReason: lastPageDebug?.selectedDaiReason || lastInspection?.selectedDaiReason || "not_detected",
    detectedDateCandidates: lastPageDebug?.detectedDateCandidates || [],
    selectedBusinessDate: lastPageDebug?.selectedBusinessDate || lastInspection?.businessDate || "unknown",
    selectedBusinessDateReason: lastPageDebug?.selectedBusinessDateReason || lastInspection?.selectedBusinessDateReason || "not_detected",
    detectedTables: lastPageDebug?.detectedTables || [],
    detectedGraphCandidates: lastPageDebug?.detectedGraphCandidates || [],
    payoutDebug: savedHistory ? {
      payoutTotal: savedHistory.payoutTotal ?? null,
      includedRows: savedHistory.payoutIncludedRows || [],
      excludedRows: savedHistory.payoutExcludedRows || []
    } : (lastPageDebug?.payoutDebug || null),
    selectedGraphRect: savedGraph?.selectedGraphRect || lastPageDebug?.selectedGraphRect || null,
    graphAnalysisError: savedGraph?.graphAnalysisError || lastPageDebug?.graphAnalysisError || null,
    savedRecord,
    lastSavePayload: lastPageDebug?.lastSavePayload || null,
    inspection: lastInspection,
    settings: collectSettings(),
    counts: { records: data.records.length, pending: data.pending.length },
    userAgent: navigator.userAgent
  };
  await navigator.clipboard.writeText(JSON.stringify(debug, null, 2));
  setMessage("デバッグ情報をコピーしました", "ok");
}

async function clearData() {
  if (!confirm("保存済みのSite7取得データをすべて削除します。CSV出力前の場合は復元できません。本当に削除しますか？")) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_DATA" });
  const tab = await activeTab();
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "DATA_CLEARED" }).catch(() => {});
  setMessage("保存データをすべて削除しました", "ok");
  await refreshRecords();
}

function setMessage(text, className = "") {
  const message = $("#message");
  message.textContent = text;
  message.className = className;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
