"use strict";

const $ = (selector) => document.querySelector(selector);
const controls = ["enabled", "autoSave", "soundEnabled", "manualStoreName", "manualMachineName", "manualDai", "manualBusinessDate", "manualDiffBalls"];
// 自動巡回の入力もpopupを閉じても保持する（settingsへ保存・復元）。
const crawlControls = ["crawlDn", "crawlDtdd", "crawlGraph", "crawlHistory", "crawlDetail", "crawlMinDelay", "crawlMaxDelay", "crawlDryRun"];
let lastInspection = null;
let lastPageDebug = null;
let showPendingOnly = false;
let machinesData = [];              // GET_MASTERS の機種一覧（名前+内訳+自動マッピング）
let payoutOverrides = {};           // 機種ごとの超中小→出玉 上書き { name: {cho,chu,sho} }

document.addEventListener("DOMContentLoaded", initialize);

async function initialize() {
  bindEvents();
  await chrome.runtime.sendMessage({ type: "START_SESSION" });
  await loadMasters();
  const settingsResponse = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  payoutOverrides = settingsResponse.settings?.payoutMapOverrides || {};
  applySettings(settingsResponse.settings || {});
  await Promise.all([refreshPageState(), refreshRecords(), restoreCrawlState()]);
}

// 機種一覧を取得して機種プルダウンを作る。
async function loadMasters() {
  const response = await chrome.runtime.sendMessage({ type: "GET_MASTERS" }).catch(() => null);
  machinesData = response?.machines || [];
  const select = $("#crawlMachine");
  const current = select.value;
  select.innerHTML = '<option value="">自動取得</option>'
    + machinesData.map((machine) => `<option value="${escapeHtml(machine.name)}">${escapeHtml(machine.name)}</option>`).join("");
  select.value = current;
}

function machineByName(name) {
  return machinesData.find((machine) => machine.name === name) || null;
}

// 選択機種の出玉内訳から 超/中/小 のプルダウンを作る。override優先、無ければ自動。
function populatePayoutSelects(name) {
  const machine = machineByName(name);
  const override = payoutOverrides[name] || {};
  const auto = machine?.auto || {};
  const note = $("#payoutMapNote");
  const fill = (select, value) => {
    if (!machine || !machine.breakdown.length) {
      select.innerHTML = '<option value="">—</option>';
      select.value = "";
      select.disabled = true;
      return;
    }
    select.disabled = false;
    select.innerHTML = '<option value="">—</option>'
      + machine.breakdown.map((item) => `<option value="${item.balls}">${item.balls}玉${item.rounds ? `/${item.rounds}R` : ""}</option>`).join("");
    select.value = value != null && value !== "" ? String(value) : "";
  };
  if (auto.tooMany) {
    note.textContent = "この機種は当り種類が4種以上のため推定対象外です（生データのみ）。";
    fill($("#payoutCho"), ""); fill($("#payoutChu"), ""); fill($("#payoutSho"), "");
    $("#payoutCho").disabled = $("#payoutChu").disabled = $("#payoutSho").disabled = true;
  } else {
    note.textContent = machine && machine.breakdown.length ? "既定は自動（超=最大/中=中間/小=最小）。必要なら変更してください。" : "";
    fill($("#payoutCho"), override.cho ?? auto.cho);
    fill($("#payoutChu"), override.chu ?? auto.chu);
    fill($("#payoutSho"), override.sho ?? auto.sho);
  }
}

// 機種選択が変わったら超中小を作り直して保存。
function onMachineChange() {
  populatePayoutSelects($("#crawlMachine").value);
  saveSettings();
}

// 超中小プルダウンが変わったら、その機種の上書きを更新して保存。
function onPayoutMapChange() {
  const name = $("#crawlMachine").value;
  if (!name) return;
  const num = (id) => { const value = $(id).value; return value === "" ? null : Number(value); };
  payoutOverrides[name] = { cho: num("#payoutCho"), chu: num("#payoutChu"), sho: num("#payoutSho") };
  saveSettings();
}

