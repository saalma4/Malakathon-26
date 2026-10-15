import fs from 'node:fs';
import path from 'node:path';
import type { Market } from '../config/markets';
import { listProviderTemplates, providerKey } from '../vision/providerTemplate';

/**
 * Betsson Casino catalog: the game studios (providers) and their games, from
 * the same public API the lobby uses (no login). Cached for a few hours in
 * .cache/catalog-<market>.json.
 */

export interface CatalogGame {
  id: string;
  name: string;
  slug: string;
  /** Studio name as Betsson shows it ("Pragmatic Play"). */
  studio: string;
  /** Game page, opened in play-for-fun mode (no real money). */
  url: string;
  thumbnail?: string;
}

export interface CatalogProvider {
  /** Matches its template: templates/<name>.png. */
  key: string;
  name: string;
  /** Slots playable for fun. */
  games: number;
}

interface RawStudio {
  id: string;
  name: string;
}
interface RawGame {
  id: string;
  name: string;
  slug: string;
  gameStudio?: string;
  provider?: string;
  primaryType?: string;
  isAvailableForFun?: boolean;
  content?: { thumbnail?: { url?: string } };
}
interface Catalog {
  fetchedAt: number;
  studios: RawStudio[];
  games: RawGame[];
}

const TTL_MS = 6 * 3600_000;
const loading = new Map<string, Promise<Catalog>>();

async function api<T>(market: Market, route: string): Promise<T> {
  const c = market.catalog!;
  const res = await fetch(new URL(route, market.baseUrl), {
    headers: {
      accept: '*/*',
      'accept-language': market.locale,
      'content-type': 'application/json',
      brandid: c.brandId,
      marketcode: market.id,
      'x-obg-channel': 'Web',
      'x-obg-country-code': c.countryCode,
      'x-obg-device': 'Desktop',
      'x-obg-jurisdiction': c.jurisdiction,
      referer: new URL('/casino', market.baseUrl).toString(),
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Catálogo de ${market.name}: ${route} respondió ${res.status}`);
  return (await res.json()) as T;
}

export function loadCatalog(market: Market): Promise<Catalog> {
  if (!market.catalog) return Promise.reject(new Error(`No hay catálogo configurado para ${market.name} (markets.ts → catalog)`));
  let p = loading.get(market.id);
  if (!p) {
    p = (async () => {
      const file = path.resolve('.cache', `catalog-${market.id}.json`);
      if (fs.existsSync(file)) {
        const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as Catalog;
        if (Date.now() - cached.fetchedAt < TTL_MS) return cached;
      }
      const [studios, games] = await Promise.all([api<RawStudio[]>(market, '/api/v1/game-studios'), api<RawGame[]>(market, '/api/v2/games')]);
      const catalog: Catalog = { fetchedAt: Date.now(), studios: studios.map(({ id, name }) => ({ id, name })), games };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(catalog));
      return catalog;
    })();
    loading.set(market.id, p);
    // Drop it after use so the cache file decides when to refresh; failures can be retried.
    p.finally(() => setTimeout(() => loading.delete(market.id), 60_000)).catch(() => undefined);
  }
  return p;
}

const isPlayableSlot = (g: RawGame) => g.primaryType === 'Slots' && g.isAvailableForFun !== false && !!g.slug;
const studioOf = (g: RawGame) => g.gameStudio ?? g.provider ?? '';

/** Every studio of the catalog with its slots playable for fun, and whether it already has a template. */
export async function listStudios(market: Market): Promise<Array<CatalogProvider & { template: boolean }>> {
  const templates = new Set(listProviderTemplates().map((t) => t.key));
  const { studios, games } = await loadCatalog(market);
  return studios
    .map((s) => ({
      key: providerKey(s.name),
      name: s.name,
      games: games.filter((g) => isPlayableSlot(g) && studioOf(g) === s.name).length,
      template: templates.has(providerKey(s.name)) || templates.has(providerKey(s.id)),
    }))
    .filter((s) => s.games > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Providers of the catalog that have a template in templates/ (only those can be tested). */
export async function listProviders(market: Market): Promise<CatalogProvider[]> {
  const templates = new Set(listProviderTemplates().map((t) => t.key));
  const { studios, games } = await loadCatalog(market);
  return studios
    .filter((s) => templates.has(providerKey(s.name)) || templates.has(providerKey(s.id)))
    .map((s) => ({ key: providerKey(s.name), name: s.name, games: games.filter((g) => isPlayableSlot(g) && studioOf(g) === s.name).length }))
    .filter((p) => p.games > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listGames(market: Market, provider: string): Promise<CatalogGame[]> {
  const key = providerKey(provider);
  const { studios, games } = await loadCatalog(market);
  const studio = studios.find((s) => providerKey(s.name) === key || providerKey(s.id) === key);
  if (!studio) return [];
  return games
    .filter((g) => isPlayableSlot(g) && studioOf(g) === studio.name)
    .map((g) => ({
      id: g.id,
      name: g.name,
      slug: g.slug,
      studio: studio.name,
      url: new URL(`${market.catalog!.slotsPath}${g.slug}?gameAction=playforfun`, market.baseUrl).toString(),
      thumbnail: g.content?.thumbnail?.url,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, market.locale));
}

/** The provider (studio) of a game, by its slug. */
export async function providerOfGame(market: Market, slug: string): Promise<string | undefined> {
  const { games } = await loadCatalog(market);
  const g = games.find((x) => x.slug === slug);
  return g ? studioOf(g) : undefined;
}
