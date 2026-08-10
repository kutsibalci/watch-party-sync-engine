import type { Redis } from 'ioredis';
import type { WebSocket } from 'ws';

import { redis, createSubscriber } from '../shared/redis.ts';
import { config } from '../shared/config.ts';
import { createLogger } from '../shared/logger.ts';
import { wsActiveRooms, wsBroadcastLatency } from '../shared/metrics.ts';
import type { MediaFlags, Member, PlaybackState, ServerMessage, SourceRef } from '../shared/protocol.ts';
import { NO_MEDIA } from '../shared/protocol.ts';
import { userChannel, type UserEvent } from '../shared/media.ts';
import { currentHost, MEMBER_STALE_MS as PRESENCE_STALE_MS } from '../shared/presence.ts';

const log = createLogger('room');

/**
 * FAZ 3: Oda state'i artık SÜREÇ BELLEĞİNDE DEĞİL, REDIS'TE.
 *
 * Faz 1/2'de state `Map<slug, Room>` içindeydi. İkinci bir realtime instance'ı
 * eklendiğinde ne olduğu `docs/faz3-kirilma-oncesi.txt` içinde ölçülü olarak
 * duruyor: iki ayrı host seçildi (split-brain), versiyonlar ayrıştı, pozisyonlar
 * 8,5 saniye açıldı, sohbet ve komutlar karşı tarafa hiç ulaşmadı.
 *
 * Çözümün üç parçası var:
 *
 *  1. PAYLAŞILAN STATE — Redis HASH. Tek gerçek kaynak artık süreç değil, Redis.
 *
 *  2. ATOMİK GEÇİŞ — state okuma, pozisyon ilerletme, mutasyon, versiyon artırma
 *     ve YAYINLAMA tek bir Lua betiğinde yapılır. Bunlar ayrı komutlar olsaydı
 *     iki instance araya girip versiyonu bozabilir ya da yayınları versiyon
 *     sırasından farklı sırada gönderebilirdi.
 *
 *  3. PUB/SUB — her instance ilgilendiği odanın kanalına abone olur. Komutu
 *     ÜRETEN instance bile sonucu kanaldan alır; böylece tek bir kod yolu
 *     kalır ve "yerel yayın" ile "uzak yayın" ayrımı ortadan kalkar.
 *
 * Anahtar düzeni:
 *   room:{slug}:state    HASH  positionMs, isPlaying, playbackRate,
 *                              updatedAtServerMs, version, sourceJson
 *   room:{slug}:members  HASH  connectionId → {userId, displayName, joinedAtMs, instanceId}
 *   room:{slug}:hb       ZSET  connectionId → son görülme (ms)
 *   room:{slug}          KANAL yayınlar
 */

const STATE_TTL_SEC = 24 * 3600;
/** Bu süre boyunca kalp atışı gelmeyen üye ölü sayılır (shared/presence.ts). */
export const MEMBER_STALE_MS = PRESENCE_STALE_MS;
/** Kendi bağlantılarımızın kalp atışını bu sıklıkta yeniliyoruz. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/**
 * Presence yayınları bu pencerede birleştirilir. Kullanıcı 250 ms'lik
 * gecikmeyi fark etmez; sunucu ramp sırasındaki fırtınadan kurtulur.
 */
export const PRESENCE_COALESCE_MS = 250;

const K = {
  state: (slug: string) => `room:${slug}:state`,
  members: (slug: string) => `room:${slug}:members`,
  hb: (slug: string) => `room:${slug}:hb`,
  channel: (slug: string) => `room:${slug}`,
};

export type Connection = {
  connectionId: string;
  userId: string;
  displayName: string;
  socket: WebSocket;
  joinedAtMs: number;
  isAlive: boolean;
  lastDriftMs: number;
};

type MemberEntry = {
  userId: string;
  displayName: string;
  joinedAtMs: number;
  instanceId: string;
  media?: MediaFlags;
};

