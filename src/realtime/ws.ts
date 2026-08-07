import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

import { verifyAccessToken } from '../shared/jwt.ts';
import { consumeTicket } from '../shared/ticket.ts';
import { queryOne } from '../shared/db.ts';
import { config } from '../shared/config.ts';
import { createLogger } from '../shared/logger.ts';
import { ClientMessageSchema, type ServerMessage, type SourceRef } from '../shared/protocol.ts';
import { wsActiveConnections, syncDriftMs, wsJoinDuration } from '../shared/metrics.ts';
import { publicUrl } from '../shared/media.ts';
import { hub, type Connection } from './room.ts';

const log = createLogger('ws');

/** Ölü bağlantı tespiti: bu aralıkta ping at, yanıt vermeyeni kes. */
const PING_INTERVAL_MS = 30_000;
/** Basit taşma koruması: bir bağlantıdan saniyede kabul edilen komut sayısı. */
const RATE_LIMIT_PER_SEC = 30;

type RoomRow = {
  slug: string;
  name: string;
  source_type: 'hls' | 'youtube';
  youtube_video_id: string | null;
  hls_master_key: string | null;
};

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

function sendError(socket: WebSocket, code: string, message: string): void {
  send(socket, { type: 'ERROR', code, message });
}

/**
 * Oda satırı önbelleği — Faz 4 yük testinde bulunan darboğazın çözümü.
 *
 * ┌─ NASIL BULUNDU ──────────────────────────────────────────────────────────┐
 * │ 5.000 eşzamanlı bağlantıda yayın gecikmesi iyiydi (p99 = 196 ms) ama     │
 * │ HELLO gecikmesi p95 = 9,6 SANİYEYE çıktı. Yani mevcut bağlantılar        │
 * │ sağlıklıydı, YENİ bağlantılar açlığa düşüyordu — farklı bir darboğaz.    │
 * │                                                                            │
 * │ Sebep: her bağlantı bir Postgres sorgusu yapıyordu ve havuz 10            │
 * │ bağlantıyla sınırlıydı. 5.000 el sıkışma 10 kanaldan sırayla geçiyordu.  │
 * │                                                                            │
 * │ Çözüm: oda satırı bir bağlantı boyunca DEĞİŞMEZ ve odalar arası           │
 * │ paylaşılır. Kısa ömürlü önbellek, sorgu sayısını bağlantı başına birden   │
 * │ oda başına ~15 saniyede bire indiriyor.                                   │
 * │                                                                            │
 * │ NEDEN GÜVENLİ: bu satır yalnızca oda state'i Redis'te İLK kez             │
 * │ oluşturulurken kullanılır. Çalışma anındaki kaynak değişimi (SET_SOURCE)  │
 * │ Redis üzerinden gider, bu satırdan değil.                                 │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
const ROOM_CACHE_TTL_MS = 15_000;
const roomCache = new Map<string, { row: RoomRow | null; expiresAt: number }>();

async function loadRoom(slug: string): Promise<RoomRow | null> {
  const now = Date.now();
  const hit = roomCache.get(slug);
  if (hit && hit.expiresAt > now) return hit.row;

  const row = await queryOne<RoomRow>(
    `SELECT r.slug, r.name, r.source_type, r.youtube_video_id, v.hls_master_key
       FROM rooms r
       LEFT JOIN videos v ON v.id = r.current_video_id
      WHERE r.slug = $1`,
    [slug],
  );

  // Olmayan odayı da önbelleğe alıyoruz: aksi hâlde geçersiz slug'la gelen
  // istek seli her seferinde veritabanına iner (negative caching).
  roomCache.set(slug, { row, expiresAt: now + ROOM_CACHE_TTL_MS });

  // Sınırsız büyümesin — süresi geçmişleri ara sıra süpür.
  if (roomCache.size > 5_000) {
    for (const [key, entry] of roomCache) {
      if (entry.expiresAt <= now) roomCache.delete(key);
    }
  }

  return row;
}

function rowToSource(row: RoomRow): SourceRef | null {
  if (row.source_type === 'youtube' && row.youtube_video_id) {
    return { type: 'youtube', videoId: row.youtube_video_id };
  }
  if (row.source_type === 'hls' && row.hls_master_key) {
    // Veritabanında storage ANAHTARI saklanır, mutlak URL değil. URL ortama
    // göre değişir (dev/prod, farklı CDN) — veriye gömmek taşınmazlık yaratır.
    return { type: 'hls', url: publicUrl(row.hls_master_key) };
  }
  return null;
}

export function registerWebSocket(app: FastifyInstance): void {
  app.get('/ws', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    void handleConnection(socket, req);
  });
}

async function handleConnection(socket: WebSocket, req: FastifyRequest): Promise<void> {
  const query = req.query as Record<string, string | undefined>;
  const ticket = query.ticket;
  const token = query.token;
  const slug = query.room;

  // -------------------------------------------------------------- Kimlik
  //
  // Tarayıcının WebSocket API'si özel HTTP başlığı göndermeye izin vermez;
  // `Authorization: Bearer` kullanamayız. Sırrı query string'de taşımak
  // zorundayız — ama HANGİ sırrı taşıdığımız önemli.
  //
  // TERCİH EDİLEN: `?ticket=` — API'den alınan, 30 saniye yaşayan, TEK
  // KULLANIMLIK, tek odaya kilitli bilet. Query string loglara düşse bile
  // saniyeler içinde ve tek kullanımdan sonra değersizleşir.
  //
  // GERİYE DÖNÜK: `?token=` — ham JWT. 15 dakika geçerli ve tüm hesabı
  // temsil eder; loga düşerse ciddi. Test araçları için kabul ediliyor,
  // üretimde kapatılmalı.
  if (!slug || (!ticket && !token)) {
    sendError(socket, 'BAD_REQUEST', 'room ve (ticket veya token) parametreleri zorunlu');
    socket.close(1008, 'missing params');
    return;
  }

  let userId: string;
  let displayName: string;

  if (ticket) {
    const payload = await consumeTicket(ticket);
    if (!payload) {
      sendError(socket, 'UNAUTHORIZED', 'Bilet geçersiz, süresi dolmuş veya kullanılmış');
      socket.close(1008, 'bad ticket');
      return;
    }
    // Bilet TEK odaya yetkilidir. Başka odaya kullanılmaya çalışılırsa reddet.
    if (payload.slug !== slug) {
      sendError(socket, 'FORBIDDEN', 'Bilet bu oda için verilmemiş');
      socket.close(1008, 'ticket room mismatch');
      return;
    }
    userId = payload.userId;
    displayName = payload.displayName || 'Anonim';
  } else {
    try {
      const claims = await verifyAccessToken(token!);
      userId = claims.sub;
      displayName = claims.displayName || 'Anonim';
    } catch {
      sendError(socket, 'UNAUTHORIZED', 'Geçersiz veya süresi dolmuş token');
      socket.close(1008, 'unauthorized');
      return;
    }
  }

  // ---------------------------------------------------------------- Oda
  const row = await loadRoom(slug);

  if (!row) {
    sendError(socket, 'NOT_FOUND', 'Oda bulunamadı');
    socket.close(1008, 'no such room');
    return;
  }

  const conn: Connection = {
    connectionId: randomUUID(),
    userId,
    displayName,
    socket,
    joinedAtMs: Date.now(),
    isAlive: true,
    lastDriftMs: 0,
  };

  // Redis'e katıl: state'i al (yoksa oluştur), üye kaydını yaz, kanala abone ol.
  const joinStart = performance.now();
  const state = await hub.join(slug, conn, rowToSource(row));
  wsJoinDuration.observe({ phase: 'join' }, performance.now() - joinStart);
  wsActiveConnections.inc();

  log.info(
    { room: slug, userId, connectionId: conn.connectionId, instance: config.INSTANCE_ID },
    'Bağlantı açıldı',
  );

  // HELLO: istemcinin ihtiyaç duyduğu her şeyi tek mesajda ver.
  // Artımlı state göndermeye çalışmayın — tam state göndermek çok daha
  // basittir ve yeniden bağlanmayı tek bir kod yoluna indirger.
  send(socket, {
    type: 'HELLO',
    you: { userId, displayName },
    room: { slug: row.slug, name: row.name },
    state,
    members: await hub.readMembers(slug),
    serverTimeMs: Date.now(),
  });

  // --------------------------------------------------------- Hız sınırı
  let windowStart = Date.now();
  let messagesInWindow = 0;

  function rateLimited(): boolean {
    const now = Date.now();
    if (now - windowStart >= 1_000) {
      windowStart = now;
      messagesInWindow = 0;
    }
    messagesInWindow += 1;
    return messagesInWindow > RATE_LIMIT_PER_SEC;
  }

  // ------------------------------------------------------------- Mesajlar
  socket.on('message', (raw: Buffer) => {
    if (rateLimited()) {
      sendError(socket, 'RATE_LIMITED', 'Çok fazla mesaj');
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw.toString());
    } catch {
      sendError(socket, 'BAD_JSON', 'Geçersiz JSON');
      return;
    }

    const parsed = ClientMessageSchema.safeParse(parsedJson);
    if (!parsed.success) {
      sendError(socket, 'BAD_MESSAGE', parsed.error.issues[0]?.message ?? 'Geçersiz mesaj');
      return;
    }

    void handleMessage(parsed.data);
  });

  async function handleMessage(msg: import('../shared/protocol.ts').ClientMessage): Promise<void> {
    const receivedAtMs = Date.now();

    switch (msg.type) {
      // Saat senkronu. t1 = alım, t2 = gönderim. İkisini de veriyoruz ki
      // istemci sunucunun işlem süresini RTT'den düşebilsin.
      case 'PING':
        send(socket, { type: 'PONG', t0: msg.t0, t1: receivedAtMs, t2: Date.now() });
        return;

      case 'HEARTBEAT':
        conn.lastDriftMs = msg.driftMs;
        syncDriftMs.observe(Math.abs(msg.driftMs));
        return;

      case 'CHAT':
        // Sohbet de Redis üzerinden gider — gönderenin instance'ı dahil
        // herkes mesajı kanaldan alır. Tek kod yolu.
        await hub.chat(slug!, { userId, displayName, text: msg.text, atMs: Date.now() });
        return;

      case 'SET_SOURCE': {
        // Kaynak değişimi yalnızca host'un yetkisindedir. Oynat/duraklat
        // herkese açıktır (watch party'lerin doğal davranışı), ama "ne
        // izliyoruz" kararı tek elden verilmelidir.
        //
        // Host kontrolü artık REDIS'ten okunur: tüm instance'lardaki canlı
        // üyeler arasında en eski olan host'tur.
        if (!(await hub.isHost(slug!, conn.connectionId))) {
          sendError(socket, 'FORBIDDEN', 'Kaynağı yalnızca host değiştirebilir');
          return;
        }
        await hub.apply(slug!, 'SET_SOURCE', {
          source: msg.source, byUserId: userId, receivedAtMs,
        });
        return;
      }

      case 'PLAY':
        await hub.apply(slug!, 'PLAY', {
          positionMs: msg.positionMs, byUserId: userId, receivedAtMs,
        });
        return;

      case 'PAUSE':
        await hub.apply(slug!, 'PAUSE', {
          positionMs: msg.positionMs, byUserId: userId, receivedAtMs,
        });
        return;

      case 'SEEK':
        await hub.apply(slug!, 'SEEK', {
          positionMs: msg.positionMs, byUserId: userId, receivedAtMs,
        });
        return;

      default: {
        // Tüketilmemiş bir mesaj tipi kalırsa TypeScript burada derleme
        // hatası verir — protokole yeni mesaj eklemeyi unutmayı imkânsızlaştırır.
        const exhaustive: never = msg;
        void exhaustive;
      }
    }
  }

  // ------------------------------------------------------ Canlılık takibi
  socket.on('pong', () => {
    conn.isAlive = true;
  });

  // --------------------------------------------------------------- Kapanış
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;

    wsActiveConnections.dec();
    log.info(
      { room: slug, userId, connectionId: conn.connectionId, instance: config.INSTANCE_ID },
      'Bağlantı kapandı',
    );

    // Redis'ten üye kaydını sil ve herkese yeni presence yayınla.
    // Host devri buradan doğar: en eski üye gidince sıradaki otomatik host olur.
    void hub.leave(slug!, conn.connectionId).catch((err) =>
      log.error({ err, slug }, 'Ayrılma işlenemedi'),
    );
  };

  socket.on('close', cleanup);
  socket.on('error', (err) => {
    log.warn({ err, connectionId: conn.connectionId }, 'Soket hatası');
    cleanup();
  });
}

/**
 * Ölü bağlantı avcısı.
 *
 * TCP bir bağlantının koptuğunu her zaman fark etmez (kablo çekilmesi, uçak
 * modu, NAT tablosunun düşmesi). Uygulama seviyesinde ping atmazsanız bu
 * "yarı açık" bağlantılar bellekte birikir ve presence listesi yalan söyler.
 */
export function startPingLoop(): NodeJS.Timeout {
  const timer = setInterval(() => {
    for (const conn of hub.allLocalConnections()) {
      if (!conn.isAlive) {
        log.warn({ connectionId: conn.connectionId }, 'Ping yanıtsız — bağlantı kesiliyor');
        conn.socket.terminate();
        continue;
      }
      conn.isAlive = false;
      conn.socket.ping();
    }
  }, PING_INTERVAL_MS);

  timer.unref();
  return timer;
}
