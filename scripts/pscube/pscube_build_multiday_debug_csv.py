#!/usr/bin/env python3
"""Build pscube_multi_day_diff_debug.csv from all available data sources."""

import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INPUT_CSV = ROOT / "data" / "pscube" / "samples" / "arrow_mihara_eva_4p_20260616.csv"
HISTORY_CACHE = ROOT / "data" / "pscube" / "samples" / "pscube_history_cache_20260616.json"
DIFF_CACHE_PROBE = ROOT / "data" / "pscube" / "samples" / "pscube_diff_cache_probe_20260616.json"
MULTIDAY_PROBE = ROOT / "debug_cache" / "0215_multiday_probe.json"
NETWORK_LOG = ROOT / "debug_cache" / "0215_network_full.json"
OUTPUT_CSV = ROOT / "data" / "pscube" / "samples" / "pscube_multi_day_diff_debug.csv"


def main():
    machines = []
    with open(INPUT_CSV, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            machines.append(row)

    history = {}
    if HISTORY_CACHE.exists():
        with open(HISTORY_CACHE, encoding="utf-8") as f:
            data = json.load(f)
        for m in data.get("machines", []):
            history[m["dai"]] = m

    diff_probe = {}
    if DIFF_CACHE_PROBE.exists():
        with open(DIFF_CACHE_PROBE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            for m in data:
                diff_probe[m.get("dai", "")] = m
        elif isinstance(data, dict):
            diff_probe[data.get("dai", "")] = data

    multiday = {}
    if MULTIDAY_PROBE.exists():
        with open(MULTIDAY_PROBE, encoding="utf-8") as f:
            multiday = json.load(f)

    rows = []
    for m in machines:
        dai = m["dai"]
        csv_diff = m.get("estimatedDiffBalls", "")

        h = history.get(dai, {})
        h_status = h.get("fetchStatus", "no_cache")
        h_data_rows = h.get("dataRows", [])
        h_total_starts_1day = ""
        for dr in h_data_rows:
            if len(dr) >= 3 and dr[0] == "累計スタート":
                h_total_starts_1day = dr[2]
                break

        dp = diff_probe.get(dai, {})
        dp_status = dp.get("fetchStatus", "no_probe")

        api_status = ""
        api_graph_count = ""
        api_diff_today = ""
        api_diff_1day = ""
        api_diff_2day = ""
        dom_svg_count = ""
        dom_amcharts_count = ""
        svg_estimated_diff = ""

        if dai == "0215":
            md_dom = multiday.get("dom", {})
            dom_svg_count = str(md_dom.get("svgCount", 0))
            dom_amcharts_count = str(multiday.get("amcharts", {}).get("chartCount", 0))

            for entry in multiday.get("network_api_entries", []):
                url = entry.get("url", "")
                if "nc-m06-001.php" in url:
                    api_status = str(entry.get("status", ""))
                    break

            manual = multiday.get("manual_api", {})
            if manual.get("status") == "fail":
                api_status = api_status or f"manual_{manual.get('httpStatus', '?')}"

        diff_source = ""
        diff_value = ""
        if csv_diff:
            diff_source = "csv_direct"
            diff_value = csv_diff
        elif api_diff_today:
            diff_source = "api_graph"
            diff_value = api_diff_today

        retrieval_method = "devtools_collector"
        if diff_source == "csv_direct":
            retrieval_method = "already_have"
        elif dai == "0215":
            retrieval_method = "blocked_451"

        rows.append({
            "dai": dai,
            "machine": m.get("machine", ""),
            "totalStarts": m.get("totalStarts", ""),
            "csv_diff": csv_diff,
            "api_status": api_status,
            "api_graph_count": api_graph_count,
            "api_diff_today": api_diff_today,
            "api_diff_1day_ago": api_diff_1day,
            "api_diff_2day_ago": api_diff_2day,
            "dom_svg_count": dom_svg_count,
            "dom_amcharts_count": dom_amcharts_count,
            "svg_estimated_diff": svg_estimated_diff,
            "history_cache_status": h_status,
            "history_1day_starts": h_total_starts_1day,
            "diff_probe_status": dp_status,
            "final_diff": diff_value,
            "diff_source": diff_source,
            "recommended_method": retrieval_method,
        })

    with open(OUTPUT_CSV, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "dai", "machine", "totalStarts",
            "csv_diff", "api_status", "api_graph_count",
            "api_diff_today", "api_diff_1day_ago", "api_diff_2day_ago",
            "dom_svg_count", "dom_amcharts_count", "svg_estimated_diff",
            "history_cache_status", "history_1day_starts",
            "diff_probe_status",
            "final_diff", "diff_source", "recommended_method",
        ])
        writer.writeheader()
        writer.writerows(rows)

    have = sum(1 for r in rows if r["final_diff"])
    missing = len(rows) - have
    print(f"Output: {OUTPUT_CSV}")
    print(f"Total: {len(rows)}, Have diff: {have}, Missing: {missing}")
    print(f"Recommended: Use scripts/pscube_devtools_collector.js in real browser")


if __name__ == "__main__":
    main()