/** Kanaldan geçen mesaj zarfı. */
type Envelope =
  | { kind: 'STATE'; state: PlaybackState; byUserId: string | null; reason: string }
  | { kind: 'PRESENCE' }
  | { kind: 'CHAT'; userId: string; displayName: string; text: string; atMs: number }
  // Eşe yönlendirilmiş WebRTC sinyali. Odadaki herkese yayınlanır ama yalnızca
  // hedefin bağlı olduğu instance teslim eder; hedef başka instance'ta olabilir.
  | { kind: 'RTC'; to: string; from: string; fromName: string; payload: string };

// ============================================================== Lua betikleri

/**
 * Oda state'ini oluşturur — YALNIZCA yoksa.
 *
 * İki instance'a aynı anda ilk bağlantı gelirse ikisi de "state yok, oluştur"
 * diyebilir. `EXISTS` kontrolü ile yazma tek betikte olduğu için ikincisi
 * mevcut state'i alır; sıfırlama YAŞANMAZ.
 */
const INIT_STATE_LUA = `
local key = KEYS[1]
if redis.call('EXISTS', key) == 0 then
  redis.call('HSET', key,
    'positionMs', '0',
    'isPlaying', '0',
    'playbackRate', '1',
    'updatedAtServerMs', ARGV[1],
    'version', '1',
    'sourceJson', ARGV[2])
end
redis.call('EXPIRE', key, ARGV[3])
return redis.call('HGETALL', key)
`;

/**
 * Komut uygular: pozisyonu şu ana ilerlet → mutasyonu uygula → versiyonu artır
 * → yaz → YAYINLA. Hepsi tek atomik adımda.
 *
 * Yayının betiğin İÇİNDE olması kritik: dışarıda yapsaydık iki instance'ın
 * yayınları versiyon sırasından farklı sırada çıkabilir ve istemciler
 * "eski versiyon" diye doğru mesajı atabilirdi.
 */
const APPLY_LUA = `
local key      = KEYS[1]
local channel  = KEYS[2]
local cmd      = ARGV[1]
local now      = tonumber(ARGV[2])
local posArg   = ARGV[3]
local srcArg   = ARGV[4]
local byUser   = ARGV[5]
local reason   = ARGV[6]

if redis.call('EXISTS', key) == 0 then return nil end

local pos     = tonumber(redis.call('HGET', key, 'positionMs')) or 0
local playing = redis.call('HGET', key, 'isPlaying') == '1'
local rate    = tonumber(redis.call('HGET', key, 'playbackRate')) or 1
local updated = tonumber(redis.call('HGET', key, 'updatedAtServerMs')) or now
local version = tonumber(redis.call('HGET', key, 'version')) or 0
local source  = redis.call('HGET', key, 'sourceJson') or ''

-- Pozisyonu ÖNCE şu ana taşı, SONRA değiştir. Aksi hâlde "oynarken duraklat"
-- pozisyonu geriye alır.
if playing then
  pos = pos + (now - updated) * rate
  if pos < 0 then pos = 0 end
end
updated = now

if cmd == 'PLAY' then
  if posArg ~= '' then pos = tonumber(posArg) end
  playing = true
elseif cmd == 'PAUSE' then
  if posArg ~= '' then pos = tonumber(posArg) end
  playing = false
elseif cmd == 'SEEK' then
  pos = tonumber(posArg)
elseif cmd == 'SET_SOURCE' then
  source = srcArg
  pos = 0
  playing = false
end

version = version + 1

redis.call('HSET', key,
  'positionMs', tostring(pos),
  'isPlaying', playing and '1' or '0',
  'playbackRate', tostring(rate),
  'updatedAtServerMs', tostring(updated),
  'version', tostring(version),
  'sourceJson', source)
redis.call('EXPIRE', key, ARGV[7])

local payload = cjson.encode({
  kind = 'STATE',
  positionMs = pos,
  isPlaying = playing,
  playbackRate = rate,
  updatedAtServerMs = updated,
  version = version,
  sourceJson = source,
  byUserId = byUser,
  reason = reason
})
redis.call('PUBLISH', channel, payload)
return payload
`;

type ScriptedRedis = Redis & {
  roomInit(key: string, now: string, sourceJson: string, ttl: string): Promise<string[]>;
  roomApply(
    stateKey: string, channel: string,
    cmd: string, now: string, posArg: string, srcArg: string,
    byUser: string, reason: string, ttl: string,
  ): Promise<string | null>;
};

