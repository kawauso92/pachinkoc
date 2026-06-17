/**
 * P'sCUBE DevTools Graph Data Collector
 *
 * Usage:
 *   1. Open a P'sCUBE machine page in Chrome on your phone/PC
 *      (e.g., nc-v06-001.php?cd_dai=0215)
 *   2. Open DevTools (F12 or chrome://inspect for mobile)
 *   3. Paste this entire script into the Console tab
 *   4. It will:
 *      - Extract all graph data (本日, 1日前, 2日前) from the current page
 *      - Automatically navigate to the next machine
 *      - Repeat until all machines are collected or stopped
 *   5. Results are logged to console and stored in window.__pscube_results
 *   6. When done, copy(JSON.stringify(window.__pscube_results, null, 2))
 *      to get the full JSON
 *
 * To stop: window.__pscube_stop = true
 * To collect only current page: pscubeCollectCurrent()
 */

(function() {
  'use strict';

  // Config
  const DELAY_BETWEEN_MACHINES = 6000; // ms
  const MAX_MACHINES = 50;

  window.__pscube_results = window.__pscube_results || [];
  window.__pscube_stop = false;

  function extractCurrentPage() {
    const result = {
      timestamp: new Date().toISOString(),
      dai: '',
      ymdBiz: '',
      pageTitle: document.title,
      graphs: [],
      amchartsData: [],
      svgData: [],
      dataTable: [],
    };

    // Get current dai and YMD_biz from api06
    try {
      result.dai = api06._cd_dai || '';
      result.ymdBiz = api06._YMD_biz || '';
    } catch(e) {
      // Try from URL
      const m = location.search.match(/cd_dai=(\d+)/);
      if (m) result.dai = m[1];
    }

    // ---- Method 1: Read from nc-m06-001.php response (via api06) ----
    // The page already called this. We can re-call it in page context.
    // But first, check if AmCharts already has the data.

    // ---- Method 2: AmCharts.charts (rendered chart data) ----
    try {
      if (typeof AmCharts !== 'undefined' && AmCharts.charts) {
        for (let i = 0; i < AmCharts.charts.length; i++) {
          const chart = AmCharts.charts[i];
          const entry = {
            index: i,
            divId: chart.div ? chart.div.id : '',
            type: chart.type || '',
            dataLength: 0,
            lastValue: null,
            minValue: null,
            maxValue: null,
            categoryField: chart.categoryField || '',
            chartTitle: '',
            chartContainerYmd: '',
          };

          // Find parent CHART- container for title/date
          if (chart.div) {
            let el = chart.div;
            for (let j = 0; j < 8; j++) {
              el = el.parentElement;
              if (!el) break;
              if (el.id && el.id.startsWith('CHART-')) {
                entry.chartContainerYmd = el.id.replace('CHART-', '');
                const titleLi = el.querySelector('li.nc-bar, li:first-child');
                if (titleLi) entry.chartTitle = titleLi.textContent.trim();
                break;
              }
            }
          }

          // Extract data
          if (chart.dataProvider && chart.dataProvider.length > 0) {
            const dp = chart.dataProvider;
            entry.dataLength = dp.length;
            entry.firstPoint = dp[0];
            entry.lastPoint = dp[dp.length - 1];

            // Determine value field
            let vf = 'value';
            if (chart.graphs && chart.graphs[0]) {
              vf = chart.graphs[0].valueField || chart.graphs[0].yField || 'value';
            }
            entry.valueField = vf;

            const values = dp.map(p => p[vf]).filter(v => v !== undefined && v !== null).map(Number);
            if (values.length > 0) {
              entry.lastValue = values[values.length - 1];
              entry.minValue = Math.min(...values);
              entry.maxValue = Math.max(...values);
            }
          }

          result.amchartsData.push(entry);
        }
      }
    } catch(e) {
      result.amchartsError = e.message;
    }

    // ---- Method 3: SVG elements ----
    try {
      const svgs = document.querySelectorAll('svg');
      for (let i = 0; i < svgs.length; i++) {
        const svg = svgs[i];
        const parent = svg.parentElement;
        const entry = {
          index: i,
          parentId: parent ? parent.id : '',
          width: svg.clientWidth,
          height: svg.clientHeight,
          textLabels: [],
        };

        // Extract text labels (axis values)
        const texts = svg.querySelectorAll('text');
        for (const t of texts) {
          const content = t.textContent.trim().replace(/ /g, '').replace(/,/g, '');
          if (/^-?\d+$/.test(content) && Math.abs(parseInt(content)) >= 100) {
            entry.textLabels.push({
              value: parseInt(content),
              x: parseFloat(t.getAttribute('x') || t.getBBox().x),
              y: parseFloat(t.getAttribute('y') || t.getBBox().y),
            });
          }
        }

        // Get rightmost path endpoint for diff estimate
        const paths = svg.querySelectorAll('path[stroke]');
        if (paths.length > 0) {
          entry.pathCount = paths.length;
          // Get the main graph line (usually first colored path)
          for (const path of paths) {
            const d = path.getAttribute('d') || '';
            if (d.length > 50) { // substantial path
              // Extract last point from SVG path
              const moves = d.match(/[ML]\s*[\d.]+[\s,][\d.]+/g);
              if (moves && moves.length > 0) {
                const lastMove = moves[moves.length - 1];
                const coords = lastMove.match(/[\d.]+/g);
                if (coords && coords.length >= 2) {
                  entry.lastPathX = parseFloat(coords[0]);
                  entry.lastPathY = parseFloat(coords[1]);
                }
              }
              break;
            }
          }
        }

        // Estimate diff from SVG
        if (entry.textLabels.length >= 2 && entry.lastPathY !== undefined) {
          // Find y-axis labels (they should all have similar x positions)
          const labels = entry.textLabels.sort((a, b) => a.y - b.y);
          // Try to build a y->value mapping
          if (labels.length >= 2) {
            const top = labels[0]; // highest on screen = highest value
            const bottom = labels[labels.length - 1];
            if (top.y !== bottom.y) {
              const slope = (bottom.value - top.value) / (bottom.y - top.y);
              const intercept = top.value - slope * top.y;
              entry.svgEstimatedDiff = Math.round(slope * entry.lastPathY + intercept);
              entry.svgScaleInfo = `slope=${slope.toFixed(2)}, labels=${labels.map(l=>l.value)}`;
            }
          }
        }

        if (entry.textLabels.length > 0 || entry.pathCount > 0) {
          result.svgData.push(entry);
        }
      }
    } catch(e) {
      result.svgError = e.message;
    }

    // ---- Method 4: Data table ----
    try {
      const tblDAb = document.querySelector('#tblDAb');
      if (tblDAb) {
        const rows = tblDAb.querySelectorAll('tr');
        for (const tr of rows) {
          const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
          result.dataTable.push(cells);
        }
      }
    } catch(e) {}

    // ---- Method 5: CHART container titles ----
    try {
      const chartUls = document.querySelectorAll('[id^="CHART-"]');
      result.chartContainers = Array.from(chartUls).map(ul => ({
        id: ul.id,
        title: ul.querySelector('li') ? ul.querySelector('li').textContent.trim() : '',
      }));
    } catch(e) {}

    return result;
  }

  // Make available globally
  window.pscubeCollectCurrent = function() {
    const result = extractCurrentPage();
    console.log('[P\'sCUBE] Collected:', result.dai,
                'graphs:', result.amchartsData.length,
                'SVGs:', result.svgData.length);

    for (const ch of result.amchartsData) {
      console.log(`  Chart[${ch.index}]: "${ch.chartTitle}" YMD=${ch.chartContainerYmd} ` +
                  `points=${ch.dataLength} lastValue=${ch.lastValue} ` +
                  `min=${ch.minValue} max=${ch.maxValue}`);
    }
    for (const sv of result.svgData) {
      if (sv.svgEstimatedDiff !== undefined) {
        console.log(`  SVG[${sv.index}]: parent=${sv.parentId} ` +
                    `estimatedDiff=${sv.svgEstimatedDiff} ${sv.svgScaleInfo}`);
      }
    }

    return result;
  };

  // Auto-collect with navigation
  window.pscubeCollectAll = async function(maxMachines) {
    const max = maxMachines || MAX_MACHINES;
    console.log(`[P'sCUBE] Starting auto-collection. Max ${max} machines. ` +
                `Set window.__pscube_stop = true to stop.`);

    for (let count = 0; count < max; count++) {
      if (window.__pscube_stop) {
        console.log('[P\'sCUBE] Stopped by user.');
        break;
      }

      // Wait for page to be ready
      await new Promise(r => setTimeout(r, 2000));

      // Check if AmCharts is loaded
      let retries = 0;
      while (retries < 10) {
        if (typeof AmCharts !== 'undefined' && AmCharts.charts && AmCharts.charts.length > 0) {
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
        retries++;
      }

      const result = extractCurrentPage();
      window.__pscube_results.push(result);

      const graphSummary = result.amchartsData.map(ch =>
        `${ch.chartTitle}:${ch.lastValue}`).join(', ');
      console.log(`[P'sCUBE] [${count+1}] dai=${result.dai} | ${graphSummary}`);

      // Navigate to next machine
      const nextBtn = document.querySelector('#dai_next');
      if (!nextBtn) {
        console.log('[P\'sCUBE] No next button found. Stopping.');
        break;
      }

      nextBtn.click();
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_MACHINES));
    }

    console.log(`[P'sCUBE] Done. Collected ${window.__pscube_results.length} machines.`);
    console.log('[P\'sCUBE] To get results: copy(JSON.stringify(window.__pscube_results, null, 2))');
    return window.__pscube_results;
  };

  // Also try to extract by re-calling the API directly
  window.pscubeManualApiCall = function(ymd) {
    return new Promise(function(resolve) {
      try {
        const params = {
          cd_dai: api06._cd_dai,
          YMD_biz: ymd || api06._YMD_biz,
          apikey: api.apikey,
          _i: api.token._i,
          _t: api.token._t,
          page: 1,
        };
        $.ajax({url: api._model(), data: params, dataType: 'json', timeout: 15000})
        .done(function(data) {
          console.log('[P\'sCUBE API] Success. Keys:', Object.keys(data));
          if (Array.isArray(data.Graph)) {
            console.log('[P\'sCUBE API] Graph count:', data.Graph.length);
            data.Graph.forEach(function(g, i) {
              let info = `  Graph[${i}]: title=${g.title}, YMD_biz=${g.YMD_biz}`;
              if (g.src && g.src.datas) {
                const d = g.src.datas;
                if (Array.isArray(d)) {
                  const last = d[d.length - 1];
                  info += `, points=${d.length}, lastValue=${last ? last.value : '?'}`;
                } else if (d.p) {
                  info += `, points(p)=${d.p.length}`;
                  if (d.p.length > 0 && d.g && d.g[0]) {
                    const yf = d.g[0].yField || 'value';
                    const last = d.p[d.p.length - 1];
                    info += `, last_${yf}=${last[yf]}`;
                  }
                }
              }
              console.log(info);
            });
          }
          resolve(data);
        })
        .fail(function(xhr) {
          console.log('[P\'sCUBE API] Failed:', xhr.status, xhr.statusText);
          resolve(null);
        });
      } catch(e) {
        console.log('[P\'sCUBE API] Error:', e.message);
        resolve(null);
      }
    });
  };

  console.log('========================================');
  console.log("P'sCUBE Graph Collector loaded!");
  console.log('========================================');
  console.log('Commands:');
  console.log('  pscubeCollectCurrent()  - Extract current page');
  console.log('  pscubeCollectAll(38)    - Auto-navigate & collect 38 machines');
  console.log('  pscubeManualApiCall()   - Re-call API for current machine');
  console.log('  pscubeManualApiCall("20260616") - Call API with specific date');
  console.log('');
  console.log('Results: window.__pscube_results');
  console.log('Stop:    window.__pscube_stop = true');
  console.log('Export:  copy(JSON.stringify(window.__pscube_results, null, 2))');
  console.log('========================================');

  // Auto-extract current page
  const current = pscubeCollectCurrent();

})();
