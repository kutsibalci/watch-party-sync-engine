import { redis } from './redis.ts';

/**
 * Oda üyeliği ve host kuralı — TEK yerde.
 *
 * Bu bilgiyi iki servis okuyor: realtime (kaynak değişimini host'a kısıtlar) ve
 * ortak tarayıcı servisi (sayfayı kimin sürebileceğini belirler). İki ayrı
 * kopya tutmak, iki servisin farklı kişiyi host sanmasıyla biter.
 */

/** Bu süre boyunca kalp atışı gelmeyen üye ölü sayılır. */
export const MEMBER_STALE_MS = 45_000;

export const presenceKeys = {
  members: (slug: string) => `room:${slug}:members`,
  hb: (slug: string) => `room:${slug}:hb`,
};

export type LiveMember = {
  connectionId: string;
  userId: string;
  joinedAtMs: number;
};

/**
 * Odanın host'u: EN ESKİ canlı üye, hangi instance'ta olursa olsun.
 *
 * Sıralama deterministik olduğu için her süreç aynı sonuca varır; ayrı bir
 * seçim turuna gerek yok. Eşit katılma anında connectionId ile bozuşturuyoruz.
 */
export async function currentHost(slug: string): Promise<LiveMember | null> {
  const cutoff = Date.now() - MEMBER_STALE_MS;
  const [liveIds, all] = await Promise.all([
    redis.zrangebyscore(presenceKeys.hb(slug), cutoff, '+inf'),
    redis.hgetall(presenceKeys.members(slug)),
  ]);
  const live = new Set(liveIds);

  let best: LiveMember | null = null;
  for (const [connectionId, raw] of Object.entries(all)) {
    if (!live.has(connectionId)) continue;
    let entry: { userId: string; joinedAtMs: number };
    try {
      entry = JSON.parse(raw) as { userId: string; joinedAtMs: number };
    } catch {
      continue;
    }
    const candidate: LiveMember = { connectionId, userId: entry.userId, joinedAtMs: entry.joinedAtMs };
    if (
      best === null ||
      candidate.joinedAtMs < best.joinedAtMs ||
      (candidate.joinedAtMs === best.joinedAtMs && candidate.connectionId < best.connectionId)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Host'u kısa süre önbelleğe alır.
 *
 * Ortak tarayıcıda her fare hareketi bir mesaj; her biri için Redis'e gitmek
 * saniyede onlarca gereksiz sorgu demek. Host saniyeler içinde değişmez,
 * bu pencere güvenli.
 */
const HOST_CACHE_MS = 2_000;
const hostCache = new Map<string, { at: number; host: LiveMember | null }>();

export async function cachedHost(slug: string): Promise<LiveMember | null> {
  const now = Date.now();
  const hit = hostCache.get(slug);
  if (hit && now - hit.at < HOST_CACHE_MS) return hit.host;

  const host = await currentHost(slug);
  hostCache.set(slug, { at: now, host });

  if (hostCache.size > 1_000) {
    for (const [key, entry] of hostCache) {
      if (now - entry.at > HOST_CACHE_MS) hostCache.delete(key);
    }
  }
  return host;
}