const r = redis as ScriptedRedis;
// defineCommand EVALSHA önbelleklemesi yapar — her çağrıda betiği ağdan
// göndermez. Sıcak yol için önemli.
redis.defineCommand('roomInit', { numberOfKeys: 1, lua: INIT_STATE_LUA });
redis.defineCommand('roomApply', { numberOfKeys: 2, lua: APPLY_LUA });

// ================================================================ Dönüşümler

function parseSource(json: string): SourceRef | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as SourceRef;
  } catch {
    return null;
  }
}

function hashToState(pairs: string[]): PlaybackState {
  const h: Record<string, string> = {};
  for (let i = 0; i < pairs.length; i += 2) h[pairs[i]!] = pairs[i + 1]!;
  return {
    source: parseSource(h.sourceJson ?? ''),
    positionMs: Number(h.positionMs ?? 0),
    isPlaying: h.isPlaying === '1',
    playbackRate: Number(h.playbackRate ?? 1),
    updatedAtServerMs: Number(h.updatedAtServerMs ?? Date.now()),
    version: Number(h.version ?? 1),
  };
}

/** Lua'nın ürettiği yayın gövdesini PlaybackState'e çevirir. */
function payloadToState(p: any): PlaybackState {
  return {
    source: parseSource(p.sourceJson ?? ''),
    positionMs: Number(p.positionMs),
    isPlaying: Boolean(p.isPlaying),
    playbackRate: Number(p.playbackRate),
    updatedAtServerMs: Number(p.updatedAtServerMs),
    version: Number(p.version),
  };
}

// ==================================================================== Hub

/**
 * Bu instance'ın yerel bağlantılarını ve Redis aboneliklerini yönetir.
 *
 * Abonelik odaya İLK yerel bağlantı gelince açılır, SON yerel bağlantı gidince
 * kapanır. Aksi hâlde her instance her odaya abone olur ve fan-out maliyeti
 * gereksiz yere instance sayısıyla çarpılır.
 */
class RoomHub {
  private readonly local = new Map<string, Map<string, Connection>>();
  private readonly subscriber = createSubscriber('room-events');
  private heartbeatTimer: NodeJS.Timeout | null = null;

  /** userId → bu instance'a bağlı o kullanıcının bağlantıları */
  private readonly byUser = new Map<string, Set<Connection>>();

  constructor() {
    this.subscriber.on('message', (channel, raw) => {
      if (channel.startsWith('user:')) {
        this.onUserMessage(channel.slice('user:'.length), raw);
        return;
      }
      const slug = channel.slice('room:'.length);
      void this.onChannelMessage(slug, raw);
    });
  }

  /**
   * Kullanıcıya özel olayları (transkod ilerlemesi) bu instance'taki
   * bağlantılarına iletir. Faz 3'teki Pub/Sub altyapısının yeniden kullanımı.
   */
  private onUserMessage(userId: string, raw: string): void {
    const conns = this.byUser.get(userId);
    if (!conns || conns.size === 0) return;

    let event: UserEvent;
    try {
      event = JSON.parse(raw) as UserEvent;
    } catch {
      return;
    }
    if (event.kind !== 'VIDEO_PROGRESS') return;

    const payload = JSON.stringify({
      type: 'VIDEO_PROGRESS',
      videoId: event.videoId,
      status: event.status,
      percent: event.percent,
      ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
    } satisfies ServerMessage);

    for (const c of conns) {
      if (c.socket.readyState === 1) c.socket.send(payload);
    }
  }

  // ------------------------------------------------------------- yaşam döngüsü

