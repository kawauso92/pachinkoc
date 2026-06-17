# P'sCUBE差玉取得優先メモ 2026-06-17

## 現状

- `appc` フォルダ内で確認できた保存済み対象CSV/JSONは `2026-06-16` 分のみ。
- `arrow_mihara_eva_4p_20260616.csv` は38台中、`estimatedDiffBalls` が入っているのは8台のみ。
- 差玉ありは `0211` から `0218` の8台。P15側と `0181` から `0190`, `0219`, `0220` は差玉なし。
- 現在のP'sCUBE台別ページは `451` が返る状態のため、制限回避は行わず追加取得は停止する前提。

## 差玉の本命取得ルート

P'sCUBEの台別ページは、初期HTMLに以下を持つ。

- `api.model = 'nc-m06-001.php'`
- `api.apikey`
- `api.token._i`
- `api.token._t`

台データの主APIは `nc-m06-001.php`。グラフ追加表示は `jquery.netcube.amchart7.js` から `nc-m06-003.php` を呼ぶ。

差玉は画像やSVGの見た目から推定するより、JSONのグラフ点列から取るのが第一候補。

- `nc-m06-001.php`: `json.Graph[*].src.datas` の最終 `value`
- `nc-m06-003.php`: `json.Graph.src.datas.p` の最終点。`json.Graph.src.datas.g[*].yField` がY値フィールド

この最終Y値を `estimatedDiffBalls` として保存し、信頼度は `raw_graph_json` とする。

## 差玉と投資/回収の関係

差玉は `回収玉 - 使用玉` なので、収支の代用としては最重要。

ただし回転率は差玉だけでは一意に出ない。回転率には使用玉数が必要。

暫定式:

```text
grossBalls = max(maxPayout, initialHits * heikin * heiren)
usedBalls = grossBalls - estimatedDiffBalls
rotationRate = normalStarts / (usedBalls / 250)
```

このため、差玉が取れても `normalStarts` と `grossBalls` の推定精度が低い台は期待値信頼度を下げる。

## 追加した検証CLI

`scripts/pscube_fetch_diff_graphs.py`

用途:

- 入力CSVの `url` を1台ずつ開く
- ページ内の `api.apikey`, `_i`, `_t` を読む
- `nc-m06-001.php`, `nc-m06-003.php` を低速で取得
- グラフJSONの終点値を `pscube_diff_cache_YYYYMMDD.json` に保存
- `429`, `451`, `1015` が出たら停止

例:

```powershell
python .\scripts\pscube_fetch_diff_graphs.py --input .\arrow_mihara_eva_4p_20260616.csv --date 20260616 --out .\pscube_diff_cache_20260616.json --delay 6 --resume
```

## 分析CSV側の変更

`scripts/pscube_mihara_eva_analysis.py`

- `--diff-cache` を追加
- 入力CSVの `estimatedDiffBalls` が空なら、差玉キャッシュで補完
- 差玉ランキング `rankByEstimatedDiffBalls` は、期待値ランキング対象外でも順位を付ける
- 履歴が取れない場合でも、台一覧サマリーから広い通常回転レンジを出す
- この暫定レンジは差玉確認用で、期待値本判定では低信頼度扱い

## 次に必要なこと

1. P'sCUBEが通常表示できるタイミングで `pscube_fetch_diff_graphs.py` を低速実行する。
2. 差玉キャッシュの取得率を確認する。
3. 差玉取得率が高ければ、履歴取得より先に差玉キャッシュを主入力として分析CSVを作る。
4. 期待値ランキングは、差玉あり + 履歴あり、または通常回転レンジが狭い台だけを高信頼度にする。
