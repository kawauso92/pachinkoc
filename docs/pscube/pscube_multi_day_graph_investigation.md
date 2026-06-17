# P'sCUBE 隍・焚譌･繧ｰ繝ｩ繝戊ｪｿ譟ｻ繝ｬ繝昴・繝・
隱ｿ譟ｻ譌･: 2026-06-17
蟇ｾ雎｡蠎苓・: 繝上う繝代・繧｢繝ｭ繝ｼ鄒主次 (c732925)
蟇ｾ雎｡譌･: 2026-06-16
蟇ｾ雎｡蜿ｰ謨ｰ: 38蜿ｰ (eva17ﾃ・0蜿ｰ + eva15ﾃ・8蜿ｰ)

---

## 邨占ｫ・
### 1譌･蜑阪げ繝ｩ繝輔・縺ｩ縺薙°繧峨ョ繝ｼ繧ｿ繧貞叙蠕励＠縺ｦ縺・ｋ縺・
**`nc-m06-001.php` 縺ｮ蜊倅ｸ繝ｬ繧ｹ繝昴Φ繧ｹ蜀・↓縲∵悽譌･繝ｻ1譌･蜑阪・2譌･蜑阪・蜈ｨ繧ｰ繝ｩ繝輔ョ繝ｼ繧ｿ縺悟性縺ｾ繧後ｋ縲・*

```
nc-m06-001.php 竊・JSON 竊・{
  GraphType: "svg",
  Graph: [
    { title: "譛ｬ譌･",   YMD_biz: "20260617", id: "...", src: { datas: [...] } },
    { title: "1譌･蜑・,  YMD_biz: "20260616", id: "...", src: { datas: [...] } },
    { title: "2譌･蜑・,  YMD_biz: "20260615", id: "...", src: { datas: [...] } }
  ]
}
```

- 驕主悉譌･繧ｰ繝ｩ繝募叙蠕励↓蛻･繧ｨ繝ｳ繝峨・繧､繝ｳ繝医ｄ霑ｽ蜉繝ｪ繧ｯ繧ｨ繧ｹ繝医・荳崎ｦ・- `Graph[1].src.datas` 縺ｮ譛邨・`value` 縺・譌･蜑阪・譛邨ょｷｮ邇・- 1蝗槭・API繧ｳ繝ｼ繝ｫ縺ｧ3譌･蛻・叙蠕怜庄閭ｽ

### 繧ｹ繧ｯ繝ｪ繝励ヨ・・laywright・峨〒蜿門ｾ励〒縺阪↑縺九▲縺溷次蝗

**Cloudflare WAF 縺・nc-m06-001.php 縺ｸ縺ｮAJAX繝ｪ繧ｯ繧ｨ繧ｹ繝医ｒ驕ｸ謚樒噪縺ｫ繝悶Ο繝・け・・TTP 451・峨＠縺ｦ縺・ｋ縲・*

| 隕ｳ貂ｬ莠矩・| 隧ｳ邏ｰ |
|---------|------|
| 繝壹・繧ｸHTML (nc-v06-001.php) | 200 OK 窶・豁｣蟶ｸ縺ｫ繝ｭ繝ｼ繝・|
| 繝・・繧ｿAPI (nc-m06-001.php) | **451** 窶・Cloudflare WAF繝悶Ο繝・け |
| 謇句虚API繧ｳ繝ｼ繝ｫ (page蜀・S) | **502** 窶・繧ｵ繝ｼ繝舌・蜀・Κ繧ｨ繝ｩ繝ｼ・医Ξ繝ｼ繝亥宛髯仙ｾ鯉ｼ・|
| AmCharts.charts | 遨ｺ驟榊・ 窶・API螟ｱ謨励・縺溘ａ謠冗判縺ｪ縺・|
| SVG隕∫ｴ | 0蛟・窶・繧ｰ繝ｩ繝墓悴謠冗判 |
| divCHART | 遨ｺ 窶・蟄占ｦ∫ｴ縺ｪ縺・|