  start(): void {
    this.heartbeatTimer = setInterval(() => {
      void this.refreshHeartbeats().catch((err) =>
        log.error({ err }, 'Kalp atışı yenilenemedi'),
      );
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.subscriber.quit().catch(() => {});
  }

  localConnections(slug: string): Map<string, Connection> {
    return this.local.get(slug) ?? new Map();
  }

  localRoomCount(): number {
    return this.local.size;
  }

  localConnectionCount(): number {
    let n = 0;
    for (const m of this.local.values()) n += m.size;
    return n;
  }

  *allLocalConnections(): Generator<Connection> {
    for (const m of this.local.values()) yield* m.values();
  }

  // ------------------------------------------------------------------ katılım

  async join(slug: string, conn: Connection, fallbackSource: SourceRef | null): Promise<PlaybackState> {
    const now = Date.now();

    // State yoksa oluştur (atomik, yarışa dayanıklı)
    const pairs = await r.roomInit(
      K.state(slug),
      String(now),
      fallbackSource ? JSON.stringify(fallbackSource) : '',
      String(STATE_TTL_SEC),
    );
    const state = hashToState(pairs);

    const entry: MemberEntry = {
      userId: conn.userId,
      displayName: conn.displayName,
      joinedAtMs: conn.joinedAtMs,
      instanceId: config.INSTANCE_ID,
      media: { ...NO_MEDIA },
    };

    await redis
      .multi()
      .hset(K.members(slug), conn.connectionId, JSON.stringify(entry))
      .zadd(K.hb(slug), now, conn.connectionId)
      .expire(K.members(slug), STATE_TTL_SEC)
      .expire(K.hb(slug), STATE_TTL_SEC)
      .exec();

    // Yerel kayıt + ilk bağlantıysa kanala abone ol
    let bucket = this.local.get(slug);
    if (!bucket) {
      bucket = new Map();
      this.local.set(slug, bucket);
      await this.subscriber.subscribe(K.channel(slug));
      log.debug({ slug, instance: config.INSTANCE_ID }, 'Oda kanalına abone olundu');
    }
    bucket.set(conn.connectionId, conn);
    wsActiveRooms.set(this.local.size);

    // Kullanıcı kanalına abone ol — bu kullanıcının BU instance'taki ilk
    // bağlantısıysa. Transkod ilerlemesi buradan gelecek.
    let userConns = this.byUser.get(conn.userId);
    if (!userConns) {
      userConns = new Set();
      this.byUser.set(conn.userId, userConns);
      await this.subscriber.subscribe(userChannel(conn.userId));
    }
    userConns.add(conn);

    await this.publishPresence(slug);
    return state;
  }

  async leave(slug: string, connectionId: string): Promise<void> {
    const bucket = this.local.get(slug);
    const conn = bucket?.get(connectionId);
    bucket?.delete(connectionId);

    if (conn) {
      const userConns = this.byUser.get(conn.userId);
      userConns?.delete(conn);
      if (userConns && userConns.size === 0) {
        this.byUser.delete(conn.userId);
        await this.subscriber.unsubscribe(userChannel(conn.userId)).catch(() => {});
      }
    }

    if (bucket && bucket.size === 0) {
      this.local.delete(slug);
      await this.subscriber.unsubscribe(K.channel(slug)).catch(() => {});
      log.debug({ slug }, 'Oda kanalı aboneliği bırakıldı');
    }
    wsActiveRooms.set(this.local.size);

    await redis
      .multi()
      .hdel(K.members(slug), connectionId)
      .zrem(K.hb(slug), connectionId)
      .exec();

    await this.publishPresence(slug);
  }

  // --------------------------------------------------------------- komutlar

  async apply(
    slug: string,
    cmd: 'PLAY' | 'PAUSE' | 'SEEK' | 'SET_SOURCE',
    options: { positionMs?: number; source?: SourceRef; byUserId: string; receivedAtMs: number },
  ): Promise<void> {
    const payload = await r.roomApply(
      K.state(slug),
      K.channel(slug),
      cmd,
      String(Date.now()),
      options.positionMs === undefined ? '' : String(options.positionMs),
      options.source ? JSON.stringify(options.source) : '',
      options.byUserId,
      cmd,
      String(STATE_TTL_SEC),
    );

    if (payload === null) {
      log.warn({ slug, cmd }, 'Komut uygulanamadı: oda state\'i Redis\'te yok');
      return;
    }
    // Yayını kanaldan geri alacağız; gecikmeyi orada ölçüyoruz.
    this.pendingLatency.set(slug, options.receivedAtMs);
  }

  async chat(slug: string, msg: Omit<Extract<Envelope, { kind: 'CHAT' }>, 'kind'>): Promise<void> {
    await redis.publish(K.channel(slug), JSON.stringify({ kind: 'CHAT', ...msg }));
  }

  /** WebRTC sinyalini hedef bağlantıya ulaştırır; hedef başka instance'ta olabilir. */
  async relaySignal(
    slug: string,
    msg: Omit<Extract<Envelope, { kind: 'RTC' }>, 'kind'>,
  ): Promise<void> {
    await redis.publish(K.channel(slug), JSON.stringify({ kind: 'RTC', ...msg }));
  }

  /** Katılımcının açık medya akışlarını günceller ve odaya duyurur. */
  async setMedia(slug: string, connectionId: string, media: MediaFlags): Promise<void> {
    const raw = await redis.hget(K.members(slug), connectionId);
    if (!raw) return;
    let entry: MemberEntry;
    try {
      entry = JSON.parse(raw) as MemberEntry;
    } catch {
      return;
    }
    entry.media = media;
    await redis.hset(K.members(slug), connectionId, JSON.stringify(entry));
    await this.publishPresence(slug);
  }

  private readonly pendingLatency = new Map<string, number>();

  private async publishPresence(slug: string): Promise<void> {
    await redis.publish(K.channel(slug), JSON.stringify({ kind: 'PRESENCE' }));
  }

  // ------------------------------------------------------------- kanal girişi

  private async onChannelMessage(slug: string, raw: string): Promise<void> {
    let env: any;
    try {
      env = JSON.parse(raw);
    } catch {
      log.warn({ slug }, 'Kanaldan bozuk mesaj geldi');
      return;
    }

    if (env.kind === 'STATE') {
      const state = payloadToState(env);
      this.sendLocal(slug, {
        type: 'STATE',
        state,
        byUserId: env.byUserId || null,
        reason: env.reason,
      });

      const started = this.pendingLatency.get(slug);
      if (started !== undefined) {
        wsBroadcastLatency.observe(Date.now() - started);
        this.pendingLatency.delete(slug);
      }
      return;
    }

    if (env.kind === 'CHAT') {
      this.sendLocal(slug, {
        type: 'CHAT',
        userId: env.userId,
        displayName: env.displayName,
        text: env.text,
        atMs: env.atMs,
      });
      return;
    }

    // Sinyal yalnızca hedefin bağlı olduğu instance tarafından teslim edilir.
    if (env.kind === 'RTC') {
      const target = this.local.get(slug)?.get(env.to);
      if (target && target.socket.readyState === 1) {
        target.socket.send(JSON.stringify({
          type: 'RTC_SIGNAL',
          from: env.from,
          fromName: env.fromName,
          payload: env.payload,
        } satisfies ServerMessage));
      }
      return;
    }

    if (env.kind === 'PRESENCE') {
      this.schedulePresenceFlush(slug);
    }
  }

  /**
   * Presence yayınlarını BİRLEŞTİRİR (coalescing).
   *
   * Her katılım/ayrılmada tek tek yayın yapmak, abone her instance'ta iki
   * Redis çağrısı artı odadaki her sokete bir gönderim demekti; maliyet
   * O(katılım × instance × üye). Yük testinde 5.000 bağlantı 250 odaya
   * yayılırken yeni bağlantılar açlığa düşüyordu.
   *
   * Presence zaten "en son hâl" görünümü — ara durumları göndermenin değeri yok.
   */
  private readonly presenceTimers = new Map<string, NodeJS.Timeout>();

  private schedulePresenceFlush(slug: string): void {
    // Zaten planlanmışsa yenisini ekleme — birleştirmenin özü bu.
    if (this.presenceTimers.has(slug)) return;

    const timer = setTimeout(() => {
      this.presenceTimers.delete(slug);
      void (async () => {
        // Bu instance'ta o odadan kimse kalmadıysa iş yapma.
        if (!this.local.has(slug)) return;
        const members = await this.readMembers(slug);
        this.sendLocal(slug, { type: 'PRESENCE', members });
      })().catch((err) => log.error({ err, slug }, 'Presence yayını başarısız'));
    }, PRESENCE_COALESCE_MS);

    timer.unref();
    this.presenceTimers.set(slug, timer);
  }

  /** Yalnızca BU instance'a bağlı istemcilere gönderir. */
  private sendLocal(slug: string, message: ServerMessage): void {
    const bucket = this.local.get(slug);
    if (!bucket || bucket.size === 0) return;
    const payload = JSON.stringify(message);
    for (const conn of bucket.values()) {
      if (conn.socket.readyState === 1) conn.socket.send(payload);
    }
  }

  // -------------------------------------------------------------- presence

  /**
   * Odanın CANLI üyeleri — tüm instance'lardan.
   *
   * Kalp atışı ZSET'i sayesinde çöken bir instance'ın bıraktığı hayalet üyeler
   * listeye girmez. Bu, kuyruktaki visibility timeout ile aynı fikirdir:
   * "kim sağ" sorusunu kalp atışıyla cevaplıyoruz, çünkü bir sürecin öldüğünü
   * kimse haber vermez.
   */
  async readMembers(slug: string): Promise<Member[]> {
    const cutoff = Date.now() - MEMBER_STALE_MS;
    const [liveIds, all] = await Promise.all([
      redis.zrangebyscore(K.hb(slug), cutoff, '+inf'),
      redis.hgetall(K.members(slug)),
    ]);

    const live = new Set(liveIds);
    const entries: (MemberEntry & { connectionId: string })[] = [];
    const stale: string[] = [];

    for (const [connectionId, raw] of Object.entries(all)) {
      if (!live.has(connectionId)) {
        stale.push(connectionId);
        continue;
      }
      try {
        entries.push({ connectionId, ...(JSON.parse(raw) as MemberEntry) });
      } catch {
        stale.push(connectionId);
      }
    }

    if (stale.length > 0) {
      void redis
        .multi()
        .hdel(K.members(slug), ...stale)
        .zrem(K.hb(slug), ...stale)
        .exec()
        .catch(() => {});
      log.warn({ slug, count: stale.length }, 'Hayalet üyeler temizlendi');
    }

    // Host = EN ESKİ canlı üye, hangi instance'ta olursa olsun.
    // Sıralama deterministik olduğu için her instance aynı sonuca varır —
    // ayrı bir seçim turu gerekmez.
    entries.sort((a, b) =>
      a.joinedAtMs !== b.joinedAtMs
        ? a.joinedAtMs - b.joinedAtMs
        : a.connectionId < b.connectionId ? -1 : 1,
    );

    return entries.map((e, i) => ({
      connectionId: e.connectionId,
      userId: e.userId,
      displayName: e.displayName,
      isHost: i === 0,
      joinedAtMs: e.joinedAtMs,
      media: e.media ?? { ...NO_MEDIA },
    }));
  }

  /**
   * Host kuralı shared/presence.ts'te. Ortak tarayıcı servisi de aynı yerden
   * okuyor — iki kopya tutmak, iki servisin farklı kişiyi host sanmasıyla biter.
   */
  async isHost(slug: string, connectionId: string): Promise<boolean> {
    const host = await currentHost(slug);
    return host?.connectionId === connectionId;
  }

  /** Kendi bağlantılarımızın "hâlâ buradayım" kaydını tazeler. */
  private async refreshHeartbeats(): Promise<void> {
    const now = Date.now();
    for (const [slug, bucket] of this.local) {
      if (bucket.size === 0) continue;
      const pipeline = redis.multi();
      for (const id of bucket.keys()) pipeline.zadd(K.hb(slug), now, id);
      pipeline.expire(K.hb(slug), STATE_TTL_SEC);
      await pipeline.exec();
    }
  }

  /** Teşhis için: odanın Redis'teki ham state'i. */
  async debug(slug: string): Promise<unknown> {
    const [pairs, members] = await Promise.all([
      redis.hgetall(K.state(slug)),
      this.readMembers(slug),
    ]);
    if (Object.keys(pairs).length === 0) return null;

    const flat: string[] = [];
    for (const [k, v] of Object.entries(pairs)) flat.push(k, v);

    const local = this.local.get(slug);
    return {
      slug,
      instanceId: config.INSTANCE_ID,
      state: hashToState(flat),
      members,
      localConnections: local ? [...local.values()].map((c) => ({
        displayName: c.displayName,
        lastDriftMs: c.lastDriftMs,
      })) : [],
    };
  }
}

export const hub = new RoomHub();
