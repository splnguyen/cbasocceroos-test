const { getApiFootballKey } = require('./load-env');

const API_BASE = 'https://v3.football.api-sports.io';
const DEFAULT_LEAGUE = 1; // FIFA World Cup
const DEFAULT_SEASON = 2026;
const DEFAULT_TEAM = 26; // Australia

const LIVE_STATUS = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT']);

async function apiGet(path, params, apiKey) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { 'x-apisports-key': apiKey },
  });
  const json = await res.json();
  if (!res.ok || json.errors?.length) {
    const msg = json.errors
      ? Object.values(json.errors).join('; ')
      : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

function periodLabel(short, long) {
  const map = {
    '1H': 'First Half',
    '2H': 'Second Half',
    HT: 'Half Time',
    ET: 'Extra Time',
    BT: 'Break Time',
    FT: 'Full Time',
    AET: 'AET',
    PEN: 'Penalties',
    NS: 'Not Started',
    LIVE: 'Live',
  };
  return map[short] || long || short || '–';
}

function parsePct(value) {
  if (value == null) return null;
  const n = parseInt(String(value).replace('%', ''), 10);
  return Number.isFinite(n) ? n : null;
}

function statValue(stats, type) {
  const row = stats?.find((s) => s.type === type);
  return row?.value ?? null;
}

function normalizeStatistics(homeId, awayId, statsResponse) {
  const homeStats = statsResponse?.find((s) => s.team.id === homeId)?.statistics ?? [];
  const awayStats = statsResponse?.find((s) => s.team.id === awayId)?.statistics ?? [];

  const possH = parsePct(statValue(homeStats, 'Ball Possession'));
  const possA = parsePct(statValue(awayStats, 'Ball Possession'));

  return {
    possH: possH ?? 50,
    possA: possA ?? 50,
    shots: [num(statValue(homeStats, 'Total Shots')), num(statValue(awayStats, 'Total Shots'))],
    target: [num(statValue(homeStats, 'Shots on Goal')), num(statValue(awayStats, 'Shots on Goal'))],
    corners: [num(statValue(homeStats, 'Corner Kicks')), num(statValue(awayStats, 'Corner Kicks'))],
    fouls: [num(statValue(homeStats, 'Fouls')), num(statValue(awayStats, 'Fouls'))],
  };
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeEvents(events) {
  return (events ?? []).map((ev) => ({
    time: { elapsed: ev.time?.elapsed ?? 0, extra: ev.time?.extra ?? null },
    team: { id: ev.team?.id, name: ev.team?.name },
    player: { name: ev.player?.name ?? '–' },
    assist: ev.assist?.name ? { name: ev.assist.name } : { name: null },
    type: ev.type,
    detail: ev.detail,
    comments: ev.comments ?? null,
  }));
}

function normalizeFixture(fixture, events, statistics) {
  const f = fixture;
  const home = f.teams.home;
  const away = f.teams.away;
  const goals = f.goals;
  const status = f.fixture.status;
  const stats = normalizeStatistics(home.id, away.id, statistics);

  let periodDisplay = periodLabel(status.short, status.long);
  if (status.short === 'HT') periodDisplay = 'Half Time';
  if (status.short === 'AET') periodDisplay = `AET ${goals.home}–${goals.away}`;

  // api-football returns e.g. "Group Stage - 3" — map number to letter
  const leagueRound = f.league?.round ?? '';
  const GROUP_LETTER = {'1':'A','2':'B','3':'C','4':'D','5':'E','6':'F','7':'G','8':'H','9':'I','10':'J','11':'K','12':'L'};
  const groupNum = leagueRound.match(/Group Stage - (\d+)/)?.[1];
  const metaGroup = groupNum
    ? `Group ${GROUP_LETTER[groupNum] ?? groupNum}`
    : leagueRound || f.league?.name || '–';

  return {
    fixtureId: f.fixture.id,
    home: { id: home.id, name: home.name, logo: home.logo },
    away: { id: away.id, name: away.name, logo: away.logo },
    scoreH: goals.home ?? 0,
    scoreA: goals.away ?? 0,
    elapsed: status.elapsed ?? 0,
    extra: status.extra ?? null,
    period: periodDisplay,
    isFinished: ['FT', 'AET', 'PEN'].includes(status.short),
    metaGroup,
    metaVenue: f.fixture.venue?.name ?? f.fixture.venue?.city ?? '–',
    ...stats,
    events: normalizeEvents(events),
    statusShort: status.short,
    statusLong: status.long,
    leagueId: f.league?.id,
    leagueSeason: f.league?.season,
    leagueName: f.league?.name,
    source: 'api-football',
    fetchedAt: new Date().toISOString(),
  };
}

function isWcSeason(f, league, season) {
  return (
    f.league?.id === Number(league) &&
    Number(f.league?.season) === Number(season)
  );
}

function hasTeam(f, teamId) {
  return f.teams.home.id === Number(teamId) || f.teams.away.id === Number(teamId);
}

function isInPlay(f) {
  return LIVE_STATUS.has(f.fixture?.status?.short);
}

function pickFixtureId(f) {
  return String(f.fixture.id);
}

async function resolveFixtureId(query, apiKey) {
  if (query.demo === '1' || query.demo === 'true') {
    // Look up Argentina's last match in WC 2022 — always the final
    const demoJson = await apiGet('/fixtures', {
      league: 1, season: 2022, team: 26, last: 1,
    }, apiKey);
    const demoFixture = demoJson.response?.[0];
    if (!demoFixture) throw new Error('Could not resolve 2022 WC Final fixture');
    return { fixtureId: pickFixtureId(demoFixture), resolvedAs: 'demo-2022-final' };
  }
  if (query.fixture) {
    return { fixtureId: String(query.fixture), resolvedAs: 'explicit-fixture' };
  }

  const team = Number(query.team || DEFAULT_TEAM);
  const season = Number(query.season || DEFAULT_SEASON);
  const league = Number(query.league || DEFAULT_LEAGUE);
  const wc = (f) => isWcSeason(f, league, season);

  // 1. Live Australia match in WC 2026 only (not other competitions)
  const liveJson = await apiGet('/fixtures', { live: 'all' }, apiKey);
  const liveList = (liveJson.response ?? []).filter(wc);
  const ausLive = liveList.find((f) => hasTeam(f, team));
  if (ausLive) {
    return { fixtureId: pickFixtureId(ausLive), resolvedAs: 'live-australia-wc2026' };
  }

  // 2. Any live WC 2026 match
  if (liveList[0]) {
    return { fixtureId: pickFixtureId(liveList[0]), resolvedAs: 'live-wc2026' };
  }

  // 3. Today's WC 2026 fixtures (in play or scheduled today)
  const today = new Date().toISOString().slice(0, 10);
  const todayJson = await apiGet('/fixtures', { league, season, date: today }, apiKey);
  const todayList = todayJson.response ?? [];
  const ausTodayLive = todayList.find((f) => hasTeam(f, team) && isInPlay(f));
  if (ausTodayLive) {
    return { fixtureId: pickFixtureId(ausTodayLive), resolvedAs: 'today-australia-in-play' };
  }
  const anyTodayLive = todayList.find((f) => isInPlay(f));
  if (anyTodayLive) {
    return { fixtureId: pickFixtureId(anyTodayLive), resolvedAs: 'today-wc2026-in-play' };
  }

  // 4. Next upcoming Australia fixture in WC 2026
  const nextTeamJson = await apiGet('/fixtures', { team, season, league, next: 1 }, apiKey);
  if (nextTeamJson.response?.[0]) {
    return {
      fixtureId: pickFixtureId(nextTeamJson.response[0]),
      resolvedAs: 'next-australia-wc2026',
    };
  }

  // 5. Next upcoming WC 2026 fixture (any teams)
  const nextLeagueJson = await apiGet('/fixtures', { league, season, next: 1 }, apiKey);
  if (nextLeagueJson.response?.[0]) {
    return {
      fixtureId: pickFixtureId(nextLeagueJson.response[0]),
      resolvedAs: 'next-wc2026',
    };
  }

  // 6. Most recent completed Australia WC 2026 match (pre-tournament / between matchdays)
  const lastTeamJson = await apiGet('/fixtures', { team, season, league, last: 1 }, apiKey);
  if (lastTeamJson.response?.[0]) {
    return {
      fixtureId: pickFixtureId(lastTeamJson.response[0]),
      resolvedAs: 'last-australia-wc2026',
    };
  }

  throw new Error(
    `No FIFA World Cup ${season} fixture found. Use ?demo=1 for the 2022 demo, or ?fixture=<id> for a specific match.`,
  );
}

async function loadMatch(fixtureId, apiKey) {
  const [fixtureJson, eventsJson, statsJson] = await Promise.all([
    apiGet('/fixtures', { id: fixtureId }, apiKey),
    apiGet('/fixtures/events', { fixture: fixtureId }, apiKey),
    apiGet('/fixtures/statistics', { fixture: fixtureId }, apiKey),
  ]);

  const fixture = fixtureJson.response?.[0];
  if (!fixture) throw new Error(`Fixture ${fixtureId} not found`);

  return normalizeFixture(fixture, eventsJson.response ?? [], statsJson.response ?? []);
}

async function fetchMatch(query = {}) {
  const apiKey = getApiFootballKey();
  if (!apiKey) {
    const err = new Error(
      'API_FOOTBALL_KEY is not set. Add it to .env.local (as API_FOOTBALL_KEY=your_key) or Vercel environment variables.',
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  const { fixtureId, resolvedAs } = await resolveFixtureId(query, apiKey);
  const match = await loadMatch(fixtureId, apiKey);

  return {
    ok: true,
    season: Number(query.season) || DEFAULT_SEASON,
    league: Number(query.league) || DEFAULT_LEAGUE,
    resolvedAs,
    ...match,
  };
}

module.exports = { fetchMatch, getApiFootballKey, DEFAULT_SEASON, DEFAULT_LEAGUE };
