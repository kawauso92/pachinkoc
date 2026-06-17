# P'sCUBE Mihara Eva Analysis Script Notes

## Scope

Script:

`scripts/pscube_mihara_eva_analysis.py`

Inputs:

- `arrow_mihara_eva_4p_20260616.csv`
- optional `pscube_history_cache_20260616.json`
- optional `appa_masters_response.json`

Outputs:

- `pscube_mihara_eva_analysis_20260616.csv`
- `pscube_mihara_eva_analysis_20260616.xlsx`
- `pscube_mihara_eva_analysis_20260616_summary.json`

## AppA/Appa Formula Reuse

The script reuses the appa formula shape found in:

`pachinkoa_v7/index.html`

Relevant formulas:

```text
border = hatsua / (heikin * heiren / 250)
expectedHourly = (heikin * jikan / total - 250 * jikan / rotationRate) * (100 / kokan)
```

The appa master URL was available and returned the registered specs:

- `エヴァ`: hatsua 319.7, heikin 1167, heiren 4.06, total 78.675, jikan 220, total1R 9.436
- `エヴァ17`: hatsua 349.9, heikin 964, heiren 5.38, total 65.005, jikan 220, total1R 9.433
- `美原`: kokan 28

## Important Limitation

Appa's exact rotation-rate calculation requires actual used balls:

```text
rotationRate = normalKaiten / (totalUsedBalls / 250)
totalUsedBalls = cashInvestmentBalls + savedBallInvestment + hitBalls - recoveryBalls
```

P'sCUBE batch data does not provide investment balls or recovery balls directly. Therefore, the script only calculates rotation/expected hourly when `estimatedDiffBalls` exists, and even then it uses an explicit approximation:

```text
grossBallsApprox = max(maxPayout, initialHits * heikin * heiren)
usedBallsApprox = grossBallsApprox - estimatedDiffBalls
rotationRate = normalStarts / (usedBallsApprox / 250)
```

Rows using this formula should be treated as validation candidates, not final accounting.

## Normal Starts Logic

When rendered target-date history is available:

1. Sort `#tblHISTb tr` by bonusId ascending.
2. Treat `初当り` as normal-time hit candidates.
3. Treat `継続` as support/ST/time-short hit candidates.
4. Split rows into chains beginning at `初当り`.
5. Estimate normal starts:

```text
normalBase = sum(game where status includes 初)
continuationSupport = sum(game where status includes 継続)
finalSupportCandidates =
  if last chain has continuation: [ST]
  else: [timeShort, ST]
normalStarts = normalBase + max(0, finalStarts - finalSupportCandidate)
```

If final support has multiple candidates, the script outputs min/mid/max.

## Target-Date Issue Found

On 2026-06-17, P'sCUBE had already rolled the台別 page to the new business day. The 2026-06-16 summary values appeared in the `1日前` column, but `#tblHISTb` contained current-day history only or no target-day history.

The script rejects mixed-date history by checking whether the rendered table's current-day `累計スタート` matches the input CSV `totalStarts`. If it does not match, the row becomes:

```text
fetchStatus = history_not_available_for_past_date
confidence = D
rankingEligible = FALSE
```

This is why the generated 2026-06-16 ranking has no eligible rows. The script itself is ready, but target-day history must be cached before P'sCUBE rolls to the next day, or obtained from a verified target-date JSON source.

## Current Validation Result

For `arrow_mihara_eva_4p_20260616.csv`:

- target rows: 38
- target-date history success: 0
- D rows: 36
- A rows: 2, both jackpot 0 / no support deduction needed
- rankingEligible: 0
- estimatedDiffBalls present: 8

Conclusion:

The generated workbook is structurally valid, but the ranking is intentionally empty because target-date histories were unavailable at verification time. For production, appc should cache histories on the same business day before rollover, with fetchStatus preserved.
