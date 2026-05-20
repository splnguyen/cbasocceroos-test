const { getApiFootballKey } = require('./load-env');

const API_BASE = 'https://v3.football.api-sports.io';
const DEMO_FIXTURE_ID = 855750;
const DEFAULT_LEAGUE = 1;
const DEFAULT_SEASON = 2026;
const DEFAULT_TEAM = 23;

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

  const leagueRound = f.league?.round ?? '';
  const metaGroup = leagueRound.replace('Group Stage - ', 'Group ') || f.league?.name || '–';

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
    source: 'api-football',
    fetchedAt: new Date().toISOString(),
  };
}

async function resolveFixtureId(query, apiKey) {
  if (query.demo === '1' || query.demo === 'true') return String(DEMO_FIXTURE_ID);
  if (query.fixture) return String(query.fixture);

  const team = query.team || DEFAULT_TEAM;
  const season = query.season || DEFAULT_SEASON;
  const league = query.league || DEFAULT_LEAGUE;

  const liveJson = await apiGet('/fixtures', { live: 'all' }, apiKey);
  const liveList = liveJson.response ?? [];
  const ausLive = liveList.find(
    (f) => f.teams.home.id === Number(team) || f.teams.away.id === Number(team),
  );
  if (ausLive) return String(ausLive.fixture.id);

  const wcLive = liveList.find((f) => f.league?.id === Number(league));
  if (wcLive) return String(wcLive.fixture.id);

  const nextJson = await apiGet('/fixtures', { team, season, league, next: 1 }, apiKey);
  if (nextJson.response?.[0]) return String(nextJson.response[0].fixture.id);

  const lastJson = await apiGet('/fixtures', { team, season, league, last: 1 }, apiKey);
  if (lastJson.response?.[0]) return String(lastJson.response[0].fixture.id);

  return String(DEMO_FIXTURE_ID);
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

  const fixtureId = await resolveFixtureId(query, apiKey);
  const match = await loadMatch(fixtureId, apiKey);

  return {
    ok: true,
    season: Number(query.season) || DEFAULT_SEASON,
    league: Number(query.league) || DEFAULT_LEAGUE,
    ...match,
  };
}

module.exports = { fetchMatch, getApiFootballKey, DEFAULT_SEASON, DEFAULT_LEAGUE };
