#!/usr/bin/env python3
"""
P'sCUBE real-time diff-ball collector using Playwright.

MUST be run on the SAME BUSINESS DAY as the target date, ideally after 22:00
when most machines have finished for the day.

This script:
  1. Opens one machine page in a real (non-headless) Chromium browser
  2. Waits for Cloudflare challenge to complete
  3. Intercepts nc-m06-001.php and nc-m06-003.php JSON responses
  4. Extracts diff balls from graph data points (last value in series)
  5. Navigates to next machine using the page's own "next" button
  6. Saves results to a JSON cache and CSV

Important:
  - Run non-headless so Cloudflare challenge can pass normally
  - The user may need to manually solve a CAPTCHA on first load
  - Uses 8-second delay between machines
  - Stops on 429/451/1015
  - graph data is only available for the CURRENT business day
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from playwright.sync_api import sync_playwright


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="P'sCUBE real-time diff collector")
    p.add_argument("--input", default="data/pscube/samples/arrow_mihara_eva_4p_20260616.csv",
                   help="Input CSV with machine list")
    p.add_argument("--date", default="", help="Target YYYYMMDD (default: today)")
    p.add_argument("--out", default="", help="Output cache JSON")
    p.add_argument("--out-csv", default="", help="Output debug CSV")
    p.add_argument("--delay", type=float, default=8.0)
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--resume", action="store_true")
    p.add_argument("--start-dai", type=str, default="")
    p.add_argument("--headless", action="store_true")
    p.add_argument("--wait-captcha", type=int, default=30,
                   help="Seconds to wait for manual CAPTCHA solve on first load")
    return p.parse_args()


def to_int(v: Any) -> Optional[int]:
    if v is None: return None
    s = str(v).strip().replace(",", "")
    if not s: return None
    try: return int(float(s))
    except ValueError: return None


def read_csv(path: Path) -> List[Dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def extract_diff_from_json(data: Any) -> Tuple[Optional[int], int, str, str, str]:
    """Returns (diff_value, point_count, last_raw, method, scale_info)"""
    if not isinstance(data, dict):
        return None, 0, "", "not_dict", ""

    graph_type = str(data.get("GraphType", ""))
    graphs = data.get("Graph")
    if graphs is None:
        return None, 0, "", "no_graph_key", graph_type

    if isinstance(graphs, dict):
        graphs = [graphs]
    if not isinstance(graphs, list):
        return None, 0, "", "graph_not_list", graph_type

    for graph in graphs:
        if not isinstance(graph, dict):
            continue
        src = graph.get("src")
        if not isinstance(src, dict):
            continue

        scale_info = ""
        ya = src.get("yAxis", {})
        if isinstance(ya, dict):
            scale_info = f"yMin={ya.get('minimum')},yMax={ya.get('maximum')}"

        datas = src.get("datas")
        if datas is None:
            continue

        # Time-based: datas is array of {date, value}
        if isinstance(datas, list) and len(datas) > 0:
            last = datas[-1]
            if isinstance(last, dict):
                for key in ("value", "y", "v"):
                    val = last.get(key)
                    if val is not None:
                        try:
                            return int(round(float(val))), len(datas), json.dumps(last, ensure_ascii=False)[:200], "graph_value", scale_info
                        except (ValueError, TypeError):
                            pass

        # XY/AmChart7: datas is {p:[], g:[]}
        elif isinstance(datas, dict):
            points = datas.get("p", [])
            g_defs = datas.get("g", [])
            y_fields = [str(g["yField"]) for g in g_defs if isinstance(g, dict) and g.get("yField")]
            if not y_fields:
                y_fields = ["value", "y"]
            if isinstance(points, list) and len(points) > 0:
                last = points[-1]
                if isinstance(last, dict):
                    for yf in y_fields:
                        val = last.get(yf)
                        if val is not None:
                            try:
                                return int(round(float(val))), len(points), json.dumps(last, ensure_ascii=False)[:200], "graph_xy", scale_info
                            except (ValueError, TypeError):
                                pass

    return None, 0, "", "no_extractable_points", graph_type


def collect_all(args: argparse.Namespace) -> None:
    from datetime import date as dt_date
    today = dt_date.today().strftime("%Y%m%d")
    target_ymd = args.date or today

    if target_ymd != today:
        print(f"WARNING: Target date {target_ymd} != today {today}.")
        print(f"  Graph data is typically only available for the current business day.")
        print(f"  Past-day results may be empty or show wrong-day data.")
        print()

    out_path = Path(args.out or f"data/pscube/samples/pscube_diff_cache_{target_ymd}.json")
    out_csv = Path(args.out_csv or f"data/pscube/samples/pscube_mihara_eva_diff_debug_{target_ymd}.csv")
    input_rows = read_csv(Path(args.input))

    existing_cache: Dict[str, Any] = {}
    if args.resume and out_path.exists():
        with out_path.open("r", encoding="utf-8-sig") as f:
            raw = json.load(f)
        if isinstance(raw, dict) and "machines" in raw:
            existing_cache = {str(m.get("dai","")).zfill(4): m for m in raw["machines"]}

    results: Dict[str, Dict[str, Any]] = dict(existing_cache)
    stopped = False

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=args.headless)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
            viewport={"width": 412, "height": 915},
            locale="ja-JP",
        )
        page = context.new_page()

        captured: Dict[str, Any] = {}

        def on_response(resp):
            url = resp.url
            for ep in ["nc-m06-001.php", "nc-m06-003.php"]:
                if ep in url:
                    try:
                        body = resp.text()
                        try:
                            data = json.loads(body)
                            captured[ep] = {"status": resp.status, "data": data}
                        except json.JSONDecodeError:
                            captured[ep] = {"status": resp.status, "data": None, "body_preview": body[:200]}
                    except:
                        captured[ep] = {"status": resp.status, "data": None, "error": "read_failed"}
                    break

        page.on("response", on_response)

        first = True
        processed = 0
        skip = bool(args.start_dai)

        for row in input_rows:
            dai = str(row.get("dai", "")).zfill(4)

            if skip:
                if dai == args.start_dai.zfill(4):
                    skip = False
                else:
                    continue

            if args.limit and processed >= args.limit:
                break
            if stopped:
                break

            if args.resume and dai in existing_cache and existing_cache[dai].get("fetchStatus") == "ok":
                print(f"  [SKIP] {dai}: already cached with diff={existing_cache[dai].get('estimatedDiffBalls','?')}")
                continue

            captured.clear()
            page_url = row.get("url", "")
            if not page_url:
                results[dai] = {"dai": dai, "fetchStatus": "url_missing"}
                continue

            print(f"  [{processed+1}] Fetching {dai}...", end=" ", flush=True)

            try:
                resp = page.goto(page_url, wait_until="networkidle", timeout=45000)
                status = resp.status if resp else 0
            except Exception as e:
                try:
                    page.wait_for_timeout(5000)
                    resp = page.goto(page_url, wait_until="load", timeout=45000)
                    status = resp.status if resp else 0
                except Exception as e2:
                    results[dai] = {"dai": dai, "fetchStatus": "navigation_error", "error": str(e2)[:200]}
                    print(f"NAV_ERROR: {e2}")
                    continue

            if first and not args.headless:
                print(f"\n  Page loaded (status={status}). Waiting {args.wait_captcha}s for CAPTCHA if needed...")
                page.wait_for_timeout(args.wait_captcha * 1000)
                first = False
            else:
                page.wait_for_timeout(3000)

            if status in (429, 451, 1015):
                results[dai] = {"dai": dai, "fetchStatus": f"blocked_{status}"}
                print(f"BLOCKED ({status})")
                stopped = True
                break

            entry: Dict[str, Any] = {
                "dai": dai,
                "machine": row.get("machine", ""),
                "totalStarts": to_int(row.get("totalStarts")) or 0,
                "jackpot": to_int(row.get("jackpot")) or 0,
                "url": page_url,
            }

            # Check nc-m06-001.php
            m01 = captured.get("nc-m06-001.php", {})
            if m01.get("data"):
                diff, pcount, last_raw, method, scale = extract_diff_from_json(m01["data"])
                entry["m06_001_status"] = m01.get("status")
                entry["graphPointCount"] = pcount
                entry["graphMethod"] = method
                if diff is not None:
                    entry["estimatedDiffBalls"] = diff
                    entry["diffBallsConfidence"] = "raw_graph_json"
                    entry["graphEndpoint"] = "nc-m06-001.php"
                    entry["graphLastPoint"] = last_raw
                    entry["graphScale"] = scale

                # Check YMD_biz in response
                ymd = m01["data"].get("YMD_biz")
                if ymd:
                    entry["responseYmdBiz"] = ymd
                    if str(ymd) != target_ymd:
                        entry["ymdMismatch"] = True
            elif m01:
                entry["m06_001_status"] = m01.get("status")
                entry["m06_001_body"] = m01.get("body_preview", "")[:100]

            # Check nc-m06-003.php
            m03 = captured.get("nc-m06-003.php", {})
            if m03.get("data") and "estimatedDiffBalls" not in entry:
                diff3, pcount3, last3, method3, scale3 = extract_diff_from_json({"Graph": m03["data"].get("Graph"), "GraphType": "xy"})
                if diff3 is not None:
                    entry["estimatedDiffBalls"] = diff3
                    entry["diffBallsConfidence"] = "raw_graph_json"
                    entry["graphEndpoint"] = "nc-m06-003.php"
                    entry["graphPointCount"] = pcount3
                    entry["graphLastPoint"] = last3
                    entry["graphScale"] = scale3

            # Also try extracting from AmCharts DOM
            if "estimatedDiffBalls" not in entry:
                try:
                    dom_diff = page.evaluate("""() => {
                        if (typeof AmCharts !== 'undefined' && AmCharts.charts) {
                            for (const chart of AmCharts.charts) {
                                if (chart.dataProvider && chart.dataProvider.length > 0) {
                                    const last = chart.dataProvider[chart.dataProvider.length - 1];
                                    if (last.value !== undefined) return {value: last.value, source: 'amcharts_dom'};
                                }
                            }
                        }
                        return null;
                    }""")
                    if dom_diff and dom_diff.get("value") is not None:
                        entry["estimatedDiffBalls"] = int(round(float(dom_diff["value"])))
                        entry["diffBallsConfidence"] = "amcharts_dom"
                        entry["graphEndpoint"] = "amcharts_dom"
                except:
                    pass

            entry["fetchStatus"] = "ok" if "estimatedDiffBalls" in entry else "graph_diff_missing"
            results[dai] = entry
            processed += 1

            diff_val = entry.get("estimatedDiffBalls", "N/A")
            api_status = entry.get("m06_001_status", "?")
            print(f"api={api_status} diff={diff_val} [{entry['fetchStatus']}]")

            # Check for blocking
            if api_status in (429, 451, 1015):
                print(f"  API blocked ({api_status}). Stopping.")
                stopped = True
                break

            if not stopped and processed < len(input_rows):
                time.sleep(args.delay)

        browser.close()

    # Save results
    payload = {
        "fetchType": "pscube_realtime_diff",
        "targetDate": target_ymd,
        "stoppedReason": "blocked" if stopped else "",
        "machines": [results[k] for k in sorted(results)],
    }
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    # Write debug CSV
    csv_cols = [
        "dai", "machine", "totalStarts", "jackpot", "estimatedDiffBalls",
        "diffBallsConfidence", "graphEndpoint", "graphPointCount", "graphMethod",
        "graphLastPoint", "graphScale", "fetchStatus", "m06_001_status",
        "responseYmdBiz", "ymdMismatch", "url",
    ]
    with out_csv.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=csv_cols, extrasaction="ignore")
        writer.writeheader()
        for dai in sorted(results):
            writer.writerow({c: results[dai].get(c, "") for c in csv_cols})

    # Summary
    total = len(results)
    ok = sum(1 for r in results.values() if r.get("fetchStatus") == "ok")
    blocked = sum(1 for r in results.values() if "blocked" in str(r.get("fetchStatus", "")))
    missing = total - ok - blocked
    print(f"\n=== Summary ===")
    print(f"Total: {total}, Diff OK: {ok}, Missing: {missing}, Blocked: {blocked}")
    print(f"Saved to: {out_path}, {out_csv}")


if __name__ == "__main__":
    args = parse_args()
    collect_all(args)
