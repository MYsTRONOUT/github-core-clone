// scenario.ts — the trial's deterministic identity and clock.
//
// The suite's checks name one viewer (the login the bearer token owns) and build every
// name from wire.ts's one seeded scenario (SCENARIO_SEED). The entry cannot ask the env who
// the viewer is, so it re-derives the scenario's users from the same seed with the same
// PRNG (FNV-1a + splitmix64 seeding, xorshift64* stream). This is the shared contract
// data, not a copy of any forge: the env's wire.ts publishes the seed and the generator.
//
// Determinism: nothing here reads a wall clock. Timestamps come from MAKEFUN_TRIAL_NOW
// (the instance's opening time, the only "now" a request may carry) plus a logical tick
// that advances once per created object, so live and replay runs agree byte for byte.

/** The scenario's fixed seed (wire.ts SCENARIO_SEED). */
export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
/** The scenario's day one, 2025-01-01T00:00:00Z, as epoch seconds. */
export const SCENARIO_EPOCH_SEC = 1_735_689_600;

const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*: the scenario's PRNG stream. */
class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function generateUsers(count: number): ScenarioUser[] {
  const rng = new Rng(scenarioSeedFor('users'));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const USERS = generateUsers(12);

/** The login the bearer token owns (wire.ts Scenario.viewer, users[0]). */
export const VIEWER: ScenarioUser = USERS[0] as ScenarioUser;
/** The scenario's teammate (users[1]). */
export const TEAMMATE: ScenarioUser = USERS[1] as ScenarioUser;
/** The scenario's stranger (users[2]): any repo under this login is 404 for the viewer. */
export const STRANGER: ScenarioUser = USERS[2] as ScenarioUser;

// ---------------------------------------------------------------- the logical clock

/** Parse MAKEFUN_TRIAL_NOW (epoch seconds, epoch millis, or ISO 8601) without Date. */
function parseTrialNow(text: string | undefined): number {
  if (text === undefined || text === '') return SCENARIO_EPOCH_SEC;
  const trimmed = text.trim();
  if (/^-?\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    if (Number.isFinite(value) && value > 0) return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
    return SCENARIO_EPOCH_SEC;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(trimmed);
  if (match === null) return SCENARIO_EPOCH_SEC;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  // Days from civil (Howard Hinnant's algorithm), then seconds.
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146097 + doe - 719468;
  return days * 86400 + hour * 3600 + minute * 60 + second;
}

const CLOCK_BASE = parseTrialNow(process.env.MAKEFUN_TRIAL_NOW);
let clockTick = 0;

/** The next logical second: the trial's now plus one tick per created object. */
export function nextTimestamp(): number {
  const value = CLOCK_BASE + clockTick;
  clockTick += 1;
  return value;
}

/** An epoch second as `YYYY-MM-DDTHH:MM:SSZ`, computed by hand (no Date). */
export function isoOf(epochSec: number): string {
  const days = Math.floor(epochSec / 86400);
  const secs = epochSec - days * 86400;
  const hour = Math.floor(secs / 3600);
  const minute = Math.floor((secs - hour * 3600) / 60);
  const second = secs - hour * 3600 - minute * 60;
  // Civil from days (Hinnant's algorithm).
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = month <= 2 ? y + 1 : y;
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}Z`;
}
