/**
 * Market configuration. Everything that differs between betsson.com, betsson.pe
 * (and the betsson.es dev container) lives here, never in the specs.
 * No credentials here: they come from env vars (see .env.example).
 */

export type MarketId = 'com' | 'pe' | 'es';
export type Language = 'en' | 'es';
export type AccountKind = 'funded' | 'empty';

export interface NumberFormat {
  decimal: '.' | ',';
  thousands: ',' | '.' | ' ';
}

export interface Market {
  id: MarketId;
  name: string;
  baseUrl: string;
  locale: string;
  timezoneId: string;
  language: Language;
  currency: {
    code: 'EUR' | 'PEN';
    /** Strings a player may see next to amounts. Order: most specific first. */
    symbols: string[];
  };
  numberFormat: NumberFormat;
  /** Path of a Pragmatic Play game opened in Real Play. Override with <PREFIX>_GAME_PATH. */
  gamePath: string;
  /** Key used to find assets/games/<gameKey>/ (spin button template, regions). */
  gameKey: string;
  /** Prefix for env vars: <PREFIX>_FUNDED_USER, <PREFIX>_EMPTY_PASS, <PREFIX>_PROXY... */
  envPrefix: string;
  ui: {
    acceptCookies: RegExp;
    username: RegExp;
    password: RegExp;
    loginButton: RegExp;
    /** Buttons Betsson may show before the game loads (e.g. "Play for real"). */
    realPlayButton: RegExp;
  };
  /** Words the game uses for the in-game balance / bet / win labels. */
  gameLabels: { balance: string[]; bet: string[]; win: string[]; continue: string[] };
  /** Phrases that mean "insufficient balance", per language (lower case, no accents). */
  insufficientFunds: Record<Language, string[]>;
}

const INSUFFICIENT: Record<Language, string[]> = {
  en: [
    'insufficient funds',
    'insufficient balance',
    'not enough funds',
    'not enough balance',
    'not enough money',
    'not have enough',
    'not enough credit',
    'enough funds',
    'balance is too low',
    'low balance',
    'insufficient',
  ],
  es: [
    'saldo insuficiente',
    'fondos insuficientes',
    'no tienes suficiente',
    'no tiene suficiente',
    'no dispone de saldo',
    'saldo es insuficiente',
    'saldo suficiente',
    'fondos suficientes',
    'dinero suficiente',
    'credito suficiente',
    'sin saldo',
    'insuficiente',
  ],
};

const GAME_LABELS = {
  balance: ['CREDIT', 'BALANCE', 'CREDITO', 'SALDO'],
  bet: ['BET', 'APUESTA'],
  win: ['WIN', 'GANANCIA', 'PREMIO'],
  // Splash/intro words only; generic verbs (PRESS, TAP, CLICK) also appear in live HUDs ("PRESS SPACE TO SPIN").
  continue: ['CONTINUE', 'CONTINUAR', 'START', 'EMPEZAR', 'COMENZAR'],
};

const UI_EN = {
  acceptCookies: /accept all|accept cookies|accept/i,
  username: /username|email|user/i,
  password: /password/i,
  loginButton: /^\s*(log ?in|sign ?in)\s*$/i,
  realPlayButton: /^(play|play for real|real play|log in and play|deposit and play)$/i,
};

const UI_ES = {
  acceptCookies: /aceptar todas|aceptar/i,
  username: /usuario|email|correo/i,
  password: /contrase/i,
  loginButton: /^\s*(iniciar sesi\S{1,2}n|ingresar)\s*$/i,
  realPlayButton: /^(jugar|jugar con dinero real|dinero real|ingresar y jugar)$/i,
};

export const MARKETS: Record<MarketId, Market> = {
  com: {
    id: 'com',
    name: 'betsson.com',
    baseUrl: 'https://www.betsson.com',
    locale: 'en-GB',
    timezoneId: 'Europe/Malta',
    language: 'en',
    currency: { code: 'EUR', symbols: ['€', 'EUR'] },
    numberFormat: { decimal: '.', thousands: ',' },
    gamePath: '/en/casino/game/sweet-bonanza?gameAction=play',
    gameKey: 'sweet-bonanza',
    envPrefix: 'COM',
    ui: UI_EN,
    gameLabels: GAME_LABELS,
    insufficientFunds: INSUFFICIENT,
  },
  pe: {
    id: 'pe',
    name: 'betsson.pe',
    baseUrl: 'https://www.betsson.pe',
    locale: 'es-PE',
    timezoneId: 'America/Lima',
    language: 'es',
    currency: { code: 'PEN', symbols: ['S/.', 'S/', 'PEN'] },
    numberFormat: { decimal: '.', thousands: ',' },
    gamePath: '/casino/tragamonedas/sweet-bonanza?gameAction=play',
    gameKey: 'sweet-bonanza',
    envPrefix: 'PE',
    ui: UI_ES,
    gameLabels: GAME_LABELS,
    insufficientFunds: INSUFFICIENT,
  },
  es: {
    id: 'es',
    name: 'betsson.es (dev)',
    baseUrl: 'https://www.betsson.es',
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    language: 'es',
    currency: { code: 'EUR', symbols: ['€', 'EUR'] },
    numberFormat: { decimal: ',', thousands: '.' },
    gamePath: '/casino/tragaperras-slots/bubble-up?gameAction=play',
    gameKey: 'bubble-up',
    envPrefix: 'ES',
    ui: UI_ES,
    gameLabels: GAME_LABELS,
    insufficientFunds: INSUFFICIENT,
  },
};

export function getMarket(id: MarketId): Market {
  const base = MARKETS[id];
  if (!base) throw new Error(`Unknown market "${id}"`);
  const gamePath = process.env[`${base.envPrefix}_GAME_PATH`] || base.gamePath;
  const gameKey = process.env[`${base.envPrefix}_GAME_KEY`] || base.gameKey;
  return { ...base, gamePath, gameKey };
}

export function proxyFor(id: MarketId): { server: string } | undefined {
  const server = process.env[`${MARKETS[id].envPrefix}_PROXY`];
  return server ? { server } : undefined;
}

export interface Credentials {
  username: string;
  password: string;
}

/** Reads credentials from env. Returns undefined (never throws with the value). */
export function credentialsFor(market: Market, kind: AccountKind): Credentials | undefined {
  const k = kind.toUpperCase();
  const username = process.env[`${market.envPrefix}_${k}_USER`];
  const password = process.env[`${market.envPrefix}_${k}_PASS`];
  return username && password ? { username, password } : undefined;
}
