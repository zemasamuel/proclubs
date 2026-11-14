# eatmob

Match history, EA match ratings and player stats for **Eaters** (EA SPORTS FC Clubs, club ID `56770`, platform `common-gen5`).

Live at **https://eatmob.vercel.app**

A static site: `index.html`, `styles.css`, `app.js`, and the data in `data/db.js`. No build step.

## What it shows

- **Matches** – a date strip and calendar; pick a day to see every game played that night, with scores, results, the team rating, and the night's best-rated players and scorers.
- **Match page** – score, scorers, player of the match, lineup on a pitch with EA ratings (a sub arrow and minutes played for anyone who didn't play the full game), team stat comparison, and sortable player stat tables for both clubs. Each match has a share link.
- **Insights** – player-only analysis from the saved games:
  - trophy cabinet (Golden Boot, Playmaker, Sharpshooter, Clutch, Mr Reliable and more)
  - a table with each player's role, last-10 rating sparkline, form, rating swing, points per game with and without them, and close-game rating
  - linkups (who had an assist in games where a teammate scored)
  - best five (the five regulars with the best record together)
  - a "who wins together" grid of win % for every pair of regulars

  Everything is worked out again on every visit, so roles and awards change as new games come in.
- **Squad** – four views:
  - This season: sortable table from saved matches, with position filter and search
  - Career: EA's all-time totals
  - Per 90
  - Compare: radar chart and side-by-side stat list for any number of players; values are percentile ranks within the squad
- **Player profile** – rating chart, insights, per-90 numbers, shot conversion, pass and tackle accuracy, goal involvement, results with the player, position split, squad ranking, EA career totals and a match log.
- **Stats** – club record and form, then:
  - season arc (points per game over the last 5 games)
  - record by game of the night, by number of real players, and by kind of game
  - a night-by-night table
  - per-game team stats against opponents, trends and streaks
  - time of day, EA all-time club record, records, by competition
  - a scrollable opponents list

## How the data stays up to date

EA has no official Clubs API. The site reads the same endpoints EA's own Clubs page uses
(`https://proclubs.ea.com/api/fc/...`). EA only returns a club's most recent games
(about 10 per competition), so `scripts/fetch.mjs` runs on a schedule and **adds** new games to
`data/db.js` without ever dropping old ones. History therefore starts at the first fetch.

The GitHub Action in `.github/workflows/fetch.yml` runs twice an hour (at :17 and :47), commits any new
games, and Vercel redeploys the site on each push. GitHub can start scheduled runs late or skip them,
so gaps can be longer. You can also run it by hand from the **Actions** tab.

To fetch or preview locally (Node 20+, no dependencies):

```
npm run fetch      # pull new games into data/db.js
npm run serve      # preview at http://localhost:4173
```

### If the scheduled fetch gets blocked

EA sometimes answers requests from cloud servers with `403`. If the Action fails with
"EA returned no match data", run the fetch from a home computer instead, where it works like a normal browser visit:

```
npm run fetch
git add data/db.js
git commit -m "Update match data"
git push
```

## Settings

`scripts/config.mjs` holds the club ID and platform. They can also be set with the
`EA_CLUB_ID` and `EA_PLATFORM` environment variables.

`TIME_ZONE` at the top of `app.js` (default `America/Chicago`, Central Time) sets the time zone every date and time on the site is shown in, for all visitors.

`DAY_STARTS_AT_HOUR` at the top of `app.js` (default `5`) decides which day a late game belongs to:
a game that ends at 12:17 AM is listed with the night before.

## Notes

- Ratings are EA's own match ratings, straight from the match data.
- Team stats on a match page add up human players only. EA does not report possession, goal times, sub direction or AI teammates.
- Club crests load through a small proxy (`eatmob-crests.zemasamuel.workers.dev`) in front of EA's image server.
- eatmob is a fan project and is not affiliated with EA or anyone else.