**繝悶Ο繝・け縺ｮ莉慕ｵ・∩:**
1. 繝壹・繧ｸHTML縺ｯ豁｣蟶ｸ縺ｫ霑斐ｋ・・loudflare challenge騾夐℃貂医∩・・2. 繝壹・繧ｸ蜀・S縺・`api06.show()` 竊・`$.ajax({url: nc-m06-001.php, ...})` 繧貞ｮ溯｡・3. 縺薙・AJAX繝ｪ繧ｯ繧ｨ繧ｹ繝医ｒCloudflare WAF縺梧､懈渊縺励￣laywright縺九ｉ縺ｮ繝ｪ繧ｯ繧ｨ繧ｹ繝医ｒ451縺ｧ諡貞凄
4. 繝壹・繧ｸHTML縺ｮcf_clearance繧ｯ繝・く繝ｼ縺ｯ譛牙柑縺縺後、PI繝ｬ繝吶Ν縺ｧ蛻･騾斐ヶ繝ｭ繝・け

**螳溘ヶ繝ｩ繧ｦ繧ｶ縺ｨ縺ｮ蟾ｮ逡ｰ:**
- 螳溘ヶ繝ｩ繧ｦ繧ｶ・医せ繝槭・Safari遲会ｼ・ nc-m06-001.php 竊・200 OK 竊・Graph[]驟榊・縺ｫ3譌･蛻・- Playwright Chromium: nc-m06-001.php 竊・451 Blocked 竊・Graph[]蜿門ｾ怜､ｱ謨・- Playwright + stealth險ｭ螳・ nc-m06-001.php 竊・502 (繝ｬ繝ｼ繝亥宛髯仙ｾ・ or 451

---

## JS隗｣譫舌↓繧医ｋ蜍穂ｽ懃｢ｺ隱・
### api06.show() 縺ｮ繝輔Ο繝ｼ (pscube_jquery_netcube.js)

```
api06.show(cd_dai, YMD_biz, isLoadFirst)
  竊・$.ajax({ url: nc-m06-001.php, data: {cd_dai, YMD_biz, apikey, _i, _t, page} })
  竊・.done()
api06.render(json)
  竊・if (json.GraphType == 'svg')
  竊・TmplSVGCHART 繝・Φ繝励Ξ繝ｼ繝医〒 Graph[] 驟榊・繧貞ｱ暮幕
  竊・<ul id="CHART-{{YMD_biz}}">  竊・譌･莉倥＃縺ｨ縺ｮ繧ｳ繝ｳ繝・リ
  竊・self.renderCharts(json.Graph)  竊・AmCharts謠冗判
  竊・$('#SVG-CHART7').AmChart7({...})  竊・nc-m06-003.php・磯｣邯壹げ繝ｩ繝包ｼ・$('#Toku7').Toku7({...}).show()   竊・迚ｹ雉槫ｱ･豁ｴ繝・ヶ
```

### renderCharts() 縺ｮ蜃ｦ逅・(L656-728)

```javascript
$.each(graphDatas, function(i, value) {
    // value = Graph[i] = 1譌･蛻・・繧ｰ繝ｩ繝輔ョ繝ｼ繧ｿ
    // value.id   竊・SVG繧ｳ繝ｳ繝・リ縺ｮID
    // value.src.datas[] 竊・[{date, value}, ...]  譎らｳｻ蛻励ョ繝ｼ繧ｿ
    // value.src.datas 縺ｮ譛邨りｦ∫ｴ.value = 縺昴・譌･縺ｮ譛邨ょｷｮ邇・
    if (!value.src || !value.src.datas || !value.src.datas.length) {
        竊・"繝・・繧ｿ縺ｯ縺ゅｊ縺ｾ縺帙ｓ縲・ 陦ｨ遉ｺ
    } else {
        竊・AmCharts 縺ｧ謠冗判
    }
});
```

### 蟾ｮ邇峨・謇蝨ｨ

| 繝・・繧ｿ繧ｽ繝ｼ繧ｹ | 蟾ｮ邇・| 蛯呵・|
|------------|------|------|
| Graph[].src.datas[last].value | **笳・* | 蜷・律縺ｮ繧ｹ繝ｩ繝ｳ繝励げ繝ｩ繝墓怙邨ょ､ = 譛邨ょｷｮ邇・|
| Data (繧ｵ繝槭Μ繝ｼ繝・・繝悶Ν) | **ﾃ・* | 螟ｧ蠖薙ｊ蝗樊焚, 邏ｯ險医せ繧ｿ繝ｼ繝育ｭ峨・縺ｿ |
| Hist (迚ｹ雉槫ｱ･豁ｴ) | **ﾃ・* | 螟ｧ蠖薙ｊ隧ｳ邏ｰ縺ｮ縺ｿ |
| nc-m06-003.php (AmChart7) | **笆ｳ** | 騾｣邯壹げ繝ｩ繝包ｼ亥ｷｮ邇峨→縺ｯ蛻･縺ｮ謗ｨ遘ｻ・・|

---

## 隱ｿ譟ｻ縺ｧ菴ｿ逕ｨ縺励◆繝励Ο繝ｼ繝・
| 繧ｹ繧ｯ繝ｪ繝励ヨ | 邨先棡 |
|-----------|------|
| pscube_multiday_probe.py | 繝壹・繧ｸ200, nc-m06-001竊・51, DOM遨ｺ |
| pscube_stealth_probe.py | 繝壹・繧ｸ502 (繝ｬ繝ｼ繝亥宛髯・, 繧ｨ繝ｳ繧ｳ繝ｼ繝峨お繝ｩ繝ｼ |
| pscube_dom_probe.py | DOM迥ｶ諷狗｢ｺ隱阪・縺ｿ |
| 菫晏ｭ俶ｸ医∩HTML隗｣譫・| 繝・Φ繝励Ξ繝ｼ繝域ｧ矩遒ｺ隱肴・蜉・|
| pscube_jquery_netcube.js 隗｣譫・| Graph[]驟榊・繝ｻ隍・焚譌･繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ遒ｺ隱・|

---

## 謗ｨ螂ｨ縺吶ｋ蟾ｮ邇牙ｮ牙ｮ壼叙蠕玲婿豕・
### 譁ｹ豕・: DevTools繧ｳ繝ｳ繧ｽ繝ｼ繝ｫ繧ｹ繧ｯ繝ｪ繝励ヨ・域怙蜆ｪ蜈域耳螂ｨ・・
**繝輔ぃ繧､繝ｫ: `scripts/pscube_devtools_collector.js`**

```
謇矩・
  1. Chrome縺ｧ蜿ｰ逡ｪ0181縺ｮ繝壹・繧ｸ繧帝幕縺・  2. F12 竊・Console 縺ｫ繧ｹ繧ｯ繝ｪ繝励ヨ繧定ｲｼ繧贋ｻ倥￠
  3. pscubeCollectAll(38) 繧貞ｮ溯｡・  4. 閾ｪ蜍輔〒蜈ｨ38蜿ｰ繧貞ｷ｡蝗槭；raph[]蜈ｨ莉ｶ・域悽譌･+1譌･蜑・2譌･蜑搾ｼ峨ｒ謚ｽ蜃ｺ
  5. copy(JSON.stringify(window.__pscube_results, null, 2)) 縺ｧ邨先棡繧偵さ繝斐・
  6. JSON繝輔ぃ繧､繝ｫ縺ｨ縺励※菫晏ｭ・竊・analysis.py 縺瑚ｪｭ縺ｿ霎ｼ縺ｿ
```

**蛻ｩ轤ｹ:**
- 螳溘ヶ繝ｩ繧ｦ繧ｶ縺ｮ繧ｻ繝・す繝ｧ繝ｳ蜀・〒蜍穂ｽ懊☆繧九◆繧√，loudflare WAF 縺ｫ荳蛻・ｼ輔▲縺九°繧峨↑縺・- nc-m06-001.php 縺ｮJSON繝ｬ繧ｹ繝昴Φ繧ｹ縺梧ｭ｣蟶ｸ縺ｫ霑斐ｋ 竊・Graph[]蜈ｨ莉ｶ蜿門ｾ怜庄閭ｽ
- 蜑榊床/谺｡蜿ｰ繝懊ち繝ｳ縺ｧ閾ｪ蜍募ｷ｡蝗・- AmCharts.charts 縺九ｉ繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ貂医∩繝・・繧ｿ繧ょ叙蠕暦ｼ医ヰ繝・け繧｢繝・・・・- SVG蠎ｧ讓吶°繧峨・蟾ｮ邇画耳螳壹ｂ蜷梧凾螳溯｡・
**繝・・繧ｿ蜿門ｾ礼ｵ瑚ｷｯ:**
1. **AmCharts.charts[].dataProvider** 竊・繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ貂医∩繝√Ε繝ｼ繝医ョ繝ｼ繧ｿ・・astValue = 譛邨ょｷｮ邇会ｼ・2. **pscubeManualApiCall()** 竊・繝壹・繧ｸ蜀・さ繝ｳ繝・く繧ｹ繝医〒API繧貞・蜻ｼ蜃ｺ縺暦ｼ・raph[]驟榊・繝輔Ν蜿門ｾ暦ｼ・3. **SVG蠎ｧ讓咎・ｮ・* 竊・y霆ｸ繝ｩ繝吶Ν縺ｨ繝代せ邨らせ縺九ｉ蟾ｮ邇峨ｒ謗ｨ螳・
### 譁ｹ豕・: Playwright + 謖∫ｶ壹ヶ繝ｩ繧ｦ繧ｶ繝励Ο繝輔ぃ繧､繝ｫ

```
謇矩・
  1. 騾壼ｸｸ縺ｮChrome縺ｧP'sCUBE繧帝夢隕ｧ縺励…f_clearance繧貞叙蠕・  2. Chrome --user-data-dir 縺ｧ繝励Ο繝輔ぃ繧､繝ｫ繧呈ｰｸ邯壼喧
  3. Playwright縺後◎縺ｮ繝励Ο繝輔ぃ繧､繝ｫ繧・launch(persistent_context) 縺ｧ蜀榊茜逕ｨ
```

**蛻ｩ轤ｹ:** 閾ｪ蜍募喧蜿ｯ閭ｽ
**繝ｪ繧ｹ繧ｯ:** Playwright繧ｳ繝ｳ繝・く繧ｹ繝医〒繧・51縺悟・繧句庄閭ｽ諤ｧ縺ゅｊ・郁ｦ∵､懆ｨｼ・・
### 譁ｹ豕・: 蠖捺律繝ｪ繧｢繝ｫ繧ｿ繧､繝蜿門ｾ暦ｼ磯哩蠎怜ｾ鯉ｼ・
```
繧ｿ繧､繝溘Φ繧ｰ: 蝟ｶ讌ｭ譌･縺ｮ22:00-23:30
繝・・繝ｫ: pscube_realtime_diff_collector.py --no-headless
謇矩・ CAPTCHA繧呈焔蜍暮夐℃蠕後∬・蜍募ｷ｡蝗・```

**豕ｨ諢・** 06/17繝励Ο繝ｼ繝悶〒縺ｯ蠖捺律縺ｧ繧・51縺悟・縺溘◆繧√∫｢ｺ螳溘〒縺ｯ縺ｪ縺・・
---

## 繝ｦ繝ｼ繧ｶ繝ｼ縺ｮ雉ｪ蝠上∈縺ｮ蝗樒ｭ・
### Q1: 1譌･蜑阪・繧ｰ繝ｩ繝輔・縺ｩ縺薙°繧峨ョ繝ｼ繧ｿ繧貞ｾ励※縺・ｋ縺・
**`nc-m06-001.php` 縺ｮJSON繝ｬ繧ｹ繝昴Φ繧ｹ蜀・・ `Graph[1]`縲・* 蛻･繝ｪ繧ｯ繧ｨ繧ｹ繝医〒縺ｯ縺ｪ縺上∵悽譌･縺ｮAPI繧ｳ繝ｼ繝ｫ1蝗槭〒3譌･蛻・′霑斐ｋ縲ゅユ繝ｳ繝励Ξ繝ｼ繝・`TmplSVGCHART` 縺碁・蛻励ｒ繧､繝・Ξ繝ｼ繝医＠縲～<ul id="CHART-20260616">` 縺ｨ縺励※螻暮幕縲・
### Q2: 驕主悉譌･縺ｮ譛邨ょｷｮ邇峨・繧ｹ繧ｯ繝ｪ繝励ヨ縺ｧ蜿門ｾ励〒縺阪ｋ縺・
**DevTools繧ｳ繝ｳ繧ｽ繝ｼ繝ｫ繧ｹ繧ｯ繝ｪ繝励ヨ邨檎罰縺ｪ繧牙叙蠕怜庄閭ｽ縲・* 螳溘ヶ繝ｩ繧ｦ繧ｶ繧ｻ繝・す繝ｧ繝ｳ蜀・〒AmCharts.charts縺ｾ縺溘・API繝ｬ繧ｹ繝昴Φ繧ｹ縺九ｉ `Graph[1].src.datas[last].value` 繧定ｪｭ繧縺縺代１laywright蜊倅ｽ薙〒縺ｯ迴ｾ譎らせ縺ｧCloudflare WAF縺ｫ繝悶Ο繝・け縺輔ｌ繧九◆繧∽ｸ榊庄縲・
### Q3: 繧ｹ繝槭・縺ｧ隕九∴繧九・縺ｫ繧ｹ繧ｯ繝ｪ繝励ヨ縺ｧ隕九∴縺ｪ縺・炊逕ｱ

**Cloudflare WAF 縺後ヶ繝ｩ繧ｦ繧ｶ閾ｪ蜍募喧繧呈､懷・縺励√・繝ｼ繧ｸHTML・・00 OK・峨・騾壹☆縺後ョ繝ｼ繧ｿAPI・・51・峨・繝悶Ο繝・け縺励※縺・ｋ縲・* 莉･荳九・讀懷・繝吶け繝医Ν縺瑚・∴繧峨ｌ繧・
- `navigator.webdriver` 繝励Ο繝代ユ繧｣
- Chrome DevTools Protocol 縺ｮ蟄伜惠
- Chromium 縺ｮAutomationControlled讖溯・繝輔Λ繧ｰ
- TLS fingerprint・・laywright Chromium縺ｯ騾壼ｸｸChrome縺ｨ逡ｰ縺ｪ繧具ｼ・- JavaScript螳溯｡後ち繧､繝溘Φ繧ｰ縺ｮ蟾ｮ逡ｰ

### Q4: appc 縺梧治逕ｨ縺吶∋縺榊ｷｮ邇牙叙蠕玲婿豕・
**DevTools繧ｳ繝ｳ繧ｽ繝ｼ繝ｫ繧ｹ繧ｯ繝ｪ繝励ヨ・域婿豕・・峨ｒ謗ｨ螂ｨ縲・* 逅・罰:
1. 遒ｺ螳溘↓Graph[]蜈ｨ莉ｶ縺悟叙蠕励〒縺阪ｋ蜚ｯ荳縺ｮ譁ｹ豕・2. 38蜿ｰ繧・遘帝俣髫斐〒閾ｪ蜍募ｷ｡蝗・竊・邏・蛻・〒螳御ｺ・3. 3譌･蛻・・蟾ｮ邇峨ｒ荳諡ｬ蜿門ｾ怜庄閭ｽ
4. Cloudflare WAF 繧貞屓驕ｿ縺帙★縲・壼ｸｸ縺ｮ繝悶Λ繧ｦ繧ｶ蜍穂ｽ懊・遽・峇蜀・
蟆・擂逧・↓縺ｯ譁ｹ豕・・域戟邯壹・繝ｭ繝輔ぃ繧､繝ｫ・峨・讀懆ｨｼ縺ｧ螳悟・閾ｪ蜍募喧繧堤岼謖・☆縲・
---

## 蜃ｺ蜉帙ヵ繧｡繧､繝ｫ

| 繝輔ぃ繧､繝ｫ | 蜀・ｮｹ |
|---------|------|
| pscube_multi_day_graph_investigation.md | 譛ｬ繝ｬ繝昴・繝・|
| pscube_multi_day_diff_debug.csv | 蟾ｮ邇牙叙蠕励ョ繝舌ャ繧ｰCSV |
| scripts/pscube_devtools_collector.js | DevTools繧ｳ繝ｳ繧ｽ繝ｼ繝ｫ蜿朱寔繧ｹ繧ｯ繝ｪ繝励ヨ |
| scripts/pscube_multiday_probe.py | Playwright繝励Ο繝ｼ繝・|
| scripts/pscube_stealth_probe.py | 繧ｹ繝・Ν繧ｹ繝励Ο繝ｼ繝・|
| debug_cache/ | 繧ｭ繝｣繝・す繝･貂医∩API蠢懃ｭ・|
