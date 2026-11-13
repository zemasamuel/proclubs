# eatmob

Match history, EA match ratings and player stats for **Eaters** (EA SPORTS FC Clubs, club ID `56770`, platform `common-gen5`).

A static site: `index.html`, `styles.css`, `app.js`, and the data in `data/db.js`. No build step.

## What it shows

- **Matches** – a date strip and calendar; pick a day to see every game played that day, with scores, results and the top-rated player.
- **Match page** – score, scorers, player of the match, lineup on a pitch with EA ratings, a shot chart, team stat comparison, and full player stat tables for both clubs. Club crests come from EA's image server.
- **Squad** – sortable table, from saved matches or EA's all-time totals.
- **Player profile** – rating chart, form, per-90 numbers, shot conversion, pass and tackle accuracy, goal involvement, results with the player, position split, squad ranking, match log.
- **Stats** – club record, form, leaderboards, records, opponents.
- **Compare** – radar chart for up to 5 players on one of five stat templates (forward, midfield, defence, goalkeeper, wide). Any player can go on any template; values are percentile ranks within the squad.
- **Data** – what is saved, and a manual way to add games.

## How the data stays up to date

EA has no official Clubs API. The site reads the same endpoints EA's own Clubs page uses
(`https://proclubs.ea.com/api/fc/...`). EA only returns a club's most recent games
(about 10 per competition), so `scripts/fetch.mjs` runs on a schedule and **adds** new games to
`data/db.js` without ever dropping old ones. History therefore starts at the first fetch.

```
npm run fetch      # pull new games into data/db.js (Node 20+ required, no dependencies)
npm run serve      # preview at http://localhost:4173
```

You can also just double-click `index.html`.

## Put it on GitHub

1. Create a new **public** repository and push this folder to its `main` branch.
2. Repository **Settings → Pages → Build and deployment**: Source "Deploy from a branch", branch `main`, folder `/ (root)`.
   The site appears at `https://<your-username>.github.io/<repo-name>/`.
3. Repository **Settings → Actions → General → Workflow permissions**: choose "Read and write permissions".
4. The workflow in `.github/workflows/fetch.yml` then runs every 5 minutes and commits new games (GitHub can start a run a few minutes late when it is busy).
   Run it once by hand from the **Actions** tab to check it works.

### If the scheduled fetch gets blocked

EA sometimes answers requests from cloud servers with `403`. If the Action fails with
"EA returned no match data", run the fetch from a home computer instead, where it works like a normal browser visit:

```
npm run fetch && git add data/db.js && git commit -m "Update match data" && git push
```

Schedule that with Task Scheduler (Windows) or cron (macOS/Linux) on a PC that is on while you play.
The **Data** page of the site also lets anyone paste EA's JSON by hand; that only updates their own browser.

## Settings

`scripts/config.mjs` holds the club ID, platform and API base. They can also be set with the
`EA_CLUB_ID`, `EA_PLATFORM` and `EA_API_BASE` environment variables.

`TIME_ZONE` at the top of `app.js` (default `America/Chicago`, Central Time) sets the time zone every date and time on the site is shown in, for all visitors.

`DAY_STARTS_AT_HOUR` at the top of `app.js` (default `5`) decides which day a late game belongs to:
a game that ends at 12:17 AM is listed with the night before.

## Notes

- Ratings are EA's own match ratings, straight from the match data.
- Team stats on a match page add up human players only. EA does not report possession or AI teammates.
- eatmob is a fan project and is not affiliated with EA or anyone else.
