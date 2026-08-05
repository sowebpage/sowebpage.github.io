---
layout: post
title:  "Pregame: Rebuilding Ball Don't Lie"
date:   2026-08-05
last_modified_at: 2026-08-05
categories: [Devlog]
pinned: false
---

A few months ago, I built [Ball Don’t Lie](https://github.com/sanchezner/bdl), a [StatMuse-inspired](https://statmuse.com) sports search engine that would allow users to query insights regarding NBA officials. Someone could ask “How many fouls does Chris Paul commit per game with Scott Foster?” and it would process that query and return a result… in theory. 

When I started building, I went in blind. I stood up ingestion, sketched taxonomies, trained an intent classifier, and poked at metric extraction before I had an idea of what a query meant or which questions the data I had could (honestly) support. Eventually, the project stalled in the middle of a query interpreter that never quite became executable. Now, I’m rebuilding it and this post will serve as the pregame: what went wrong, what design choices I’m making, and how I’ll build it so I can explain every single layer.

### What the product is

If we strip the search bar:

> It's a **closed catalog** of referee-conditioned metrics, each with a fixed meaning and SQL shape, that happens to be translatable to/from natural language.

Part of what went wrong initially was my interpretation of StatMuse in the first place. StatMuse works because answers sit on known question types, even including an "Interpreted as…" line that admits how the system read you. Ball Don't Lie is the same idea, scoped to officials: not "any NBA question," but metrics you can compute when you know who worked the game.

### What I’m not building (yet)

- Call-level attribution ("which ref called this foul"): the data I use doesn’t support it, so those asks will be refused/redirected
- Comparisons ("Brothers vs Foster"): this is deferred until a single-metric path is solid
- A big ML interpreter on day one: this is how I failed the first time

### The failure I'm not repeating

Last time, I treated a `QuerySpec` like a wishlist: it had lots of fields, defaults, and placeholders that felt like progress but weren't a runnable query. Progressive population was the right instinct, but I couldn't define what was executable vs incomplete vs out-of-scope before writing the extractors.

The rebuild is going to start from the opposite end: one honest answer for one concrete question, then a tiny catalog, then an object representing the question, then SQL. English last.

### Question Catalog (for now)

<table>
  <thead>
    <tr>
      <th></th>
      <th>Question shape</th>
      <th>Metric</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Q1</td>
      <td>Average fouls <strong>drawn</strong> by a player with a given ref</td>
      <td><code>fouls_drawn_per_game</code></td>
    </tr>
    <tr>
      <td>Q2</td>
      <td>Average fouls <strong>committed</strong> by a player with a given ref</td>
      <td><code>fouls_committed_per_game</code></td>
    </tr>
    <tr>
      <td>Q3</td>
      <td>Average FTA by a player with a given ref</td>
      <td><code>fta_per_game</code></td>
    </tr>
    <tr>
      <td>Q4</td>
      <td>Q1, but in the <strong>playoffs</strong></td>
      <td>same metric, <code>season_type=playoffs</code></td>
    </tr>
    <tr>
      <td>Q5</td>
      <td>Average combined team fouls in games a ref works</td>
      <td><code>game_total_fouls_per_game</code> (proxy)</td>
    </tr>
    <tr>
      <td>Q6</td>
      <td>Team <strong>home</strong> win rate with a given ref</td>
      <td><code>team_win_rate</code></td>
    </tr>
    <tr>
      <td>Q7</td>
      <td>Call attribution / "who called X on Y"</td>
      <td>refused</td>
    </tr>
  </tbody>
</table>

Policies baked into the product:
- Default competition: regular season, always named in the interpretation line
- Bare "fouls" with a player + ref = fouls drawn, and the interpretation says so
- "Fouls called by <ref>" = Q5, with wording rewritten to the proxy (crew-game foul totals; NOT personal whistle credit)
- FTA synonyms stay literal (FTA/free throw attempts); sayings like "getting to the line" won't be interpretable

### Intermediate representation (the real contract)

English is ambiguous and SQL is precise, so something has to sit in the middle and take responsibility for the translation. That will be the Query IR: a plain object that captures what I think you asked before any database gets touched. It contains a status, metric, subject (player/team/ref), referee (required when executable), filters (season, season_type, home_away), aggregation, and an interpretation string.

The status field is what I care most about, because it's what I got wrong last time. If it isn't executable, there will be no SQL. If it's out of scope, the app has to say why. The StatMuse-style "Interpreted as…" line is just that IR rendered in English, including forced honesty.

### Data and SQL

The source of truth is stats via [nba_api](https://github.com/swar/nba_api), normalized into Postgres in the shape you'd expect: teams, players, referees, games (with season/season type from a game log), referee assignments, player and team box scores, and fouls drawn.

An important constraint I want to address is that nba_api/stats.nba.com is unreliable from many cloud IPs, so ingestion will run where the API allows (locally), and the app will read the database.

From there, each metric will be a SQL template filled from the IR: same joins (stat line -> game -> assignment), different measures and subject grains. Nothing generates SQL on the fly to answer a question the catalog doesn't already know about; if it's not a template, it's not an answer.

### Where NLP fits (and where it doesn't)

Turning English into an IR is in fact an NLP problem, but I won't be starting this project by picking a model.

The order of work will go something like this:
1. Schema and ingest
2. Hand-built IR -> SQL -> correct numbers
3. Rule-based parsing over the paraphrase sets in the catalog
4. ML only for residual failures on a real eval set

The interpretation copy is templated straight from the IR, so it's not the free-form generation the first version leaned on. A model earns its way in later by beating the rules on cases I can actually score.

### Build order

1. Warehouse + local ingest
2. Executor: IR -> templates for Q1-Q6; Q7 refuse path
3. Thin API/CLI that takes structured IR (proves the product without English)
4. NL rules -> IR, scored on 'golden' paraphrases
5. UI last

### Why I'm rebuilding instead of reviving

I found the old repo to have useful scars in the taxonomies, the ingestion sketch, and the broken interpreter. This rebuild isn't "throw away domain knowledge", but rather refusing to port a pipeline that never had a closed metric catalog or an executable IR; I want to start fresh. I'm keeping the idea and the honesty constraints, but I won't be keeping the wishlist QuerySpec or an unused classifier as load-bearing structure.