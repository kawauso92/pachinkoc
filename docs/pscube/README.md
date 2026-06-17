# P'sCUBE Pachinko Analysis Research

## Scope

- Store: ハイパーアロー美原
- P'sCUBE store ID: `c732925`
- Main sample date: `2026-06-16`
- Machines:
  - `P新世紀エヴァンゲリオン15 未来への咆哮`
  - `e新世紀エヴァンゲリオン17 はじまりのR`

This directory keeps research artifacts before appc integration. The files here are for validation and handoff only; they are not wired into the app.

## Goal

Estimate pachinko table-level metrics from P'sCUBE data:

- 差玉
- 通常回転
- 推定回転率
- 初当たり回数
- 駆け抜け回数
- 信頼度
- 期待時給

## Current Findings

- P'sCUBEの `累計スタート` は、そのまま通常回転として扱わない。
- `累計スタート` にはST/時短/電サポ中回転が含まれる可能性が高い。
- 通常回転は、台別履歴と機種スペックから推定する。
- 駆け抜け判別不能時は `normalStartsMin` / `normalStartsMid` / `normalStartsMax` でレンジ管理する。
- 差玉は `Graph[]` 配列、AmChartsデータ、またはグラフ画像から取得・推定する。
- PC/PlaywrightではP'sCUBEのAJAXがCloudflare WAFで `451` になる場合がある。
- スマホ/アプリ内表示では過去日グラフが表示されるケースがある。
- 今後はスクショ2枚セット、つまりグラフ画像 + 大当たり履歴画像から1台分を分析する検証CLIを作る予定。

## Directory Layout

- `docs/pscube/`: 調査レポートと設計メモ
- `scripts/pscube/`: 検証用CLIと収集補助スクリプト
- `data/pscube/samples/`: 最小限のCSV/XLSX/JSONサンプル
- `data/pscube/screenshots/`: 後で追加するスクショサンプル置き場

## Safety Notes

- appc本体には未統合。
- Cookie、セッション情報、Cloudflare通過後の実トークン、HAR、HTML大量キャッシュはコミットしない。
- `debug_cache/` はローカル検証用でGit管理外。
- 429/451/1015が出た場合は停止し、制限回避は行わない。

## Main Artifacts

- `pscube_normal_starts_report_20260617.md`: 累計スタートと通常回転推定の調査
- `pscube_diff_recovery_memo_20260617.md`: 差玉取得優先の設計メモ
- `pscube_diff_investigation_report_20260617.md`: 差玉取得ルートの調査
- `pscube_multi_day_graph_investigation.md`: 複数日グラフ取得の調査
- `pscube_mihara_eva_analysis_logic_20260616.md`: 2026-06-16分析ロジック

## Next Work

1. グラフ画像 + 履歴画像の2枚ワンセットから1台分の差玉・通常回転・回転率・期待時給を算出する検証CLIを作る。
2. 1台分で成功したら、4台一覧スクショ x 履歴スクショの処理へ拡張する。
3. 精度が十分ならappcへの組み込みを検討する。
