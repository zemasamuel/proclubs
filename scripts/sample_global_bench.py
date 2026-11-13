#!/usr/bin/env python3
"""
Sample Pro Clubs player stats across clubs of all divisions to build
a division-weighted global benchmark for the eatmob radar chart.

Run from your machine (not the Claude sandbox — EA's API is blocked there):
  python3 scripts/sample_global_bench.py

Outputs: data/global_bench.json
"""

import urllib.request
import urllib.parse
import json
import time
import random
import statistics
import os

BASE = 'https://proclubs.ea.com/api/fc'
PLATFORM = 'common-gen5'
MATCH_SECONDS = 5400  # 90 mins

# Search terms broad enough to catch clubs across all divisions.
# Mix of common words in club names across different languages/regions.
SEARCH_TERMS = [
    'FC', 'SC', 'United', 'City', 'Real', 'Boys', 'Elite', 'Pro',
    'Club', 'Squad', 'Kings', 'Wave', 'Force', 'Blue', 'Red', 'Black',
    'Fire', 'Rising', 'Thunder', 'Stars', 'Wolves', 'Eagles', 'Lions',
    'Dragons', 'Vibes', 'Gang', 'Boyz', 'Lads', 'Ballers', 'Eleven',
]

# Division weights: most clubs live in lower divisions.
# 1=top, 6=bottom. Weights reflect approximate population distribution.
DIV_WEIGHTS = {1: 0.04, 2: 0.08, 3: 0.13, 4: 0.20, 5: 0.25, 6: 0.30}

TARGET_CLUBS = 600  # how many clubs to sample


def fetch(path, params):
    url = BASE + path + '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Referer': 'https://www.ea.com/',
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        print(f'  ERROR {url}: {e}')
        return None


def search_clubs(term):
    data = fetch('/allTimeLeaderboard/search', {
        'platform': PLATFORM,
        'clubName': term,
        'maxResultCount': 50,
    })
    if not data:
        return []
    # response is a list of club objects
    clubs = data if isinstance(data, list) else data.get('clubs', [])
    return clubs


def get_members(club_id):
    data = fetch('/members/stats', {
        'platform': PLATFORM,
        'clubId': club_id,
    })
    if not data:
        return []
    members = data if isinstance(data, list) else data.get('members', [])
    return members


def compute_stats(members):
    """Extract per-player rate stats from EA's member stats format."""
    rows = []
    for m in members:
        try:
            gp = int(m.get('gamesPlayed', 0) or 0)
            if gp < 5:
                continue  # skip low-sample players
            goals = int(m.get('goals', 0) or 0)
            assists = int(m.get('assists', 0) or 0)
            shots = int(m.get('skillshots', 0) or m.get('shots', 0) or 0)
            passes_made = int(m.get('passesMade', 0) or 0)
            pass_attempts = int(m.get('passAttempts', 0) or passes_made)
            tackles_made = int(m.get('tacklesMade', 0) or 0)
            tackle_attempts = int(m.get('tackleAttempts', 0) or tackles_made)
            # EA career stats don't have seconds; approximate from gamesPlayed
            seconds = gp * MATCH_SECONDS

            def per90(v):
                return v * MATCH_SECONDS / seconds if seconds > 0 else None

            def pct(a, b):
                return (a / b * 100) if b > 0 else None

            rows.append({
                'g90': per90(goals),
                'a90': per90(assists),
                's90': per90(shots),
                'ga90': per90(goals + assists),
                'pass': pct(passes_made, pass_attempts),
                't90': per90(tackles_made),
                'tpct': pct(tackles_made, tackle_attempts),
                'pressing_rate': per90(tackle_attempts),
                'atk_threat': per90(goals + assists + shots),
                'conv': pct(goals, max(shots, goals)),
            })
        except Exception:
            continue
    return rows


def percentiles(values, qs=(10, 25, 50, 75, 90)):
    vs = sorted(v for v in values if v is not None)
    if not vs:
        return {}
    n = len(vs)
    result = {}
    for q in qs:
        idx = (q / 100) * (n - 1)
        lo, hi = int(idx), min(int(idx) + 1, n - 1)
        result['p' + str(q)] = round(vs[lo] + (vs[hi] - vs[lo]) * (idx - lo), 3)
    result['mean'] = round(statistics.mean(vs), 3)
    result['n'] = n
    return result


def main():
    print(f'Sampling up to {TARGET_CLUBS} clubs from Pro Clubs API...')
    seen_ids = set()
    all_players = []
    club_count = 0

    for term in SEARCH_TERMS:
        if club_count >= TARGET_CLUBS:
            break
        print(f'  Searching "{term}"...')
        clubs = search_clubs(term)
        time.sleep(0.8)

        for club in clubs:
            if club_count >= TARGET_CLUBS:
                break
            cid = str(club.get('clubId') or club.get('id') or '')
            if not cid or cid in seen_ids:
                continue
            seen_ids.add(cid)

            members = get_members(cid)
            time.sleep(0.5)
            if not members:
                continue

            rows = compute_stats(members)
            if not rows:
                continue

            # Determine division for weighting
            div = int(club.get('currentDivision') or club.get('bestDivision') or 4)
            div = max(1, min(6, div))
            weight = DIV_WEIGHTS.get(div, 0.17)

            # Replicate rows proportional to weight to achieve weighted sample
            repeat = max(1, round(weight * 10))
            all_players.extend(rows * repeat)

            club_count += 1
            if club_count % 50 == 0:
                print(f'    {club_count} clubs sampled, {len(all_players)} player records so far...')

    print(f'\nTotal: {club_count} clubs, {len(all_players)} weighted player records')

    if not all_players:
        print('No data collected. Check network access.')
        return

    stats = ['g90', 'a90', 's90', 'ga90', 'pass', 't90', 'tpct', 'pressing_rate', 'atk_threat', 'conv']
    bench = {}
    for stat in stats:
        vals = [p[stat] for p in all_players if p.get(stat) is not None]
        bench[stat] = percentiles(vals)
        print(f'  {stat}: n={bench[stat].get("n")}, median={bench[stat].get("p50")}')

    out_path = os.path.join(os.path.dirname(__file__), '..', 'data', 'global_bench.json')
    with open(out_path, 'w') as f:
        json.dump({'generatedAt': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
                   'clubs': club_count, 'players': len(all_players), 'bench': bench}, f, indent=2)

    print(f'\nSaved to {os.path.abspath(out_path)}')
    print('Next step: add this file to db.js or load it separately, then update')
    print('the radar percentile function to use GLOBAL_BENCH instead of club pool.')


if __name__ == '__main__':
    main()
