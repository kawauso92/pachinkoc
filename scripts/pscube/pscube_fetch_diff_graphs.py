#!/usr/bin/env python3
"""
Fetch P'sCUBE graph JSON slowly and save per-machine diff-ball cache.

This is a safe helper for validation, not a bypass tool. It stops when the
site returns common block/rate-limit signals such as 429, 451, or 1015.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urljoin, urlparse
from urllib.request import Request, build_opener


BLOCK_STATUSES = {429, 451, 1015}


@dataclass
class TokenBundle:
    apikey: str
    token_i: str
    token_t: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch P'sCUBE graph diff cache.")
    parser.add_argument("--input", default="data/pscube/samples/arrow_mihara_eva_4p_20260616.csv")
    parser.add_argument("--date", default="20260616")
    parser.add_argument("--out", default="data/pscube/samples/pscube_diff_cache_20260616.json")
    parser.add_argument("--delay", type=float, default=6.0)
    parser.add_argument("--limit", type=int, default=0, help="0 means no limit.")
    parser.add_argument("--resume", action="store_true")
    return parser.parse_args()


def read_csv(path: Path) -> List[Dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def read_existing(path: Path) -> Dict[str, Dict[str, Any]]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8-sig") as f:
        raw = json.load(f)
    items: Iterable[Any]
    if isinstance(raw, dict) and "machines" in raw:
        items = raw["machines"]
    elif isinstance(raw, list):
        items = raw
    elif isinstance(raw, dict):
        return {str(k).zfill(4): v for k, v in raw.items() if isinstance(v, dict)}
    else:
        return {}
    return {str(item.get("dai", "")).zfill(4): item for item in items if isinstance(item, dict)}


def write_cache(path: Path, rows: Dict[str, Dict[str, Any]], stopped: Optional[str] = None) -> None:
    payload = {
        "fetchType": "pscube_graph_diff",
        "stoppedReason": stopped or "",
        "machines": [rows[k] for k in sorted(rows)],
    }
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def request_text(opener: Any, url: str, referer: Optional[str] = None) -> Tuple[int, str, str]:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
    }
    if referer:
        headers["Referer"] = referer
    req = Request(url, headers=headers)
    try:
        with opener.open(req, timeout=30) as res:
            body = res.read().decode("utf-8", errors="replace")
            return int(res.status), body, res.geturl()
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return int(exc.code), body, url
    except URLError as exc:
        return 0, str(exc), url


def parse_token(page_html: str) -> Optional[TokenBundle]:
    apikey_match = re.search(r"api\.apikey\s*=\s*'([^']+)'", page_html)
    token_match = re.search(r"api\.token\s*=\s*JSON\.parse\('([^']+)'\)", page_html)
    if not apikey_match or not token_match:
        return None
    try:
        token = json.loads(token_match.group(1))
    except json.JSONDecodeError:
        return None
    token_i = str(token.get("_i") or "")
    token_t = str(token.get("_t") or "")
    if not token_i or not token_t:
        return None
    return TokenBundle(apikey=apikey_match.group(1), token_i=token_i, token_t=token_t)


def endpoint_url(page_url: str, endpoint: str, dai: str, ymd: str, token: TokenBundle) -> str:
    parsed = urlparse(page_url)
    base = page_url.split("?")[0]
    params = {
        "cd_dai": dai,
        "YMD_biz": ymd,
        "apikey": token.apikey,
        "_i": token.token_i,
        "_t": token.token_t,
    }
    return urljoin(base, endpoint) + "?" + urlencode(params)


def extract_last_number(value: Any) -> Optional[float]:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        value = value.replace(",", "").strip()
        if value == "":
            return None
        try:
            return float(value)
        except ValueError:
            return None
    return None


def extract_from_graph_json(raw: Any) -> Tuple[Optional[int], str]:
    graphs = raw.get("Graph") if isinstance(raw, dict) else None
    if graphs is None:
        return None, "graph_missing"

    candidates: List[float] = []

    def inspect_datas(datas: Any) -> None:
        if isinstance(datas, list):
            for point in datas:
                if isinstance(point, dict):
                    for key in ("value", "y", "v", "差玉"):
                        n = extract_last_number(point.get(key))
                        if n is not None:
                            candidates.append(n)
        elif isinstance(datas, dict):
            # AmChart7: datas.p contains points, datas.g defines y fields.
            fields = []
            for graph in datas.get("g") or []:
                if isinstance(graph, dict) and graph.get("yField"):
                    fields.append(str(graph["yField"]))
            for point in datas.get("p") or []:
                if not isinstance(point, dict):
                    continue
                for field in fields or ("value", "y"):
                    n = extract_last_number(point.get(field))
                    if n is not None:
                        candidates.append(n)

    if isinstance(graphs, list):
        for graph in graphs:
            if isinstance(graph, dict):
                src = graph.get("src") or {}
                inspect_datas(src.get("datas"))
    elif isinstance(graphs, dict):
        src = graphs.get("src") or graphs
        inspect_datas(src.get("datas"))

    if not candidates:
        return None, "graph_points_missing"
    return int(round(candidates[-1])), "raw_graph_json"


def fetch_one(opener: Any, row: Dict[str, str], ymd: str) -> Dict[str, Any]:
    dai = str(row.get("dai", "")).zfill(4)
    page_url = row.get("url") or ""
    if not page_url:
        return {"dai": dai, "fetchStatus": "url_missing"}

    status, html, final_url = request_text(opener, page_url)
    if status in BLOCK_STATUSES or "1015" in html:
        return {"dai": dai, "fetchStatus": f"blocked_{status or 1015}", "stop": True}
    if status != 200:
        return {"dai": dai, "fetchStatus": f"page_http_{status}"}
    token = parse_token(html)
    if not token:
        return {"dai": dai, "fetchStatus": "token_missing"}

    for endpoint in ("nc-m06-001.php", "nc-m06-003.php"):
        graph_url = endpoint_url(final_url, endpoint, dai, ymd, token)
        status, body, _ = request_text(opener, graph_url, referer=final_url)
        if status in BLOCK_STATUSES or "1015" in body:
            return {
                "dai": dai,
                "fetchStatus": f"blocked_{status or 1015}",
                "graphEndpoint": endpoint,
                "stop": True,
            }
        if status != 200:
            continue
        try:
            raw = json.loads(body)
        except json.JSONDecodeError:
            continue
        diff, confidence = extract_from_graph_json(raw)
        if diff is not None:
            return {
                "dai": dai,
                "fetchStatus": "ok",
                "estimatedDiffBalls": diff,
                "diffBallsConfidence": confidence,
                "graphEndpoint": endpoint,
                "url": page_url,
            }

    return {"dai": dai, "fetchStatus": "graph_diff_missing", "url": page_url}


def main() -> int:
    args = parse_args()
    input_rows = read_csv(Path(args.input))
    out_path = Path(args.out)
    cache = read_existing(out_path) if args.resume else {}
    opener = build_opener()
    stopped = None
    processed = 0

    for row in input_rows:
        dai = str(row.get("dai", "")).zfill(4)
        if args.resume and dai in cache and cache[dai].get("fetchStatus") == "ok":
            continue
        if args.limit and processed >= args.limit:
            break
        result = fetch_one(opener, row, args.date)
        cache[dai] = result
        processed += 1
        write_cache(out_path, cache)
        print(json.dumps(result, ensure_ascii=False))
        if result.get("stop"):
            stopped = str(result.get("fetchStatus"))
            break
        time.sleep(max(0.0, args.delay))

    write_cache(out_path, cache, stopped)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