// popupを開き直したとき、巡回が継続中ならUIとポーリングを復帰させる。
async function restoreCrawlState() {
  const status = await chrome.runtime.sendMessage({ type: "GET_CRAWL_STATUS" }).catch(() => null);
  if (status?.running) {
    $("#crawlStart").disabled = true;
    $("#crawlStop").disabled = false;
    renderCrawl(status);
    pollCrawl();
  }
}

function bindEvents() {
  for (const id of [...controls, ...crawlControls]) {
    $("#" + id).addEventListener("change", saveSettings);
  }
  $("#capture").addEventListener("click", capturePage);
  $("#exportSessionCsv").addEventListener("click", () => exportData("csv", "session"));
  $("#exportFilteredCsv").addEventListener("click", exportFilteredCsv);
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
  $("#crawlMachine").addEventListener("change", onMachineChange);
  for (const id of ["payoutCho", "payoutChu", "payoutSho"]) $("#" + id).addEventListener("change", onPayoutMapChange);
  $("#payoutAdjust").addEventListener("change", saveSettings);
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
  if (!tab?.id || !/^https:\/\/([^/]+\.)?site777\.jp\/.*D2600\.do/i.test(tab.url || "")) {
    setCrawlStatus("出玉推移ページ（…/D2600.do）を開いてから開始してください（他ページはパラメータが異なりエラーになります）", "bad");
    return;
  }
  let dnSpec = $("#crawlDn").value.trim();
  if (!dnSpec) {
    const detected = await detectDaiList(tab.id);
    if (detected.values.length) {
      dnSpec = compactDaiSpec(detected.values);
      $("#crawlDn").value = dnSpec;
      await saveSettings();
      setCrawlStatus(`台番号を自動検出しました: ${dnSpec}（${detected.reason} / ${detected.confidence}）`, "ok");
    }
  }
  const dryRun = $("#crawlDryRun").checked;
  const message = {
    type: "START_CRAWL",
    tabId: tab.id,
    baseUrl: tab.url,
    dnSpec,
    dtddSpec: $("#crawlDtdd").value.trim(),
    screens: crawlScreens(),
    dryRun,
    minDelayMs: Number($("#crawlMinDelay").value),
    maxDelayMs: Number($("#crawlMaxDelay").value)
  };
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) { setCrawlStatus(response?.error || "巡回を開始できませんでした", "bad"); return; }
  if (response.dryRun) {
    const sample = response.urls.slice(0, 6).map((item) => `dtdd${item.dtdd}/dn${item.dn}/${item.screen}: ${item.url}`).join("\n");
    setCrawlStatus(`ドライラン: ${response.dtddCount || 1}日 × ${response.dnCount}台 × 画面 = ${response.total}ステップ`, "ok");
    $("#crawlLog").textContent = `${sample}${response.urls.length > 6 ? `\n…他 ${response.urls.length - 6} 件` : ""}`;
    return;
  }
  setCrawlStatus(`巡回開始: ${response.dtddCount || 1}日 × ${response.dnCount}台 / ${response.total}ステップ`, "ok");
  $("#crawlStart").disabled = true;
  $("#crawlStop").disabled = false;
  pollCrawl();
}

async function detectDaiList(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "GET_DAI_LIST" });
    const values = Array.isArray(response?.daiList?.values) ? response.daiList.values : [];
    return { values, reason: response?.daiList?.reason || "not_detected", confidence: response?.daiList?.confidence || "D" };
  } catch (_) {
    return { values: [], reason: "content_script_unavailable", confidence: "D" };
  }
}

