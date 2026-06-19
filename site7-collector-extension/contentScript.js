(() => {
  "use strict";

  if (window.__site7CollectorLoaded) return;
  window.__site7CollectorLoaded = true;

  const state = {
    settings: null, inspection: null, currentContext: null, currentContextDebug: null, contextUrl: "",
    saveCount: 0, observerTimer: null, lastAutoSignature: "", lastSavePayload: null,
    autoSaveInFlight: false, autoRetryTimer: null, autoAttemptCount: 0
  };
  const LABELS = {
    jackpot: ["大当り回数", "大当たり回数", "大当り"],
    initialHits: ["初当り回数", "初当たり回数", "初当り"],
    totalStarts: ["累計スタート", "総スタート", "累計回転"],
    normalStarts: ["通常スタート", "通常回転", "通常"],
    chanceStarts: ["チャンス中スタート", "チャンス中", "時短中"],
    highestPayout: ["最高出玉", "最大出玉"],
    finalStarts: ["スタート", "最終スタート", "現在スタート"],
    initialProbability: ["初当り確率", "初当たり確率"],
    chanceProbability: ["チャンス確率"],
    updateTime: ["更新時間", "更新時刻", "最終更新"]
  };
  const FORBIDDEN_MACHINE_NAMES = new Set([
    "閲覧履歴", "出玉情報", "出玉推移", "大当り履歴", "大当たり履歴", "出玉詳細", "運日データ",
    "大当り一覧", "大当たり一覧", "出玉推移一覧", "マイページ", "メニュー", "HYPER ARROW美原店"
  ]);
  const SCREEN_LABELS = new Map([
    ["出玉推移", "graph"], ["大当り履歴", "history"], ["大当たり履歴", "history"],
    ["出玉詳細", "detail"], ["運日データ", "summary"]
  ]);

  boot();

  async function boot() {
    const response = await send({ type: "GET_SETTINGS" }).catch(() => null);
    state.settings = response?.settings || { enabled: true, autoSave: false, soundEnabled: false };
    if (!state.settings.enabled) return;
    await inspectAndRender();
    observePage();
    if (shouldAutoSave(state.inspection)) autoSave();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_PAGE_STATE") {
      state.settings = { ...state.settings, ...(message.settings || {}) };
      inspectAndRender().then(() => sendResponse({ ok: true, inspection: state.inspection, debug: buildDebugSnapshot() }));
      return true;
    }
    if (message?.type === "CAPTURE_PAGE") {
      state.settings = { ...state.settings, ...(message.settings || {}) };
      captureAndSave(false).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "SET_ENABLED") {
      state.settings = { ...state.settings, enabled: Boolean(message.enabled) };
      if (state.settings.enabled) inspectAndRender(); else removeStatusBar();
      sendResponse({ ok: true });
    }
    if (message?.type === "DATA_CLEARED") {
      state.saveCount = 0;
      renderStatusBar(state.inspection || inspectPage());
      sendResponse({ ok: true });
    }
    if (message?.type === "SESSION_ARCHIVED") {
      state.saveCount = 0;
      state.lastAutoSignature = buildAutoSignature(state.inspection);
      state.autoAttemptCount = 0;
      renderStatusBar(state.inspection || inspectPage());
      sendResponse({ ok: true });
    }
    return false;
  });

  function send(message) {
    return chrome.runtime.sendMessage(message);
  }

  function observePage() {
    const observer = new MutationObserver(() => {
      clearTimeout(state.observerTimer);
      state.observerTimer = setTimeout(async () => {
        if (!state.settings?.enabled) return;
        await inspectAndRender();
        if (shouldAutoSave(state.inspection)) autoSave();
      }, 900);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "aria-selected"] });
    window.addEventListener("popstate", () => setTimeout(inspectAndRender, 300));
    window.addEventListener("hashchange", () => setTimeout(inspectAndRender, 300));
  }

  async function inspectAndRender() {
    if (state.contextUrl && state.contextUrl !== currentPageKey()) {
      state.currentContext = null;
      state.currentContextDebug = null;
      state.contextUrl = "";
      state.lastAutoSignature = "";
      state.autoAttemptCount = 0;
      clearTimeout(state.autoRetryTimer);
    }
    const liveInspection = inspectPage();
    lockCurrentContext(liveInspection, false);
    state.inspection = applyCurrentContext(liveInspection);
    renderStatusBar(state.inspection);
    return state.inspection;
  }

  function lockCurrentContext(inspection, force) {
    if (state.currentContext && !force) return state.currentContext;
    if (!force && !isContextReady(inspection)) return null;
    state.currentContext = {
      source: "site7",
      site7Pmc: inspection.site7Pmc,
      site7Mdc: inspection.site7Mdc,
      storeName: inspection.storeName,
      machineName: inspection.machineName,
      daiNormalized: inspection.daiNormalized,
      businessDate: inspection.businessDate,
      screenType: inspection.screenType,
      urlPath: inspection.urlPath,
      urlParams: structuredClone(inspection.urlParams)
    };
    state.currentContextDebug = structuredClone(inspection);
    state.contextUrl = currentPageKey();
    return state.currentContext;
  }

  function isContextReady(inspection) {
    return inspection.site7Pmc && inspection.site7Mdc && inspection.storeName !== "unknown" &&
      inspection.daiNormalized !== "unknown" && inspection.businessDate !== "unknown" && inspection.screenType !== "unknown";
  }

  function currentPageKey() {
    return `${location.origin}${location.pathname}${location.search}`;
  }

  function applyCurrentContext(inspection) {
    const context = state.currentContext;
    if (!context) return inspection;
    const debug = state.currentContextDebug || inspection;
    return {
      ...inspection,
      source: context.source,
      site7Pmc: context.site7Pmc,
      site7Mdc: context.site7Mdc,
      storeName: context.storeName,
      machineName: context.machineName,
      dai: context.daiNormalized,
      daiNormalized: context.daiNormalized,
      selectedDai: context.daiNormalized,
      selectedDaiReason: debug.selectedDaiReason,
      daiConfidence: debug.daiConfidence,
      detectedDaiCandidates: debug.detectedDaiCandidates,
      businessDate: context.businessDate,
      selectedBusinessDate: context.businessDate,
      selectedBusinessDateReason: debug.selectedBusinessDateReason,
      dateConfidence: debug.dateConfidence,
      detectedDateCandidates: debug.detectedDateCandidates,
      selectedMachineReason: debug.selectedMachineReason,
      screenType: context.screenType,
      pageType: context.screenType,
      selectedScreenType: context.screenType,
      selectedScreenTypeReason: debug.selectedScreenTypeReason,
      screenTypeConfidence: debug.screenTypeConfidence,
      urlPath: context.urlPath,
      urlParams: structuredClone(context.urlParams),
      contextLocked: true
    };
  }

  function inspectPage() {
    const urlInfo = parseSite7Url(location.href);
    const screen = detectScreenTypeDetails(urlInfo);
    const store = detectStoreDetails();
    const daiDetection = detectDaiDetails(document, urlInfo);
    const currentScope = resolveCurrentUnitScope(daiDetection.selected);
    const scopedMachine = detectMachineDetails(currentScope || document, urlInfo, store.selected);
    const machine = scopedMachine.selected ? scopedMachine : detectMachineDetails(document, urlInfo, store.selected);
    const date = detectBusinessDateDetails(state.settings?.manualBusinessDate, document, urlInfo);
    const graphCandidates = screen.selected === "graph" ? collectGraphCandidates(document) : [];
    const detectedTables = describeTables(currentScope || document);
    const mainGraphCandidate = selectPrimaryGraph(graphCandidates, { screenType: screen.selected, urlPath: urlInfo.path, dateLabel: date.dateLabel, businessDate: date.businessDate });
    const detectedParts = {
      summary: ["detail", "summary"].includes(screen.selected) && captureSummary(currentScope || document, null).status === "captured",
      history: screen.selected === "history" && Boolean(findHistoryTable(currentScope || document)),
      graph: Boolean(mainGraphCandidate)
    };
    return {
      pageType: screen.selected,
      screenType: screen.selected,
      screenTypeConfidence: screen.confidence,
      storeName: store.selected || "unknown",
      machineName: machine.selected || "unknown",
      dai: daiDetection.selected || "unknown",
      daiNormalized: normalizeDai(daiDetection.selected),
      businessDate: date.businessDate,
      dateLabel: date.dateLabel,
      dateConfidence: date.confidence,
      site7Pmc: urlInfo.params.pmc,
      site7Mdc: urlInfo.params.mdc,
      urlDtdd: urlInfo.params.dtdd,
      urlDaiCandidate: urlInfo.daiCandidate,
      urlScreenTypeCandidate: urlInfo.screenTypeCandidate,
      urlDateCandidate: urlInfo.dateCandidate,
      urlPath: urlInfo.path,
      urlParams: urlInfo.params,
      detectedStoreCandidates: store.candidates,
      selectedStoreName: store.selected || "unknown",
      selectedStoreReason: store.reason,
      detectedMachineCandidates: machine.candidates,
      selectedMachineName: machine.selected || "unknown",
      selectedMachineReason: machine.reason,
      ignoredMachineCandidates: machine.ignoredCandidates,
      detectedDaiCandidates: daiDetection.candidates,
      selectedDai: daiDetection.selected || "unknown",
      selectedDaiReason: daiDetection.reason,
      daiConfidence: daiDetection.confidence,
      ignoredDaiCandidates: daiDetection.ignoredCandidates,
      detectedDateCandidates: date.candidates,
      selectedBusinessDate: date.businessDate,
      selectedBusinessDateReason: date.reason,
      dateTabCandidates: date.candidates,
      screenTabCandidates: screen.candidates,
      selectedScreenType: screen.selected,
      selectedScreenTypeReason: screen.reason,
      detectedTables,
      detectedGraphCandidates: graphCandidates.map((candidate) => candidate.debug),
      detectedParts,
      url: location.href,
      title: document.title
    };
  }

  function manualOr(manual, detected, fallback) {
    return clean(manual) || clean(detected) || fallback;
  }

  function detectPageType(root = document) {
    const hasHistory = Boolean(findHistoryTable(root));
    const graphCount = findGraphElements(root).length;
    const hasSummary = captureSummary(root, null).status === "captured";
    const found = [hasSummary && "summary", hasHistory && "history", graphCount && "graph"].filter(Boolean);
    return found.length > 1 ? "mixed" : found[0] || "unknown";
  }

  function parseSite7Url(urlValue) {
    const url = new URL(urlValue);
    const params = Object.fromEntries(["pmc", "dn", "mdc", "dtdd"].map((key) => [key, url.searchParams.get(key) || ""]));
    const file = url.pathname.split("/").pop()?.toUpperCase() || "";
    const screenTypeCandidate = file === "D2600.DO" ? "graph" : file === "D2700.DO" ? "history" : file === "D4000.DO" ? "detail" : "unknown";
    const offset = /^\d+$/.test(params.dtdd) ? Number(params.dtdd) : null;
    return {
      path: url.pathname,
      params,
      screenTypeCandidate,
      daiCandidate: /^0*\d{1,6}$/.test(params.dn) ? String(Number(params.dn)) : "",
      dateCandidate: offset === null ? "" : isoDateFromOffset(offset)
    };
  }

  function isoDateFromOffset(offset) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function detectScreenTypeDetails(urlInfo, root = document) {
    const candidates = collectScreenTabCandidates(root);
    const selectedTab = candidates.filter((candidate) => candidate.explicitSelected || candidate.styleSelected).sort((a, b) => b.score - a.score)[0];
    const urlType = urlInfo.screenTypeCandidate;
    if (urlType !== "unknown" && selectedTab?.screenType === urlType) {
      return { selected: urlType, reason: "url_path+selected_screen_tab", confidence: "A", candidates };
    }
    if (urlType !== "unknown") return { selected: urlType, reason: selectedTab ? "url_path_header_conflict" : "url_path", confidence: selectedTab ? "B" : "A", candidates };
    if (selectedTab) return { selected: selectedTab.screenType, reason: "selected_screen_tab", confidence: "A", candidates };
    const domType = detectPageType(root);
    return { selected: domType, reason: "page_content", confidence: domType === "unknown" ? "D" : "C", candidates };
  }

  function collectScreenTabCandidates(root) {
    const raw = [];
    for (const element of root.querySelectorAll("a,button,li,td,th,div,span,[role='tab']")) {
      if (!isVisible(element) || element.children.length > 1) continue;
      const rect = element.getBoundingClientRect();
      if (horizontalVisibleRatio(rect) < 0.6 || rect.bottom <= 0 || rect.top > Math.min(280, window.innerHeight * 0.4)) continue;
      const label = clean(element.textContent);
      const screenType = SCREEN_LABELS.get(label);
      if (!screenType) continue;
      const style = getComputedStyle(element);
      const className = String(element.className || "");
      const explicitSelected = element.getAttribute("aria-selected") === "true" || element.getAttribute("aria-current") === "page" ||
        /(?:^|[\s_-])(active|selected|current|on)(?:$|[\s_-])/i.test(className);
      raw.push({ label, screenType, className, backgroundColor: style.backgroundColor, luminance: colorLuminance(style.backgroundColor), rect: rectObject(rect), explicitSelected, styleSelected: false, score: explicitSelected ? 1000 : 0 });
    }
    markDarkestSelected(raw, 25);
    return dedupeDebugCandidates(raw);
  }

  function detectStoreDetails(root = document) {
    const candidates = [];
    const add = (value, reason, score) => {
      value = normalizeAsciiWidth(clean(value));
      if (!value || value.length > 100 || /サイトセブン|Site.?Seven/i.test(value)) return;
      candidates.push({ value, reason, score });
    };
    add(findLabeledValue(["店舗名", "ホール名", "店名"], root), "labeled_store", 900);
    for (const element of root.querySelectorAll("div,span,p,strong,b")) {
      if (!isVisible(element) || element.children.length > 1) continue;
      const value = clean(element.textContent);
      if (value.length <= 60 && /(?:店|ホール)$|ARROW|アロー/i.test(value)) add(value, "page_header", 850);
    }
    for (const element of root.querySelectorAll("header, h1, h2, [class*='store'], [class*='hall']")) {
      const value = clean(element.textContent);
      if (/店$|ホール|ARROW|アロー/i.test(value)) add(value, "page_header", 800);
    }
    const params = new URL(location.href).searchParams;
    add(params.get("storeName") || params.get("hallName") || params.get("hall"), "url_parameter", 400);
    add(state.settings?.manualStoreName, "manual_override", 300);
    return selectCandidate(candidates);
  }

  function detectMachineDetails(root = document, urlInfo = parseSite7Url(location.href), storeName = "") {
    const candidates = [];
    const ignoredCandidates = [];
    const add = (value, reason, score, element = null) => {
      value = sanitizeMachineName(value);
      if (!isPlausibleMachineName(value, storeName)) {
        if (value) ignoredCandidates.push({ value, reason, ignoredReason: sameIdentityText(value, storeName) ? "store_name" : (FORBIDDEN_MACHINE_NAMES.has(value) ? "page_or_tab_label" : "not_plausible") });
        return;
      }
      candidates.push({ value, reason, score, color: element ? getComputedStyle(element).color : null });
    };
    for (const element of root.querySelectorAll("a, h1, h2, h3, [class*='machine'], [class*='model'], [class*='title']")) {
      if (!isVisible(element)) continue;
      const style = getComputedStyle(element);
      const blue = isBlueColor(style.color);
      const rect = element.getBoundingClientRect();
      const viewport = elementViewportScore(element);
      const freeMarker = hasNearbyFreeMarker(element);
      const mdcMatches = anchorParamMatches(element, "mdc", urlInfo.params.mdc);
      if (blue && freeMarker) add(element.textContent, mdcMatches ? "free_label_blue_machine_link+url_mdc" : "free_label_blue_machine_link", 1600 + viewport + (mdcMatches ? 1800 : 0), element);
      else if (blue) add(element.textContent, mdcMatches ? "blue_machine_name+url_mdc" : "blue_machine_name", 900 + viewport + (mdcMatches ? 1800 : 0), element);
      else if (/machine|model/i.test(`${element.className} ${element.id}`)) add(element.textContent, "machine_named_element", 850, element);
    }
    const titleParts = document.title.split(/[|｜\-–—]/).map(clean);
    for (const part of titleParts) add(part, "page_title", 700);
    add(state.settings?.manualMachineName, "manual_override", 300);
    return { ...selectCandidate(candidates), ignoredCandidates: dedupeValueReason(ignoredCandidates) };
  }

  function hasNearbyFreeMarker(element) {
    const parent = element.parentElement;
    if (!parent) return false;
    const text = clean(parent.textContent);
    return /(?:^|\s)FREE(?:\s|$)/i.test(text) || Boolean(parent.querySelector("img[alt*='FREE' i], img[src*='free' i], [class*='free' i]"));
  }

  function sanitizeMachineName(value) {
    return clean(normalizeAsciiWidth(value)).replace(/^FREE\s*/i, "").replace(/^機種(?:名)?\s*[:：]?\s*/, "");
  }

  function isPlausibleMachineName(value, storeName = "") {
    return Boolean(value && value !== "unknown" && value.length >= 4 && value.length <= 120 &&
      !FORBIDDEN_MACHINE_NAMES.has(value) &&
      !sameIdentityText(value, storeName) &&
      !/(?:戻る|トップへ|前の台|次の台|一覧へ)$|^(?:<<|＜＜|戻る|ホーム)/i.test(value) &&
      !/^(?:Site.?7|サイトセブン|出玉情報|出玉推移|大当り履歴|大当たり履歴|出玉詳細|連日データ|データ|機種情報|HYPER ARROW)/i.test(value) &&
      !/^\d{1,2}[\/.-]\d{1,2}$/.test(value));
  }

  function sameIdentityText(left, right) {
    if (!left || !right || right === "unknown") return false;
    const normalize = (value) => clean(normalizeAsciiWidth(value)).replace(/\s+/g, "").toLowerCase();
    return normalize(left) === normalize(right);
  }

  function detectDaiDetails(root = document, urlInfo = parseSite7Url(location.href)) {
    const candidates = [];
    const ignoredCandidates = [];
    const add = (rawValue, reason, score, extra = {}) => {
      const value = extractDai(rawValue, reason === "orange_header" || reason === "explicit_dai_text");
      if (!value) return;
      candidates.push({ value: String(Number(value)), rawValue: clean(rawValue), reason, score, ...extra });
    };

    for (const element of root.querySelectorAll("div,span,p,td,th,strong,b,h1,h2,h3")) {
      if (!isVisible(element)) continue;
      const text = clean(element.textContent);
      if (text.length > 80 || !/^0*\d{1,6}\s*番台(?:\s*[/／]|$)/.test(text)) continue;
      if (isIgnoredDaiElement(element)) {
        ignoredCandidates.push({ rawValue: text, reason: "linked_or_navigation_dai", ignoredReason: "not_current_page_identity" });
        continue;
      }
      const style = getComputedStyle(element);
      const reason = isOrangeColor(style.backgroundColor) ? "orange_header" : "explicit_dai_text";
      const viewportRatio = horizontalVisibleRatio(element.getBoundingClientRect());
      add(text, reason, (reason === "orange_header" ? 1400 : 500) + elementViewportScore(element), { backgroundColor: style.backgroundColor, viewportRatio, activeViewport: viewportRatio >= 0.6 });
    }

    for (const select of root.querySelectorAll("select")) {
      if (!isVisible(select)) continue;
      const selectedText = clean(select.selectedOptions?.[0]?.textContent || select.value);
      const hint = `${select.name} ${select.id} ${select.getAttribute("aria-label") || ""} ${select.parentElement?.textContent || ""}`;
      if (/台|dai|unit|machine.?no/i.test(hint) || /^0*\d{1,6}$/.test(selectedText)) {
        const viewportRatio = horizontalVisibleRatio(select.getBoundingClientRect());
        add(selectedText, "selected_dai_select", 1200 + elementViewportScore(select), { viewportRatio, activeViewport: viewportRatio >= 0.6 });
      }
    }

    if (urlInfo.daiCandidate) add(urlInfo.daiCandidate, "url_dn", 1000, { activeViewport: true });

    for (const anchor of root.querySelectorAll("a[href]")) {
      const text = clean(anchor.textContent);
      let linkedDai = "";
      try { linkedDai = new URL(anchor.href, location.href).searchParams.get("dn") || extractDai(text, true); } catch (_) { linkedDai = extractDai(text, true); }
      if (linkedDai) ignoredCandidates.push({ value: String(Number(linkedDai)), rawValue: text, reason: "link_target", ignoredReason: "link_is_not_current_page" });
    }
    add(state.settings?.manualDai, "manual_override", 300);

    const activeOrange = candidates.filter((candidate) => candidate.reason === "orange_header" && candidate.activeViewport).sort((a, b) => b.score - a.score);
    const activeSelect = candidates.filter((candidate) => candidate.reason === "selected_dai_select" && candidate.activeViewport).sort((a, b) => b.score - a.score);
    const matchingOrange = candidates.find((candidate) => candidate.reason === "orange_header" && candidate.value === urlInfo.daiCandidate);
    const chosen = matchingOrange || chooseDaiCandidate(candidates, urlInfo.daiCandidate);
    const selected = { selected: chosen?.value || "", reason: chosen?.reason || "not_detected", candidates: [...candidates].sort((a, b) => b.score - a.score) };
    const selectedValue = selected.selected;
    const agreeingReasons = [];
    if (activeOrange.some((candidate) => candidate.value === selectedValue)) agreeingReasons.push("orange_header");
    if (activeSelect.some((candidate) => candidate.value === selectedValue)) agreeingReasons.push("select");
    if (candidates.some((candidate) => candidate.value === selectedValue && candidate.reason === "url_dn")) agreeingReasons.push("url_dn");
    const reason = agreeingReasons.length ? agreeingReasons.join("+") : selected.reason;
    const confidence = matchingOrange ? "A" : agreeingReasons.length >= 2 ? "A" : agreeingReasons.length === 1 ? "B" : selectedValue ? "C" : "D";
    return { ...selected, reason, confidence, ignoredCandidates: dedupeValueReason(ignoredCandidates), singleUnitPage: Boolean(agreeingReasons.length || candidates.some((candidate) => candidate.reason === "selected_dai_select")) };
  }

  function chooseDaiCandidate(candidates, urlDaiCandidate) {
    const activeOrange = candidates.filter((candidate) => candidate.reason === "orange_header" && candidate.activeViewport).sort((a, b) => b.score - a.score);
    const activeSelect = candidates.filter((candidate) => candidate.reason === "selected_dai_select" && candidate.activeViewport).sort((a, b) => b.score - a.score);
    const matching = (items) => items.find((candidate) => candidate.value === urlDaiCandidate);
    return matching(activeOrange) || activeOrange[0] || matching(activeSelect) || activeSelect[0] ||
      candidates.find((candidate) => candidate.reason === "url_dn") ||
      [...candidates].sort((a, b) => b.score - a.score)[0] || null;
  }

  function isIgnoredDaiElement(element) {
    if (element.closest("a,nav,[role='navigation']")) return true;
    const context = clean(element.parentElement?.textContent).slice(0, 150);
    return /BACK|NEXT|前の台|次の台|閲覧履歴/i.test(context) && !isOrangeColor(getComputedStyle(element).backgroundColor);
  }

  function extractDai(value, allowSuffix = true) {
    if (!value) return "";
    const text = clean(value);
    const patterns = allowSuffix ? [
      /(?:^|\D)(0*\d{1,6})\s*番台(?:\D|$)/,
      /(?:台番号|台番|台\s*No\.?)[\s:：#]*(0*\d{1,6})/i,
      /^0*\d{1,6}$/
    ] : [/^0*\d{1,6}$/];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1] || match[0];
    }
    return "";
  }

  function normalizeDai(value) {
    if (!value || value === "unknown") return "unknown";
    const digits = String(value).match(/\d+/)?.[0];
    if (!digits) return "unknown";
    return String(Number(digits));
  }

  function detectBusinessDate(manualDate, root = document) {
    return detectBusinessDateDetails(manualDate, root, parseSite7Url(location.href));
  }

  function detectBusinessDateDetails(manualDate, root = document, urlInfo = parseSite7Url(location.href)) {
    const tabCandidates = collectDateTabCandidates(root);
    const explicit = tabCandidates.filter((candidate) => candidate.explicitSelected).sort((a, b) => b.score - a.score)[0];
    const styled = tabCandidates.filter((candidate) => candidate.styleSelected).sort((a, b) => b.score - a.score)[0];
    const selectedTab = explicit || styled;
    const candidates = [...tabCandidates];
    if (urlInfo.dateCandidate) candidates.push({ label: urlInfo.dateCandidate, businessDate: urlInfo.dateCandidate, reason: "url_dtdd", dtdd: urlInfo.params.dtdd });
    if (selectedTab) {
      const result = dateResult(selectedTab.label, "A");
      const matchesUrl = urlInfo.dateCandidate && result.businessDate === urlInfo.dateCandidate;
      return { ...result, confidence: matchesUrl ? "A" : (urlInfo.dateCandidate ? "B" : "A"), reason: matchesUrl ? "selected_date_tab+url_dtdd" : (urlInfo.dateCandidate ? "selected_date_tab_url_conflict" : "selected_date_tab"), candidates };
    }

    if (urlInfo.dateCandidate) {
      return { businessDate: urlInfo.dateCandidate, dateLabel: `dtdd=${urlInfo.params.dtdd}`, confidence: "B", reason: "url_dtdd", candidates };
    }

    const params = new URL(location.href).searchParams;
    for (const key of ["date", "targetDate", "businessDate", "ymd", "day"]) {
      if (params.get(key) && hasDateLabel(params.get(key))) {
        const result = dateResult(params.get(key), "A");
        return { ...result, reason: `url_parameter:${key}`, candidates };
      }
    }

    const graphLabel = [...root.querySelectorAll("h1,h2,h3,h4,caption,[class*='date'],[class*='graph']")]
      .filter(isVisible).map((element) => clean(element.textContent)).find((text) => isExactShortDate(text));
    if (graphLabel) return { ...dateResult(graphLabel, "B"), reason: "graph_label", candidates };
    if (manualDate) return { ...dateResult(manualDate, "C"), reason: "manual_override", candidates };
    return { businessDate: "unknown", dateLabel: "", confidence: "D", reason: "not_detected", candidates };
  }

  function collectDateTabCandidates(root) {
    const elements = [...root.querySelectorAll("a,button,li,td,th,div,span,option,[role='tab']")]
      .filter((element) => {
        if (!isVisible(element) || !isExactShortDate(clean(element.textContent)) || element.children.length > 1) return false;
        const rect = element.getBoundingClientRect();
        return horizontalVisibleRatio(rect) >= 0.6 && rect.bottom > 0 && rect.top <= Math.min(280, window.innerHeight * 0.4);
      });
    const raw = elements.map((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const className = String(element.className || "");
      const explicitSelected = element.getAttribute("aria-selected") === "true" || element.getAttribute("aria-current") === "date" ||
        element.matches(":checked") || /(?:^|[\s_-])(active|selected|current|on)(?:$|[\s_-])/i.test(className);
      return {
        element, label: clean(element.textContent), className, backgroundColor: style.backgroundColor,
        luminance: colorLuminance(style.backgroundColor), rect: rectObject(rect), explicitSelected,
        score: explicitSelected ? 1000 : 0, styleSelected: false
      };
    });

    for (const candidate of raw) {
      const peers = raw.filter((other) => other !== candidate && Math.abs(other.rect.top - candidate.rect.top) < 12 && Math.abs(other.rect.height - candidate.rect.height) < 12);
      if (peers.length < 2 || candidate.luminance === null) continue;
      const peerLuminances = peers.map((peer) => peer.luminance).filter((value) => value !== null);
      if (peerLuminances.length < 2) continue;
      const median = peerLuminances.sort((a, b) => a - b)[Math.floor(peerLuminances.length / 2)];
      const contrast = median - candidate.luminance;
      if (contrast > 8) {
        candidate.styleSelected = true;
        candidate.score = Math.max(candidate.score, 700 + contrast);
      }
    }
    return dedupeDebugCandidates(raw.map(({ element, ...candidate }) => candidate));
  }

  function isExactShortDate(value) {
    return /^\d{1,2}[\/.-]\d{1,2}$/.test(clean(value));
  }

  function hasDateLabel(value) {
    return /(?:20\d{2}[\/.\-年]\s*\d{1,2}[\/.\-月]\s*\d{1,2}|\b\d{1,2}[\/.\-]\d{1,2}\b)/.test(String(value || ""));
  }

  function dateResult(label, confidence) {
    const raw = String(label || "");
    const full = raw.match(/(20\d{2})[\/.\-年]\s*(\d{1,2})[\/.\-月]\s*(\d{1,2})/);
    if (full) return { businessDate: isoDate(+full[1], +full[2], +full[3]), dateLabel: full[0], confidence };
    const short = raw.match(/(?:^|\D)(\d{1,2})[\/.\-月](\d{1,2})(?:日|\D|$)/);
    if (!short) return { businessDate: "unknown", dateLabel: raw, confidence: "D" };
    const now = new Date();
    let year = now.getFullYear();
    const month = +short[1];
    const day = +short[2];
    if (month - (now.getMonth() + 1) > 6) year -= 1;
    return { businessDate: isoDate(year, month, day), dateLabel: short[0].trim(), confidence };
  }

  function isoDate(year, month, day) {
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return "unknown";
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function selectCandidate(candidates) {
    const byValue = new Map();
    for (const candidate of candidates) {
      const key = candidate.value;
      if (!key || (byValue.get(key)?.score || -1) >= candidate.score) continue;
      byValue.set(key, candidate);
    }
    const unique = [...byValue.values()].sort((a, b) => b.score - a.score);
    return { selected: unique[0]?.value || "", reason: unique[0]?.reason || "not_detected", candidates: unique };
  }

  function dedupeDebugCandidates(candidates) {
    const seen = new Set();
    return candidates.filter((candidate) => {
      const key = `${candidate.label || candidate.value}|${candidate.rect?.left}|${candidate.rect?.top}|${candidate.reason || ""}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }

  function dedupeValueReason(candidates) {
    const seen = new Set();
    return candidates.filter((candidate) => {
      const key = `${candidate.value || candidate.rawValue}|${candidate.reason}|${candidate.ignoredReason || ""}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 50);
  }

  function markDarkestSelected(candidates, minimumContrast) {
    for (const candidate of candidates) {
      const peers = candidates.filter((other) => other !== candidate && Math.abs(other.rect.top - candidate.rect.top) < 12 && Math.abs(other.rect.height - candidate.rect.height) < 12);
      if (peers.length < 2 || candidate.luminance === null) continue;
      const values = peers.map((peer) => peer.luminance).filter((value) => value !== null).sort((a, b) => a - b);
      if (values.length < 2) continue;
      const median = values[Math.floor(values.length / 2)];
      const contrast = median - candidate.luminance;
      if (contrast > minimumContrast) {
        candidate.styleSelected = true;
        candidate.score = Math.max(candidate.score, 700 + contrast);
      }
    }
    return candidates;
  }

  async function captureAndSave(silent) {
    const freshInspection = inspectPage();
    if (!state.currentContext) lockCurrentContext(freshInspection, false);
    else if (state.currentContext.machineName === "unknown" && freshInspection.machineName !== "unknown") {
      state.currentContext.machineName = freshInspection.machineName;
      state.currentContextDebug = { ...(state.currentContextDebug || {}), selectedMachineReason: freshInspection.selectedMachineReason, detectedMachineCandidates: freshInspection.detectedMachineCandidates };
    }
    state.inspection = applyCurrentContext(freshInspection);
    renderStatusBar(state.inspection);
    const records = (await buildRecords(state.inspection)).filter(hasCapturedPart);
    if (!records.length) {
      if (!silent) showToast("⚠ 保存を見送りました\n現在スライドに取得可能なデータがありません", "warn");
      return { ok: true, skipped: true, records: [], results: [] };
    }
    state.lastSavePayload = structuredClone(records);
    const results = [];
    for (const record of records) results.push(await send({ type: "SAVE_CAPTURE", record }));
    state.saveCount += results.filter((result) => result.status !== "unchanged").length;
    await inspectAndRender();
    const pending = results.filter((result) => result.status?.startsWith("pending")).length;
    if (!silent) {
      const label = `${records[0]?.dai || "台不明"} / ${records[0]?.businessDate || "日付不明"}`;
      showToast(pending ? `⚠ 一部保存\n${label}\n${pending}件をpending保存` : `✅ 保存完了\n${label}\n${summarizeParts(records)}`, pending ? "warn" : "success");
      notifySound(pending ? "warning" : "success");
    }
    return { ok: true, records, results };
  }

  function hasCapturedPart(record) {
    return ["summary", "history", "graph"].some((name) => record.parts?.[name]?.status === "captured");
  }

  async function buildRecords(inspection = state.inspection || applyCurrentContext(inspectPage())) {
    const now = new Date().toISOString();
    const currentScope = resolveCurrentUnitScope(inspection.dai) || document;
    const graphCandidates = inspection.screenType === "graph" ? collectGraphCandidates(document) : [];
    const selectedGraph = selectPrimaryGraph(graphCandidates, inspection);
    const summary = ["detail", "summary"].includes(inspection.screenType) ? captureSummary(currentScope, now) : emptyPart("summary");
    const history = inspection.screenType === "history" ? captureHistory(currentScope, now) : emptyPart("history");
    const graph = inspection.screenType === "graph" && selectedGraph
      ? await captureGraphFromVisibleTab(selectedGraph, now, graphCandidates)
      : emptyGraph(graphCandidates);
    return [makeRecord(inspection, now, summary, history, graph)];
  }

  async function captureGraphFromVisibleTab(selectedGraph, capturedAt, graphCandidates) {
    let rect = resolveGraphCaptureRect(selectedGraph, graphCandidates);
    try {
      if (rect.top < 0 || rect.left < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight) {
        selectedGraph.element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
        await new Promise((resolve) => setTimeout(resolve, 250));
        rect = resolveGraphCaptureRect(selectedGraph, graphCandidates);
      }
      if (rect.top < 0 || rect.left < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight) {
        throw new Error("Primary graph is larger than the visible viewport");
      }
      const response = await send({
        type: "CAPTURE_VISIBLE_GRAPH",
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        captureRectStrategy: rect.strategy,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        manualOverride: state.settings?.manualDiffBalls
      });
      if (!response?.ok || !response.graph) throw new Error(response?.error || "Visible-tab graph capture failed");
      let graph = response.graph;
      const usable = (value) => value.diffBallsRaw !== null || value.diffBallsManualOverride !== null;
      if (!usable(graph)) {
        // The screenshot crop found no graph line at the selected slide (the line
        // can sit on a transparent layer that does not composite as expected).
        // Read the element's own bitmap, which captured the line before.
        const domFallback = captureGraph(selectedGraph.element, capturedAt, graphCandidates);
        if (usable(domFallback)) {
          graph = {
            ...domFallback,
            graphCaptureMethod: "dom_rasterize_after_screenshot_blank",
            screenshotDiffStatus: response.graph.diffBallsStatus,
            graphAnalysisError: `Screenshot crop had no graph line (${response.graph.diffBallsStatus}); used DOM rasterization`
          };
        }
      }
      return {
        ...graph,
        capturedAt,
        graphCandidateCount: graphCandidates.length,
        graphCandidateRects: graphCandidates.map((candidate) => candidate.debug.rect)
      };
    } catch (error) {
      const fallback = captureGraph(selectedGraph.element, capturedAt, graphCandidates);
      return {
        ...fallback,
        graphCaptureMethod: "dom_direct_fallback",
        screenshotCaptureError: error.message,
        graphAnalysisError: `Screenshot capture failed: ${error.message}; DOM fallback: ${fallback.graphAnalysisError || "unknown error"}`
      };
    }
  }

  function resolveGraphCaptureRect(selectedGraph, graphCandidates) {
    const selected = selectedGraph.element.getBoundingClientRect();
    const related = graphCandidates.map((candidate) => candidate.element.getBoundingClientRect()).filter((rect) => {
      if (rect.width > 700 || rect.height > 600) return false;
      const overlapWidth = Math.max(0, Math.min(selected.right, rect.right) - Math.max(selected.left, rect.left));
      const overlapHeight = Math.max(0, Math.min(selected.bottom, rect.bottom) - Math.max(selected.top, rect.top));
      return overlapWidth >= Math.min(selected.width, rect.width) * 0.5 &&
        overlapHeight >= Math.min(selected.height, rect.height) * 0.5;
    });
    if (!related.length) related.push(selected);
    let ancestor = selectedGraph.element.parentElement;
    for (let depth = 0; ancestor && ancestor !== document.body && depth < 7; depth++, ancestor = ancestor.parentElement) {
      const rect = ancestor.getBoundingClientRect();
      const ratio = rect.width / Math.max(1, rect.height);
      const containsSelected = rect.left <= selected.left + 2 && rect.top <= selected.top + 2 &&
        rect.right >= selected.right - 2 && rect.bottom >= selected.bottom - 2;
      // Site7's plotted line can be a small transparent layer. Its nearest
      // chart panel is roughly square and includes the +30k/0/-30k grid.
      if (containsSelected && rect.width >= 240 && rect.width <= 480 &&
          rect.height >= 180 && rect.height <= 340 && ratio >= 0.75 && ratio <= 2.2) {
        related.push(rect);
        break;
      }
    }
    const padding = 3;
    const left = Math.min(...related.map((rect) => rect.left)) - padding;
    const top = Math.min(...related.map((rect) => rect.top)) - padding;
    const right = Math.max(...related.map((rect) => rect.right)) + padding;
    const bottom = Math.max(...related.map((rect) => rect.bottom)) + padding;
    return { left, top, right, bottom, width: right - left, height: bottom - top,
      strategy: related.length > 1 ? "overlapping_layers_and_chart_ancestor" : "selected_graph_only" };
  }

  function makeRecord(meta, capturedAt, summary, history, graph) {
    const unknowns = ["storeName", "machineName", "daiNormalized", "businessDate"].filter((key) => !meta[key] || meta[key] === "unknown");
    const invalidMachineCandidate = meta.ignoredMachineCandidates?.some((candidate) => candidate.ignoredReason === "page_or_tab_label");
    const notes = unknowns.length ? [`未検出: ${unknowns.join(", ")}`] : [];
    if (invalidMachineCandidate && meta.machineName === "unknown") notes.push("machineName appears to be page/tab label");
    return {
      source: "site7",
      storeName: meta.storeName || "unknown",
      machineName: meta.machineName || "unknown",
      dai: meta.dai || "unknown",
      daiNormalized: meta.daiNormalized || "unknown",
      businessDate: meta.businessDate || "unknown",
      dateLabel: meta.dateLabel || "",
      dateConfidence: meta.dateConfidence || "D",
      daiConfidence: meta.daiConfidence || "D",
      captureDateTime: capturedAt,
      pageType: meta.pageType,
      screenType: meta.screenType,
      screenTypeConfidence: meta.screenTypeConfidence,
      site7Pmc: meta.site7Pmc || "",
      site7Mdc: meta.site7Mdc || "",
      urlDtdd: meta.urlDtdd || "",
      urlDaiCandidate: meta.urlDaiCandidate || "",
      urlScreenTypeCandidate: meta.urlScreenTypeCandidate || "unknown",
      urlDateCandidate: meta.urlDateCandidate || "",
      sourceUrl: location.href,
      identityConflict: false,
      parts: { summary, history, graph, calculation: { status: "not_calculated", rotationRate: null, expectedValue: null, expectedHourly: null } },
      mergeStatus: unknowns.length ? "pending" : "partial",
      notes
    };
  }

  function captureSummary(root, capturedAt) {
    const values = {};
    for (const [key, labels] of Object.entries(LABELS)) {
      const raw = findMetricValue(labels, root);
      values[key] = key === "updateTime" || key.includes("Probability") ? (raw || null) : parseNumber(raw);
    }
    const strongKeys = ["jackpot", "initialHits", "totalStarts", "normalStarts", "chanceStarts", "highestPayout"];
    if (!strongKeys.some((key) => values[key] !== null)) return emptyPart("summary");
    return { status: "captured", capturedAt, ...values };
  }

  function captureHistory(root, capturedAt) {
    const table = findHistoryTable(root);
    if (!table) return emptyPart("history");
    const rows = historyRows(table);
    if (!rows.length) return emptyPart("history");
    const headerRowIndex = rows.findIndex((row) => hasHistoryHeaders(rowCells(row).map((cell) => clean(cell.textContent))));
    if (headerRowIndex < 0) return emptyPart("history");
    const headerCells = rowCells(rows[headerRowIndex]).map((cell) => clean(cell.textContent));
    const indexes = {
      no: findHeader(headerCells, ["回数", "No", "番号"]),
      time: findHeader(headerCells, ["時刻", "時間"]),
      start: findHeader(headerCells, ["スタート", "回転"]),
      payout: findHeader(headerCells, ["獲得数", "出玉", "払出"])
    };
    const dataRows = [];
    for (const row of rows.slice(headerRowIndex + 1)) {
      const cells = rowCells(row);
      if (cells.length !== headerCells.length || cells.length < 4) continue;
      const get = (index) => index >= 0 && cells[index] ? clean(cells[index].textContent) : "";
      const noRaw = get(indexes.no >= 0 ? indexes.no : 0);
      const no = parseHistoryCell(noRaw);
      if (no === null || no === "" || (typeof no !== "number" && no !== "-")) continue;
      const payoutRaw = get(indexes.payout >= 0 ? indexes.payout : cells.length - 1);
      const chanceHit = isChanceHistoryRow(row, cells);
      const rawCells = cells.map((cell) => clean(cell.textContent));
      dataRows.push({
        no,
        time: get(indexes.time >= 0 ? indexes.time : 1) || null,
        start: parseHistoryCell(get(indexes.start >= 0 ? indexes.start : 2)),
        payout: parseHistoryCell(payoutRaw),
        statusText: chanceHit ? "チャンス中大当り" : "通常",
        status: chanceHit ? "チャンス中大当り" : "通常",
        isChanceHit: chanceHit,
        rawCells
      });
    }
    if (!dataRows.length) return emptyPart("history");
    const deduped = dedupeRows(dataRows);
    return { status: "captured", capturedAt, rows: deduped, ...buildPayoutDebug(deduped) };
  }

  function buildPayoutDebug(rows) {
    const payoutIncludedRows = rows.filter((row) => Number.isInteger(row.no) && row.no >= 1 && typeof row.payout === "number" && Number.isFinite(row.payout))
      .map((row) => ({ no: row.no, payout: row.payout }));
    const payoutExcludedRows = rows.filter((row) => !payoutIncludedRows.some((included) => included.no === row.no))
      .map((row) => ({ no: row.no, payout: row.payout, reason: !Number.isInteger(row.no) ? "non_jackpot_row" : "non_numeric_payout" }));
    return { payoutTotal: payoutIncludedRows.reduce((sum, row) => sum + row.payout, 0), payoutIncludedRows, payoutExcludedRows };
  }

  function findHistoryTable(root) {
    const candidates = [];
    for (const table of root.querySelectorAll("table, [role='table']")) {
      const rows = historyRows(table);
      if (!rows.some((row) => hasHistoryHeaders(rowCells(row).map((cell) => clean(cell.textContent))))) continue;
      const rect = table.getBoundingClientRect();
      candidates.push({ table, viewportRatio: horizontalVisibleRatio(rect), score: elementViewportScore(table), rowCount: rows.length });
    }
    return candidates.sort((a, b) => (b.viewportRatio >= 0.6 ? 10000 : 0) + b.score - ((a.viewportRatio >= 0.6 ? 10000 : 0) + a.score))[0]?.table || null;
  }

  function historyRows(table) {
    const rows = [...table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr, [role='row']")];
    return rows.length ? [...new Set(rows)] : [...table.querySelectorAll("tr, [role='row']")];
  }

  function rowCells(row) {
    const direct = [...row.querySelectorAll(":scope > th, :scope > td, :scope > [role='columnheader'], :scope > [role='cell']")];
    return direct.length ? direct : [...row.querySelectorAll("th,td,[role='columnheader'],[role='cell']")];
  }

  function hasHistoryHeaders(headers) {
    return findHeader(headers, ["回数", "No", "番号"]) >= 0 &&
      findHeader(headers, ["時刻", "時間"]) >= 0 &&
      findHeader(headers, ["スタート", "回転"]) >= 0 &&
      findHeader(headers, ["獲得数", "出玉", "払出"]) >= 0;
  }

  function parseHistoryCell(value) {
    const text = clean(value);
    if (!text) return null;
    if (/^(?:-|--|―|－|−|↑)$/.test(text)) return text;
    return /^-?\d[\d,]*(?:\.\d+)?$/.test(text) ? Number(text.replace(/,/g, "")) : text;
  }

  function isChanceHistoryRow(row, cells) {
    const hints = `${row.className || ""} ${row.getAttribute("style") || ""}`;
    if (/chance|red|赤|atari/i.test(hints)) return true;
    return [row, ...cells].some((element) => isRedColor(getComputedStyle(element).color));
  }

  function dedupeRows(rows) {
    const map = new Map();
    for (const row of rows) map.set(String(row.no), row);
    const rank = (row) => row.no === "-" ? Number.POSITIVE_INFINITY : Number(row.no) || -1;
    return [...map.values()].sort((a, b) => rank(b) - rank(a));
  }

  function findHeader(headers, labels) {
    return headers.findIndex((header) => labels.some((label) => header.toLowerCase().includes(label.toLowerCase())));
  }

  function findGraphElements(root) {
    return collectGraphCandidates(root).map((candidate) => candidate.element);
  }

  function collectGraphCandidates(root) {
    const candidates = [];
    for (const element of root.querySelectorAll("canvas, img, svg")) {
      if (!isVisible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 140 || rect.height < 70) continue;
      const nearbyText = graphNearbyText(element);
      const hint = `${element.id} ${element.className?.baseVal || element.className || ""} ${element.alt || ""} ${nearbyText}`;
      const graphHint = /グラフ|差玉|出玉推移|graph|chart|slump|30,000|-30,000/i.test(hint);
      const graphShape = rect.width >= 180 && rect.height >= 100 && rect.width / rect.height < 5;
      if (!graphHint && !graphShape) continue;
      const debug = {
        index: candidates.length,
        tagName: element.tagName,
        id: element.id || "",
        className: String(element.className?.baseVal || element.className || ""),
        src: element instanceof HTMLImageElement ? (element.currentSrc || element.src || "") : "",
        rect: rectObject(rect),
        naturalWidth: element instanceof HTMLImageElement ? element.naturalWidth : (element.width?.baseVal?.value || element.width || null),
        naturalHeight: element instanceof HTMLImageElement ? element.naturalHeight : (element.height?.baseVal?.value || element.height || null),
        nearbyText: nearbyText.slice(0, 300),
        localDateLabels: nearbyDateLabels(element),
        graphHint
      };
      const score = (graphHint ? 500 : 0) + Math.min(300, rect.width * rect.height / 1000);
      candidates.push({ element, debug, score });
    }
    return candidates.filter((candidate, index, all) => !all.some((other, otherIndex) => otherIndex < index && other.element.contains(candidate.element)));
  }

  function graphNearbyText(element) {
    const chunks = [];
    let current = element.parentElement;
    for (let depth = 0; current && current !== document.body && depth < 4; depth++, current = current.parentElement) {
      const text = clean(current.textContent);
      if (text && text.length < 1800) chunks.push(text);
    }
    for (const sibling of [element.previousElementSibling, element.nextElementSibling]) {
      if (sibling) chunks.push(clean(sibling.textContent));
    }
    return chunks.join(" | ");
  }

  function selectPrimaryGraph(candidates, inspection) {
    if (!candidates.length || inspection.screenType !== "graph" || !/\/D2600\.do$/i.test(inspection.urlPath || "")) return null;
    const dateTokens = [inspection.dateLabel, inspection.businessDate?.slice(5).replace("-", "/")].filter(Boolean);
    const eligible = candidates.filter((candidate) => {
      const rect = candidate.element.getBoundingClientRect();
      const ratio = rect.width / Math.max(rect.height, 1);
      return rect.width >= 180 && rect.height >= 90 && ratio >= 0.6 && ratio <= 5;
    });
    // Site7 keeps prev/next stages in a horizontal carousel, so identical graph
    // elements exist off-screen at negative/oversized X, and the current stage is
    // the slide centered in the viewport. Only an on-screen slide can be
    // screenshotted, so restrict to visible candidates and pick the one nearest
    // the viewport center (the active slide) rather than the largest layer, since
    // a big grid-only container would otherwise outscore the line-bearing slide.
    const vw = window.innerWidth, vh = window.innerHeight;
    const viewportCenter = vw / 2;
    const onScreen = eligible.filter((candidate) => {
      const rect = candidate.element.getBoundingClientRect();
      return rect.right > 0 && rect.left < vw && rect.bottom > 0 && rect.top < vh;
    });
    const visiblePool = onScreen.length ? onScreen : eligible;
    const hinted = visiblePool.filter((candidate) => candidate.debug.graphHint);
    const pool = hinted.length ? hinted : visiblePool;
    return pool.map((candidate) => {
      const rect = candidate.element.getBoundingClientRect();
      const center = (rect.left + rect.right) / 2;
      const fullyVisible = rect.left >= 0 && rect.right <= vw && rect.top >= 0 && rect.bottom <= vh;
      const partlyVisible = rect.right > 0 && rect.left < vw && rect.bottom > 0 && rect.top < vh;
      let selectionScore = fullyVisible ? 1000000 : (partlyVisible ? 300000 : 0);
      selectionScore += Math.max(0, 400000 - Math.abs(center - viewportCenter) * 1000);
      selectionScore += Math.min(20000, candidate.debug.rect.width * candidate.debug.rect.height / 10);
      if (candidate.debug.graphHint) selectionScore += 50000;
      if (dateTokens.some((token) => token && candidate.debug.localDateLabels.includes(token))) selectionScore += 20000;
      else if (dateTokens.some((token) => token && candidate.debug.nearbyText.includes(token))) selectionScore += 5000;
      return { candidate, selectionScore };
    }).sort((a, b) => b.selectionScore - a.selectionScore)[0]?.candidate || null;
  }

  function nearestDataScope(element) {
    let current = element.parentElement;
    while (current && current !== document.body) {
      const text = clean(current.textContent);
      if (text.length < 2500 && (hasDateLabel(text) || /台番号|台番|台\s*No/i.test(text))) return current;
      current = current.parentElement;
    }
    return document;
  }

  function captureGraph(element, capturedAt, allCandidates = []) {
    const manualOverride = parseSignedNumber(state.settings?.manualDiffBalls);
    const selectedRect = rectObject(element.getBoundingClientRect());
    const base = {
      status: "captured", capturedAt, graphImage: graphImageSource(element),
      diffBallsRaw: null, diffBallsFinal: manualOverride, diffBallsManualOverride: manualOverride,
      diffBallsStatus: "not_analyzed", diffBallsMethod: null, diffBallsConfidence: null,
      graphZeroY: null, graphUpperLineY: null, graphLowerLineY: null,
      graphUpperValue: null, graphLowerValue: null, graphEndY: null, graphScaleBallsPerPixel: null,
      graphCandidateCount: allCandidates.length,
      graphCandidateRects: allCandidates.map((candidate) => candidate.debug.rect),
      selectedGraphRect: selectedRect,
      axisTextCandidates: [], lineColorCandidates: [], horizontalGridLines: [],
      graphImageWidth: null, graphImageHeight: null, graphAnalysisError: null,
      axisAssumption: null, axisConfidence: null
    };
    try {
      const canvas = rasterize(element);
      if (!canvas) return applyManualGraphStatus({ ...base, diffBallsStatus: "graph_not_detected", graphAnalysisError: "Selected SVG/image could not be rasterized" });
      base.graphImageWidth = canvas.width;
      base.graphImageHeight = canvas.height;
      try { base.graphImage = canvas.toDataURL("image/png"); } catch (_) { /* Keep original image URL. */ }
      const pixelAnalysis = analyzeGraphPixels(canvas);
      base.lineColorCandidates = pixelAnalysis.lineColorCandidates;
      base.horizontalGridLines = pixelAnalysis.horizontalGridLines;
      base.graphEndpointMethod = pixelAnalysis.endpointMethod;
      base.site7LinePixelCount = pixelAnalysis.site7LinePixelCount;
      const axisDetection = detectAxis(element, canvas);
      base.axisTextCandidates = axisDetection.candidates;
      const gridAxis = axisDetection.axis ? null : axisFromGridLines(pixelAnalysis.horizontalGridLines, canvas.height);
      const axisSource = axisDetection.axis ? "dom_axis_labels" : (gridAxis ? "gridline_spacing" : "estimated_plot_bounds");
      const estimatedAxis = axisSource === "estimated_plot_bounds";
      const axis = axisDetection.axis || gridAxis || {
        graphUpperValue: 30000,
        graphLowerValue: -30000,
        graphUpperLineY: Math.max(1, Math.round(canvas.height * 0.08)),
        graphLowerLineY: Math.min(canvas.height - 2, Math.round(canvas.height * 0.92)),
        graphZeroY: canvas.height / 2
      };
      const end = pixelAnalysis.end;
      if (!end) return applyManualGraphStatus({ ...base, ...axis, diffBallsStatus: "graph_not_detected", graphAnalysisError: "Colored graph line endpoint was not detected" });
      const scale = (axis.graphUpperValue - axis.graphLowerValue) / Math.abs(axis.graphUpperLineY - axis.graphLowerLineY);
      const raw = axis.graphUpperValue - ((end.y - axis.graphUpperLineY) * scale);
      const outside = end.y < Math.min(axis.graphUpperLineY, axis.graphLowerLineY) - 2 ? "over_axis_limit" :
        end.y > Math.max(axis.graphUpperLineY, axis.graphLowerLineY) + 2 ? "under_axis_limit" : "calculated";
      if (outside !== "calculated") return applyManualGraphStatus({ ...base, ...axis, graphEndY: end.y, diffBallsStatus: outside });
      const axisConfidence = axisSource === "dom_axis_labels" ? end.confidence : (axisSource === "gridline_spacing" ? "B" : "C");
      return applyManualGraphStatus({
        ...base, ...axis, graphEndY: end.y, graphScaleBallsPerPixel: scale,
        diffBallsRaw: raw, diffBallsCandidate: null,
        diffBallsFinal: manualOverride ?? raw,
        diffBallsStatus: estimatedAxis ? "calculated_estimated_axis" : "calculated",
        diffBallsMethod: `dom_pixel_${axisSource}`,
        diffBallsConfidence: axisConfidence,
        axisAssumption: axisSource === "dom_axis_labels" ? "dom_axis_labels"
          : (axisSource === "gridline_spacing" ? "site7_standard_+30000_-30000_gridline_spacing"
            : "site7_standard_+30000_-30000_plot_bounds_8_92_percent"),
        axisConfidence,
        graphAnalysisError: estimatedAxis ? "DOM axis labels and grid ladder unavailable; fixed Site7 axis with 8%-92% plot bounds was used" : null
      });
    } catch (error) {
      return applyManualGraphStatus({ ...base, diffBallsStatus: "graph_not_detected", graphAnalysisError: error.message });
    }
  }

  function applyManualGraphStatus(graph) {
    if (graph.diffBallsManualOverride === null) return graph;
    return { ...graph, diffBallsFinal: graph.diffBallsManualOverride, diffBallsStatus: "manual_override", diffBallsMethod: "manual", diffBallsConfidence: "A" };
  }

  function graphImageSource(element) {
    try {
      if (element instanceof HTMLCanvasElement) return element.toDataURL("image/png");
      if (element instanceof HTMLImageElement) return element.currentSrc || element.src || null;
      return null;
    } catch (_) { return null; }
  }

  function rasterize(element) {
    if (element instanceof HTMLCanvasElement) return element;
    if (element instanceof HTMLImageElement && element.complete && element.naturalWidth) {
      const canvas = document.createElement("canvas");
      canvas.width = element.naturalWidth;
      canvas.height = element.naturalHeight;
      canvas.getContext("2d", { willReadFrequently: true }).drawImage(element, 0, 0);
      canvas.getContext("2d").getImageData(0, 0, 1, 1);
      return canvas;
    }
    return null;
  }

  function detectAxis(element, canvas) {
    const graphRect = element.getBoundingClientRect();
    const scaleY = canvas.height / graphRect.height;
    const scope = nearestDataScope(element);
    const labels = [];
    for (const node of scope.querySelectorAll("span,div,p,li,td,th,text")) {
      if (node.children.length && !(node instanceof SVGTextElement)) continue;
      const text = clean(node.textContent);
      const match = text.match(/([+＋−-]?\s*\d{1,3}(?:,\d{3})+)\s*(?:玉)?/);
      if (!match || !isVisible(node)) continue;
      const value = Number(match[1].replace(/[＋,\s]/g, "").replace("−", "-"));
      if (!Number.isFinite(value) || Math.abs(value) < 1000) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom < graphRect.top - 20 || rect.top > graphRect.bottom + 20) continue;
      labels.push({ text, value, y: ((rect.top + rect.bottom) / 2 - graphRect.top) * scaleY, rect: rectObject(rect) });
    }
    const upper = labels.filter((item) => item.value > 0).sort((a, b) => b.value - a.value)[0];
    const lower = labels.filter((item) => item.value < 0).sort((a, b) => a.value - b.value)[0];
    if (!upper || !lower || Math.abs(upper.y - lower.y) < 10) return { axis: null, candidates: labels };
    const zeroY = upper.y + (upper.value / (upper.value - lower.value)) * (lower.y - upper.y);
    return { candidates: labels, axis: {
      graphUpperValue: upper.value, graphLowerValue: lower.value,
      graphUpperLineY: upper.y, graphLowerLineY: lower.y, graphZeroY: zeroY
    } };
  }

  // Site7 single-unit graphs draw horizontal grid lines every 10,000 balls.
  // When the axis text is missing from the rasterized scope we can still recover
  // a real scale from an evenly spaced grid ladder, with 0 at the line nearest
  // the plot center. Far better than the 8%-92% plot-bounds guess.
  function axisFromGridLines(gridLines, height) {
    if (!Array.isArray(gridLines) || gridLines.length < 3) return null;
    const ys = [...gridLines].sort((a, b) => a - b);
    const gaps = ys.slice(1).map((y, index) => y - ys[index]);
    const spacing = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    if (!spacing || spacing < 6) return null;
    if (!gaps.every((gap) => Math.abs(gap - spacing) <= Math.max(3, spacing * 0.25))) return null;
    const midpoint = (ys[0] + ys[ys.length - 1]) / 2;
    const zeroY = [...ys].sort((a, b) => Math.abs(a - midpoint) - Math.abs(b - midpoint))[0];
    const span = 30000 / (10000 / spacing);
    return {
      graphUpperValue: 30000, graphLowerValue: -30000,
      graphUpperLineY: zeroY - span, graphLowerLineY: zeroY + span, graphZeroY: zeroY
    };
  }

  function analyzeGraphPixels(canvas) {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const { width, height } = canvas;
    const pixels = context.getImageData(0, 0, width, height).data;
    const colorCounts = new Map();
    const colorfulMask = new Uint8Array(width * height);
    const site7Mask = new Uint8Array(width * height);
    let site7LinePixelCount = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = (y * width + x) * 4;
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const index = y * width + x;
        if (a > 100 && max - min > 28 && min < 245) {
          colorfulMask[index] = 1;
          const key = `${Math.round(r / 24) * 24},${Math.round(g / 24) * 24},${Math.round(b / 24) * 24}`;
          const bucket = colorCounts.get(key) || { count: 0, r: 0, g: 0, b: 0 };
          bucket.count++; bucket.r += r; bucket.g += g; bucket.b += b;
          colorCounts.set(key, bucket);
        }
        if (a > 150 && g > 95 && b > 115 && g - r > 28 && b - r > 38 && Math.abs(b - g) < 105) {
          site7Mask[index] = 1; site7LinePixelCount++;
        }
      }
    }
    // Pick the dominant chromatic color as the graph line so pink/blue/green
    // lines are all tracked, not only the Site7 standard cyan. Build a mask of
    // pixels close to that color to exclude watermarks, legends, and labels.
    const ranked = [...colorCounts.values()].sort((a, b) => b.count - a.count);
    const dominant = ranked[0] && ranked[0].count >= 8
      ? { r: ranked[0].r / ranked[0].count, g: ranked[0].g / ranked[0].count, b: ranked[0].b / ranked[0].count }
      : null;
    const lineMask = new Uint8Array(width * height);
    let linePixelCount = 0;
    if (dominant) {
      for (let index = 0; index < colorfulMask.length; index++) {
        if (!colorfulMask[index]) continue;
        const i = index * 4;
        if (Math.abs(pixels[i] - dominant.r) > 70 || Math.abs(pixels[i + 1] - dominant.g) > 70 || Math.abs(pixels[i + 2] - dominant.b) > 70) continue;
        lineMask[index] = 1; linePixelCount++;
      }
    }
    const endpointMethod = site7LinePixelCount >= 20 ? "site7_cyan_line"
      : (dominant && linePixelCount >= 12 ? "dominant_color_rightmost_column" : "generic_color_rightmost_column");
    const endpointMask = site7LinePixelCount >= 20 ? site7Mask
      : (dominant && linePixelCount >= 12 ? lineMask : colorfulMask);
    const end = findLineEndpoint(endpointMask, width, height);
    const horizontalGridLines = [];
    for (let y = 1; y < height - 1; y++) {
      let similar = 0;
      for (let x = Math.floor(width * 0.08); x < Math.floor(width * 0.95); x += 3) {
        const index = (y * width + x) * 4;
        const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
        if (Math.max(r, g, b) - Math.min(r, g, b) < 14 && r > 70 && r < 235) similar++;
      }
      if (similar > width * 0.16 && !horizontalGridLines.some((line) => Math.abs(line - y) < 3)) horizontalGridLines.push(y);
    }
    const lineColorCandidates = ranked.slice(0, 8).map((bucket) => ({
      rgb: `${Math.round(bucket.r / bucket.count)},${Math.round(bucket.g / bucket.count)},${Math.round(bucket.b / bucket.count)}`,
      count: bucket.count
    }));
    return { end, endpointMethod, site7LinePixelCount, lineColorCandidates, horizontalGridLines: horizontalGridLines.slice(0, 30) };
  }

  // The latest differential sits at the line's right end, so scan columns
  // right-to-left for the line color and take the rightmost column that its
  // neighbors support (skips isolated specks and annotations). The endpoint Y
  // is the vertical centroid of that column, averaged with nearby columns.
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
    return { x: endX, y, xSpan: null, pixelCount: columnCounts[endX], confidence: endX > width * 0.6 ? "B" : "C" };
  }

  function emptyPart() { return { status: "not_present", capturedAt: null }; }
  function emptyGraph(candidates = []) {
    return {
      status: "not_present", capturedAt: null, graphImage: null, diffBallsRaw: null, diffBallsFinal: null,
      diffBallsManualOverride: null, diffBallsStatus: "not_analyzed", diffBallsMethod: null,
      diffBallsConfidence: null, graphZeroY: null, graphUpperLineY: null, graphLowerLineY: null,
      graphUpperValue: null, graphLowerValue: null, graphEndY: null, graphScaleBallsPerPixel: null,
      graphCandidateCount: candidates.length, graphCandidateRects: candidates.map((candidate) => candidate.debug.rect),
      selectedGraphRect: null, axisTextCandidates: [], lineColorCandidates: [], horizontalGridLines: [],
      graphImageWidth: null, graphImageHeight: null, graphCaptureMethod: null, axisAssumption: null, axisConfidence: null,
      graphAnalysisError: candidates.length ? "No primary graph selected" : "No graph candidate detected"
    };
  }

  function findLabeledValue(labels, root) {
    const wanted = labels.map(normalizeLabel);
    for (const row of root.querySelectorAll("tr,dl,li,div,p")) {
      const cells = [...row.children].filter((child) => isVisible(child));
      if (cells.length < 2 || cells.length > 12) continue;
      for (let index = 0; index < cells.length - 1; index++) {
        const label = normalizeLabel(cells[index].textContent);
        if (wanted.some((candidate) => labelMatches(label, candidate))) {
          const value = clean(cells[index + 1].textContent);
          if (value && normalizeLabel(value) !== label) return value;
        }
      }
    }
    for (const element of root.querySelectorAll("dt,th,label,[class*='label'],[class*='title']")) {
      const text = normalizeLabel(element.textContent);
      if (!wanted.some((candidate) => labelMatches(text, candidate))) continue;
      const sibling = element.nextElementSibling;
      if (sibling) {
        const value = clean(sibling.textContent || sibling.value);
        if (value) return value;
      }
    }
    return "";
  }

  function findMetricValue(labels, root) {
    const rootText = visibleText(root);
    for (const labelText of labels) {
      const escaped = labelText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const direct = rootText.match(new RegExp(`(?:^|\\s)${escaped}\\s*[:：]?\\s*(-?\\d[\\d,]*(?:\\/\\d[\\d,]*)?(?:\\s*(?:回|玉))?(?:\\s*\\([^)]*\\))?)`));
      if (direct) return direct[1];
    }
    const structured = findLabeledValue(labels, root);
    if (structured) return structured;
    const wanted = labels.map(normalizeLabel);
    const nodes = [...root.querySelectorAll("span,div,p,td,th,dt,dd,strong,b,label")].filter(isVisible);
    for (const node of nodes) {
      const text = clean(node.textContent);
      const normalized = normalizeLabel(text);
      const label = wanted.find((candidate) => labelMatches(normalized, candidate));
      if (!label) continue;
      const inline = text.match(/(?:^|\s)(-?\d[\d,]*(?:\.\d+)?(?:\s*(?:回|玉))?(?:\s*\([^)]*\))?)\s*$/);
      if (inline && normalizeLabel(inline[1]) !== label) return inline[1];
      for (let scope = node.parentElement, depth = 0; scope && depth < 3; scope = scope.parentElement, depth++) {
        const candidates = [...scope.querySelectorAll("span,div,p,td,th,dd,strong,b")]
          .filter((element) => element !== node && element.children.length === 0 && isVisible(element))
          .map((element) => ({ value: clean(element.textContent), distance: rectDistance(node.getBoundingClientRect(), element.getBoundingClientRect()) }))
          .filter((candidate) => /^-?\d[\d,]*(?:\.\d+)?(?:\s*(?:回|玉))?(?:\s*\([^)]*\))?$/.test(candidate.value))
          .sort((a, b) => a.distance - b.distance);
        if (candidates[0] && candidates[0].distance < 260) return candidates[0].value;
      }
    }
    return "";
  }

  function describeTables(root) {
    return [...root.querySelectorAll("table, [role='table']")].map((table, index) => {
      const rows = historyRows(table);
      const headers = rows.flatMap((row) => rowCells(row).map((cell) => clean(cell.textContent))).slice(0, 12);
      return { index, headers, rowCount: rows.length, isHistory: rows.some((row) => hasHistoryHeaders(rowCells(row).map((cell) => clean(cell.textContent)))) };
    });
  }

  function buildDebugSnapshot() {
    const inspection = state.inspection || inspectPage();
    const lastRecord = state.lastSavePayload?.[0] || null;
    const lastHistory = lastRecord?.parts?.history || null;
    const lastGraph = lastRecord?.parts?.graph || null;
    return {
      pageTitle: document.title,
      currentUrl: location.href,
      currentContext: state.currentContext ? structuredClone(state.currentContext) : null,
      urlPath: inspection.urlPath,
      urlParams: inspection.urlParams,
      urlScreenTypeCandidate: inspection.urlScreenTypeCandidate,
      urlDaiCandidate: inspection.urlDaiCandidate,
      urlDateCandidate: inspection.urlDateCandidate,
      detectedStoreCandidates: inspection.detectedStoreCandidates,
      selectedStoreName: inspection.selectedStoreName,
      selectedStoreReason: inspection.selectedStoreReason,
      detectedMachineCandidates: inspection.detectedMachineCandidates,
      selectedMachineName: inspection.selectedMachineName,
      selectedMachineReason: inspection.selectedMachineReason,
      ignoredMachineCandidates: inspection.ignoredMachineCandidates,
      detectedDaiCandidates: inspection.detectedDaiCandidates,
      selectedDai: inspection.selectedDai,
      selectedDaiReason: inspection.selectedDaiReason,
      ignoredDaiCandidates: inspection.ignoredDaiCandidates,
      detectedDateCandidates: inspection.detectedDateCandidates,
      selectedBusinessDate: inspection.selectedBusinessDate,
      selectedBusinessDateReason: inspection.selectedBusinessDateReason,
      dateTabCandidates: inspection.dateTabCandidates,
      screenTabCandidates: inspection.screenTabCandidates,
      selectedScreenType: inspection.selectedScreenType,
      selectedScreenTypeReason: inspection.selectedScreenTypeReason,
      detectedTables: inspection.detectedTables,
      detectedGraphCandidates: inspection.detectedGraphCandidates,
      payoutDebug: lastHistory ? {
        payoutTotal: lastHistory.payoutTotal ?? null,
        includedRows: lastHistory.payoutIncludedRows || [],
        excludedRows: lastHistory.payoutExcludedRows || []
      } : null,
      selectedGraphRect: lastGraph?.selectedGraphRect || null,
      graphAnalysisError: lastGraph?.graphAnalysisError || null,
      lastSavePayload: state.lastSavePayload
    };
  }

  function nearbyDateLabels(element) {
    const rect = element.getBoundingClientRect();
    return [...document.querySelectorAll("a,button,li,td,th,div,span")]
      .filter((node) => isVisible(node) && isExactShortDate(clean(node.textContent)) && node.children.length <= 1)
      .filter((node) => {
        const other = node.getBoundingClientRect();
        const centerX = (other.left + other.right) / 2;
        return centerX >= rect.left - 30 && centerX <= rect.right + 30 && other.bottom >= rect.top - 100 && other.top <= rect.bottom + 30;
      })
      .map((node) => clean(node.textContent));
  }

  function resolveCurrentUnitScope(selectedDai, root = document) {
    if (!selectedDai || selectedDai === "unknown") return root;
    const markers = [];
    for (const element of root.querySelectorAll("div,span,p,td,th,strong,b,h1,h2,h3")) {
      const text = clean(element.textContent);
      if (!isVisible(element) || !/^0*\d{1,6}\s*番台(?:\s*[/／]|$)/.test(text)) continue;
      if (isIgnoredDaiElement(element)) continue;
      if (normalizeDai(extractDai(text, true)) === selectedDai) markers.push(element);
    }
    for (const select of root.querySelectorAll("select")) {
      if (!isVisible(select)) continue;
      const value = normalizeDai(extractDai(clean(select.selectedOptions?.[0]?.textContent || select.value), false));
      if (value === selectedDai) markers.push(select);
    }
    const marker = markers.filter((element) => horizontalVisibleRatio(element.getBoundingClientRect()) >= 0.5)
      .sort((a, b) => elementViewportScore(b) - elementViewportScore(a))[0];
    if (!marker) return root;
    let scope = marker.parentElement || root;
    for (let parent = scope.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const values = unitMarkerValues(parent);
      if (values.size > 1) break;
      scope = parent;
    }
    return scope;
  }

  function unitMarkerValues(container) {
    const values = new Set();
    for (const element of container.querySelectorAll("div,span,p,td,th,strong,b,h1,h2,h3")) {
      const text = clean(element.textContent);
      if (/^0*\d{1,6}\s*番台(?:\s*[/／]|$)/.test(text)) values.add(normalizeDai(extractDai(text, true)));
    }
    for (const select of container.querySelectorAll("select")) {
      const value = normalizeDai(extractDai(clean(select.selectedOptions?.[0]?.textContent || select.value), false));
      if (value !== "unknown") values.add(value);
    }
    return values;
  }

  function anchorParamMatches(element, key, expected) {
    if (!expected || !(element instanceof HTMLAnchorElement) || !element.href) return false;
    try { return new URL(element.href, location.href).searchParams.get(key) === expected; } catch (_) { return false; }
  }

  function horizontalVisibleRatio(rect) {
    if (!rect?.width) return 0;
    const visible = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    return Math.max(0, Math.min(1, visible / rect.width));
  }

  function elementViewportScore(element) {
    const rect = element.getBoundingClientRect();
    const ratio = horizontalVisibleRatio(rect);
    const viewportCenter = window.innerWidth / 2;
    const center = (rect.left + rect.right) / 2;
    const centrality = Math.max(0, 1 - Math.abs(center - viewportCenter) / Math.max(viewportCenter, 1));
    return Math.round(ratio * 500 + centrality * 250);
  }

  function rectObject(rect) {
    return { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height) };
  }

  function rectDistance(a, b) {
    const ax = (a.left + a.right) / 2, ay = (a.top + a.bottom) / 2;
    const bx = (b.left + b.right) / 2, by = (b.top + b.bottom) / 2;
    return Math.hypot(ax - bx, ay - by);
  }

  function parseCssColor(value) {
    const match = String(value || "").match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\)/i);
    return match ? { r: +match[1], g: +match[2], b: +match[3], a: match[4] === undefined ? 1 : +match[4] } : null;
  }

  function colorLuminance(value) {
    const color = parseCssColor(value);
    return !color || color.a === 0 ? null : 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
  }

  function isOrangeColor(value) {
    const color = parseCssColor(value);
    return Boolean(color && color.r > 200 && color.g >= 70 && color.g < 190 && color.b < 80);
  }

  function isBlueColor(value) {
    const color = parseCssColor(value);
    return Boolean(color && color.b > 110 && color.b > color.r * 1.25 && color.b > color.g * 1.05);
  }

  function isRedColor(value) {
    const color = parseCssColor(value);
    return Boolean(color && color.r > 170 && color.r > color.g * 1.5 && color.r > color.b * 1.5);
  }

  function labelMatches(actual, expected) {
    if (actual === expected) return true;
    const suffix = actual.startsWith(expected) ? actual.slice(expected.length) : "";
    return Boolean(suffix && suffix.length <= 4 && !/\d/.test(suffix));
  }

  function normalizeLabel(value) { return clean(value).replace(/[\s:：・｜|／/()（）]/g, "").toLowerCase(); }
  function normalizeAsciiWidth(value) { return String(value || "").replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0)).replace(/　/g, " "); }
  function clean(value) { return String(value || "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim(); }
  function visibleText(root) { return clean(root.innerText || root.textContent); }
  function parseNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const text = String(value).replace(/,/g, "");
    if (/^(?:--|―|－|−)$/.test(text.trim())) return null;
    const match = text.match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  }
  function parseSignedNumber(value) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const normalized = String(value).replace(/[＋,\s]/g, "").replace(/[−－]/g, "-");
    return /^[-+]?\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : null;
  }
  function isVisible(element) {
    if (!element?.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function renderStatusBar(inspection) {
    let bar = document.getElementById("site7-collector-status");
    if (!bar) {
      bar = document.createElement("aside");
      bar.id = "site7-collector-status";
      document.documentElement.appendChild(bar);
    }
    const symbols = [inspection.detectedParts.summary, inspection.detectedParts.history, inspection.detectedParts.graph].map((found) => found ? "✅" : "❌");
    const daiCandidates = [...new Set(inspection.detectedDaiCandidates.filter((candidate) => candidate.activeViewport || candidate.reason === "url_dn").map((candidate) => candidate.value))].join(" / ") || "なし";
    const dateCandidates = [...new Set(inspection.detectedDateCandidates.map((candidate) => candidate.label))].join(" / ") || "なし";
    bar.innerHTML = `<strong>Site7 Collector ON${inspection.contextLocked ? " / CONTEXT LOCKED" : ""}</strong>台番: ${escapeHtml(inspection.dai)} ${inspection.daiConfidence}（${escapeHtml(inspection.selectedDaiReason)}）\n候補: ${escapeHtml(daiCandidates)}\n機種: ${escapeHtml(inspection.machineName)}（${escapeHtml(inspection.selectedMachineReason)}）\n日付: ${escapeHtml(inspection.businessDate)} ${inspection.dateConfidence}（${escapeHtml(inspection.selectedBusinessDateReason)}）\n候補: ${escapeHtml(dateCandidates)}\n画面: ${escapeHtml(inspection.screenType)} ${inspection.screenTypeConfidence}（${escapeHtml(inspection.selectedScreenTypeReason)}）\nsummary ${symbols[0]} history ${symbols[1]} graph ${symbols[2]} / 取得済み ${state.saveCount}件`;
  }

  function removeStatusBar() { document.getElementById("site7-collector-status")?.remove(); }

  function showToast(message, type) {
    const toast = document.createElement("div");
    toast.className = `site7-collector-toast ${type === "warn" ? "warn" : type === "error" ? "error" : ""}`;
    toast.textContent = message;
    document.documentElement.appendChild(toast);
    setTimeout(() => toast.remove(), 4200);
  }

  function notifySound(type) {
    if (!state.settings?.soundEnabled) return;
    try {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = type === "success" ? 880 : type === "warning" ? 440 : 180;
      gain.gain.setValueAtTime(0.06, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.16);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(); oscillator.stop(context.currentTime + 0.17);
    } catch (_) { /* Browser may require a user gesture. */ }
  }

  function summarizeParts(records) {
    const first = records[0];
    const names = ["summary", "history", "graph"].filter((name) => first.parts[name]?.status === "captured");
    const historyCount = first.parts.history?.rows?.length;
    return `${names.join(" + ") || "metadataのみ"}${historyCount ? ` / history ${historyCount}件` : ""}`;
  }

  async function autoSave() {
    const inspection = state.inspection || applyCurrentContext(inspectPage());
    const signature = buildAutoSignature(inspection);
    if (state.autoSaveInFlight || signature === state.lastAutoSignature || inspection.pageType === "unknown") return;
    state.autoSaveInFlight = true;
    state.lastAutoSignature = signature;
    const result = await captureAndSave(true).catch(() => null);
    state.autoSaveInFlight = false;
    const graph = result?.records?.[0]?.parts?.graph;
    const graphNeedsRetry = inspection.screenType === "graph" && (!graph || graph.status !== "captured" || !Number.isFinite(graph.diffBallsFinal));
    if (!result || result.skipped || graphNeedsRetry) {
      if (inspection.screenType === "graph" && state.autoAttemptCount < 4) {
        state.lastAutoSignature = "";
        state.autoAttemptCount += 1;
        clearTimeout(state.autoRetryTimer);
        state.autoRetryTimer = setTimeout(autoSave, 1500);
      } else if (inspection.screenType !== "graph") {
        state.lastAutoSignature = "";
      }
    } else {
      state.autoAttemptCount = 0;
    }
  }

  function shouldAutoSave(inspection) {
    return Boolean(state.settings?.autoSave || inspection?.screenType === "graph");
  }

  function buildAutoSignature(inspection) {
    if (!inspection) return "";
    return [inspection.source || "site7", inspection.site7Pmc, inspection.site7Mdc, inspection.daiNormalized, inspection.businessDate, inspection.screenType].join("|");
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }
})();
