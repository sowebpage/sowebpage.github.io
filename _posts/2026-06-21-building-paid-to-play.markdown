---
layout: post
title:  "Building Paid to Play"
date:   2026-06-21
last_modified_at: 2026-06-21
categories: [Devlog]
pinned: false
---

I’ve been working on <span class="clickable">[this app](https://www.sanchezner.com/paid-to-play)</span> for the past two months. In this post, I’ll be talking about how I built it and why the most important decision was admitting the chart couldn’t answer the question I originally wanted it to.

At first, I wanted a scatter plot that told me “who’s overpaid, and who’s underpaid?”

The initial design was pretty simple. It was a four-quadrant chart that had an x-axis describing production and a y-axis telling us the salary. A player in the bottom right quadrant would be a “hidden gem” as they produced at a high level and didn’t cost much. A player in the top left quadrant would be a “thief” as they had a large share in the team’s cap, but didn’t produce. Hover over a player and see a ‘fair salary’ derived from a calibration curve. Two models total: one to project full-season performance and another to map that performance to a fair cap %.

What shipped is still a daily scatter of predicted BPM vs. cap %, but with a trend line instead of quadrants. It doesn’t call anyone a thief or show a fair salary. The selling metric is value vs. trend: how far a player’s cap hit sits from what the league has historically paid for that level of projected production.

This shift happened in the middle of the build and for a rather specific reason.

I’d already known salary wasn’t a function of BPM. Age, bird rights, max rules, injury histories, and more all go into the construction of a contract. What broke the original design was trying to compute fair value anyway. I built a replacement-level formula that gave a sub-replacement player a \$0 fair salary. Klay Thompson got zero. Half the league looked “correctly unpaid”, and it was my fault.

The fix wasn’t adding more features I couldn’t source. It was downgrading the claim: fit an isotonic curve on 25 years of `(BPM, cap%)` pairs and call it a historical trend, not a verdict. Same scatter, but different question: not what should this player earn? but where does this player sit relative to what the league has paid historically?

With that said, here’s how it all went.

### I started with contracts, not architecture
I didn’t start with a medallion diagram. I started with a [Basketball Reference](https://www.basketball-reference.com) (BREF) contracts page and a problem: my scraper stored player names, but BREF embeds the real ID in the href (`tatumja01`), [`nba_api`](https://github.com/swar/nba_api) uses numeric IDs, and ESPN uses display names. None of them share a key.

Luckily, I stumbled on a [Wikidata](https://www.wikidata.org) mapping from `bref_id` to `player_id`, and started building a crosswalk. Contracts came first because the whole point of the chart was salary on the y-axis. Game logs and advanced stats came next. I needed rolling windows, which meant one row per game, not season-long aggregates.

My early repo was starting to get a bit messy, so I decided on a medallion layout as it conveyed the flow of the pipeline I was building:

- **Bronze:** raw JSON in S3 from `nba_api` responses, scraped ESPN salary pages, and Basketball Reference tables.
- **Silver:** normalized Postgres tables `(players, ids, gamelogs, advanced_stats, contracts)`
- **Gold:** point-in-time feature tables for training and inference

Training data and operational data were different problems that I conflated at first. I almost pulled full `PlayerGameLogs` every day before realizing incremental ingest by `game_date` was the right decision (`bronze/gamelogs/game_date=.../response`). Historical backfill was for training, yesterday’s games only for daily runs.

It was at this point that I’d realized I needed to settle on a coherent spec and actually get the architecture laid out:

- **Rate stats, not counting stats.** For performance, I originally wanted to do something like PPG, which happens to be a counting stat. In testing, I found counting steps, while more digestible, broke the chart around ~November when game counts diverge. For that reason, I chose BPM as the stat to measure how well a player was doing, since it tells us more/less a player’s contribution to their team.
- **Projected full-season BPM, not observed-to-date.** At game 10, raw BPM is just noise; the model would shrink toward priors. At game 70, it should lean on the season. ‘Predicting’ observed BPM is just a SQL query… predicting full-season BPM actually models the stat, as it is to be a full-season statistic, not to mention an actual ML problem.
- **Milestones for training:** `[5, 10, 15, 25, 40, 60, 75]` player-games, truncated to what each player actually played. The label/target would be full-season BPM. We’d filter `(player, season)` pairs with `games_played >= 20` for *label quality*, not to drop injury-prone players from the dataset.
- **Feature-store:** At first, I wanted to use Feast as that’s what I saw in all the job descriptions. What I didn’t realize was that these companies use it because they need it. For my project, point-in-time correctness and training/serving parity mattered a lot to me. Online serving and multi-model reuse, not so much. So I opted for one model, daily batch inference. Just like the saying goes: “Keep it simple, Sanchezner” or something.
- **Time-based train/test splits.** Random splits leak: milestones from the same season share a label.
- **MLflow** to decouple training from serving.
- **Prefect over Airflow** because it is lighter, and enough for daily cron + annual retrain. Still keeping it simple.
- **Static JSON over an API** because data changes once a day, thus no WebSockets.

I was still expecting to make quadrants and a fair salary here. That part aged poorly, but these infrastructure decisions didn’t.

### The BPM model worked
With silver mostly built, I moved onto gold: `feature_snapshots` had one training row per `(player, season, milestone_n)`; every feature computed only games 1 to n for that player-season. Rolling 15-game and 40-game windows, season-to-date aggregates, prior-season stats, and metadata. Salary was explicitly excluded from the features to keep the chart axes independent.

I trained an XGBoost regressor, wired the MLflow tracking, registered `bpm-projector`, and got inference loading `models:/bpm-projector@champion`. The test RMSE landed around 1.76. Error concentrated at early milestones `(5, 10, 15)` and flattened by 40+ games, which was exactly the shrinkage I wanted the milestones to teach the model.

That part went roughly to plan. Then, I started the second model.

### The calibration model
Model 2 was supposed to draw the “fair market line” through the scatter. I didn’t have historical salary data yet, so I built a deterministic VORP-style formula: surplus value above a replacement level of -2.0 BPM, divided by a team value budget estimated from historical BPM distributions. I registered it in MLflow as `bpm-value-calculator`.

It ran, and the results were embarrassing.

Sub-replacement players got **zeroed out** completely. Klay Thompson: \$0 fair salary. The formula basically said if your projected BPM is below -2.0 you deserve nothing. If I were measuring surplus win shares, maybe, just maybe you could at least try defending this. It isn’t defensible for my chart though. The market doesn’t pay \$0 to ‘bad’ players... it paid the minimum.

So now, I had two options:

1. **Keep claiming “fair value”** and patch the formula with CBA minimum clips and more assumptions that I’d have to defend.
2. **Stop pretending** I could compute fair value and fit what the market actually did.

My hand was forced and so I chose path 2.

### No salary API
To fit a historical `(BPM, cap%)` curve, I needed 25 years of `(player, season, salary)` joined to BPM. No single (and free) source has both.

- **Current contracts:** Basketball Reference, scraped into bronze.
- **Historical salaries:** ESPN publishes paginated HTML tables dating back to 1999. I wrote a scraper with per-page caching for 350+ HTML files to `data/manual/espn_cache/` and output to `historical_salaries_raw.csv`.
- **Player identity across ESPN and BREF:** normalized names, exact match, then `rapidfuzz` with accept/flag/reject thresholds in `silver/match_espn_to_bref.py` with manual overriding for edge cases.

While doing this, I found a bug, allowing me to cut the match rate from ~61% to nearly complete: `bronze/entities.py` was calling `get_active_players()` instead of `get_players()`. Retired players never landed in the `players`/`ids` tables. I re-ran bronze and silver, re-ran the matcher, and ~12,500 player-season salary rows matched.

With this, the fix for calibration made sense: `IsotonicRegression` on historical `(full-season BPM, cap_pct)` pairs, where `cap_pct = salary / salary_cap [of that season]`. No assumptions, and it prices the whole BPM range.

### The pivot
The isotonic curve worked. I could read off a `trend_cap_pct` for any BPM. The original plan was to call that “fair” and show the delta as over/underpayment, but I couldn’t defend it.

Calling the output “fair salary” implies the model knows what a player *should* earn. It doesn’t. It knows what the league has paid, on average, for that production level. So I tweaked a few (many) things to make it descriptive, not prescriptive. This involved reframing to emphasize the historical league trend. Instead of a normative verdict, I’d give a descriptive gap from aggregate market behavior.

Now, a player above the line isn’t a thief. They might be on a max deal signed before an MVP run. A player below isn’t necessarily a gem. They might just be on a rookie-scale contract. The chart shows distance from the historical norm.

This pivot cost me the punchy quadrant labels, but gave me a project I can be proud of and explain honestly.

### Serving without an API
With both models championed, I needed to get data to a browser. I very well could’ve used Next.js and FastAPI, but I didn’t need all of that. So I chose to batch JSON writes to `frontend/public/data/`, and React would fetch on page load.

`serving/snapshot.py` loads both `@champion` models, pulls the latest prediction per player from Postgres, merges contracts for salary/cap %, computes `delta_from_trend`, and writes three files:

- `players.json`: current snapshot and display stats
- `trend_curve.json`: the dashed line
- `history.json`: per-game pBPM series for the trajectory chart

No API or WebSockets. It deploys as static files, and the daily pipeline refreshes them after scoring.

### The post-season gap
I got done building this during the offseason and almost shipped without the feature the project was named for in daily inferences throughout the season.

Training uses milestones, up to 7 snapshots per player-season at fixed game counts. Inference needs to update every day, one row per game played. Same rolling-window feature logic, but different table: `inference_features` with PK `(nba_id, season, game_number)`.

`predictions` mirrors that grain. One row per game, append-only, anti-join so backfill and daily are the same operation. The frontend reads the latest game per player for the scatter and the full series for the history chart.

I backfilled the current season: 26,645 inference rows, 26,645 predictions, 428 players in JSON. Second run inserted zero (hooray idempotency). Offseason daily run no-ops cleanly as well (“No new games for yesterday”).

### Two speeds: daily inference and annual retrain
I realized it might be confusing about what runs when.

Daily (in-season): frozen `@champion` models. Fresh gamelogs -> `inference_features` -> score unscored rows -> refresh JSON. No retraining. The model doesn’t get new full-season BPM labels until the season ends.

Annual (Summer): rebuild `feature_snapshots`, train BPM projector, ingest new contracts, train trend model, run promotion gates. BPM promotes only if `test_rmse` beats the previous. Trend always promotes; it’s a descriptive fit, not a predictive competition. Retrain after the draft when new salaries kick in and free agency is coming to an end, not in May.

Prefect flows: `daily_flow` at 6AM EST, `train_flow` on August 1 at 8AM EST. I wired a Docker worker that polls Prefect Cloud and runs the daily pipeline.

### Fin
And that's that... for now at least. I've just set up a remote VM to host the daily and annual workers, but I still want to add drift monitoring (labels don’t exist until the end of the season). Many lessons learned thus far, and so many more to learn.

Until then.