function compactDaiSpec(values) {
  const numbers = [...new Set(values.map((value) => Number(value)).filter(Number.isFinite))].sort((a, b) => a - b);
  const ranges = [];
  for (let index = 0; index < numbers.length; index++) {
    const start = numbers[index];
    let end = start;
    while (index + 1 < numbers.length && numbers[index + 1] === end + 1) {
      index += 1;
      end = numbers[index];
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
  }
  return ranges.join(",");
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
  const current = status.current ? `dtdd${status.current.dtdd}/dn${status.current.dn}/${status.current.screen}` : "—";
  if (status.stopping) {
    setCrawlStatus(`停止中… 現在の読み込みを中断しています（現在: ${current}）`, "warn");
  } else if (status.running && status.backoffUntil) {
    const remain = Math.max(0, Math.ceil((status.backoffUntil - Date.now()) / 1000));
    setCrawlStatus(`混雑のため退避中… あと約${remain}秒で再試行（現在: ${current}）`, "warn");
  } else if (!status.running && status.stoppedReason === "busy_limit") {
    setCrawlStatus(`混雑が続いたため停止しました ${status.done}/${status.total}。時間を空けて再開してください`, "bad");
  } else if (!status.running && status.stoppedReason === "user_stop") {
    setCrawlStatus(`停止しました ${status.done}/${status.total}`, "warn");
  } else {
    setCrawlStatus(`${status.running ? "巡回中" : "完了"} ${status.done}/${status.total}（現在: ${current}）`, status.running ? "" : "ok");
  }
  const errors = (status.results || []).filter((result) => !result.ok).length;
  const log = (status.results || []).slice(-12).reverse()
    .map((result) => `dtdd${result.dtdd ?? "?"}/dn${result.dn}/${result.screen}: ${result.status}${result.error ? `（${result.error}）` : ""}`).join("\n");
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
  // 自動巡回入力の復元（未設定なら既定: 3画面ON・遅延8〜20秒）。
  $("#crawlDn").value = settings.crawlDn || "";
  $("#crawlDtdd").value = settings.crawlDtdd || "";
  $("#crawlGraph").checked = settings.crawlGraph !== false;
  $("#crawlHistory").checked = settings.crawlHistory !== false;
  $("#crawlDetail").checked = settings.crawlDetail !== false;
  $("#crawlMinDelay").value = settings.crawlMinDelay ?? 2000;
  $("#crawlMaxDelay").value = settings.crawlMaxDelay ?? 5000;
  $("#crawlDryRun").checked = Boolean(settings.crawlDryRun);
  // 機種指定・出玉補正・超中小マッピングの復元
  $("#crawlMachine").value = settings.crawlMachine || "";
  $("#payoutAdjust").value = settings.payoutAdjustPercent ?? 0;
  populatePayoutSelects($("#crawlMachine").value);
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
    manualDiffBalls: $("#manualDiffBalls").value.trim(),
    crawlDn: $("#crawlDn").value.trim(),
    crawlDtdd: $("#crawlDtdd").value.trim(),
    crawlGraph: $("#crawlGraph").checked,
    crawlHistory: $("#crawlHistory").checked,
    crawlDetail: $("#crawlDetail").checked,
    crawlMinDelay: Number($("#crawlMinDelay").value) || 2000,
    crawlMaxDelay: Number($("#crawlMaxDelay").value) || 5000,
    crawlDryRun: $("#crawlDryRun").checked,
    crawlMachine: $("#crawlMachine").value,
    payoutAdjustPercent: Number($("#payoutAdjust").value) || 0,
    payoutMapOverrides: payoutOverrides
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
  populateExportFilters([...(response.records || []), ...(response.pending || [])]);
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

// 日付プルダウン・機種プルダウン（解決後名）の現在値で絞ってCSV出力する。
function exportFilteredCsv() {
  exportData("csv", "all", { businessDate: $("#filterDate").value, machineKey: $("#filterMachine").value });
}

// マスター解決後の機種名（未解決は「未解決」）。popup側でもbackgroundと同じ規則で求める。
function resolvedMachineName(record) {
  return record.calculationInputs?.machineMasterName
    || record.parts?.calculation?.inputs?.machineMasterName
    || "未解決";
}

// 保存データから日付・機種の選択肢を作る。選択中の値は保持する。
function populateExportFilters(allRecords) {
  const fillSelect = (select, values, currentValue) => {
    const options = ['<option value="">すべて</option>']
      .concat(values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`));
    select.innerHTML = options.join("");
    select.value = values.includes(currentValue) ? currentValue : "";
  };
  const dates = [...new Set(allRecords.map((record) => record.businessDate).filter(Boolean))].sort().reverse();
  const machines = [...new Set(allRecords.map(resolvedMachineName))].sort();
  fillSelect($("#filterDate"), dates, $("#filterDate").value);
  fillSelect($("#filterMachine"), machines, $("#filterMachine").value);
}

async function exportData(format, scope, filter = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ type: "EXPORT_DATA", format, scope, businessDate: filter.businessDate || "", machineKey: filter.machineKey || "" });
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
