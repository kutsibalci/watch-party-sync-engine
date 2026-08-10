/**
 * Ortak tarayıcı servisi.
 *
 * Ayrı bir süreç olmasının sebebi realtime servisiyle aynı: bu servis
 * STATEFUL ve AĞIR. Oda başına bir Chrome sekmesi tutuyor, sürekli JPEG kare
 * üretiyor. Senkron motorunun yanına koysaydık bir odanın tarayıcı yükü tüm
 * odaların senkronunu etkilerdi.
 *
 * Yatay ölçeklenmez: bir odanın sayfası belirli bir süreçte yaşar. Gerçek
 * dağıtımda slug'a göre yapışkan yönlendirme (sticky routing) gerekir.
 */
import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import type { WebSocket } from 'ws';

import { config } from '../shared/config.ts';
import { createLogger } from '../shared/logger.ts';
import { consumeTicket } from '../shared/ticket.ts';
import { pingRedis, closeRedis } from '../shared/redis.ts';
import { BrowserClientMessageSchema } from '../shared/protocol.ts';
import { cachedHost } from '../shared/presence.ts';
import { sessionFor, sessions, shutdownBrowser, type BrowserSession } from './session.ts';

const logger: FastifyBaseLogger = createLogger('browser-svc');
const app = Fastify({ loggerInstance: logger, genReqId: () => crypto.randomUUID() });
const startedAt = Date.now();

await app.register(cors, {
  origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(','),
  credentials: true,
});
await app.register(websocket, { options: { maxPayload: 256 * 1024 } });

app.get('/healthz', async () => ({
  status: 'ok',
  uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  sessions: [...sessions.entries()].map(([slug, s]) => ({ slug, active: s.active })),
}));

app.get('/readyz', async (_req, reply) => {
  const cache = await pingRedis();
  return reply.status(cache ? 200 : 503).send({ status: cache ? 'ready' : 'not_ready' });
});

function send(socket: WebSocket, msg: unknown): void {
  if (socket.readyState === 1) socket.send(JSON.stringify(msg));
}

app.get('/browser', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
  void handleConnection(socket, req);
});

/**
 * Bilet doğrulanana kadar gelen mesajlar için tampon.
 *
 * Dinleyiciyi doğrulamadan SONRA bağlarsak, istemcinin `open` anında yolladığı
 * ilk mesaj (tipik olarak BROWSER_START) dinleyicisiz gelir ve sessizce
 * kaybolur - ws geç bağlanan dinleyici için mesaj biriktirmez. İlk denemede
 * tam olarak bu oldu: sayfa hiç açılmadı, tek bir hata da düşmedi.
 *
 * Sınırlı: doğrulanmamış bir bağlantı belleği şişiremesin.
 */
const PREAUTH_QUEUE_MAX = 16;

async function handleConnection(socket: WebSocket, req: FastifyRequest): Promise<void> {
  const queued: Buffer[] = [];
  let deliver: ((raw: Buffer) => void) | null = null;

  socket.on('message', (raw: Buffer) => {
    if (deliver) deliver(raw);
    else if (queued.length < PREAUTH_QUEUE_MAX) queued.push(raw);
  });

  const url = new URL(req.url, 'http://localhost');
  const ticket = url.searchParams.get('ticket');
  if (!ticket) {
    socket.close(1008, 'Bilet gerekli');
    return;
  }

  // Realtime ile AYNI bilet mekanizması: tek kullanımlık, 30 saniyelik, odaya
  // kilitli. Buradaki bilet ayrı alınır çünkü bilet tek kullanımlıktır.
  const payload = await consumeTicket(ticket);
  if (!payload) {
    socket.close(1008, 'Bilet geçersiz ya da süresi dolmuş');
    return;
  }
  const { slug, displayName, userId } = payload;

  let session: BrowserSession;
  try {
    session = sessionFor(slug);
  } catch (err) {
    send(socket, { type: 'BROWSER_ERROR', message: (err as Error).message });
    socket.close(1013, 'Kapasite dolu');
    return;
  }

  session.cancelIdleClose();
  session.viewers.add(socket);

  // Yeni gelen odanın mevcut hâlini öğrensin: sayfa çoktan açılmış olabilir.
  send(socket, { type: 'BROWSER_STATE', active: session.active, url: session.currentUrl });
  session.primeViewer(socket);

  deliver = (raw: Buffer) => {
    void onMessage(raw).catch((err) =>
      logger.warn({ err, slug }, 'Ortak tarayıcı mesajı işlenemedi'),
    );
  };
  // Doğrulama sürerken birikenleri sırayla işle.
  for (const raw of queued.splice(0)) deliver(raw);

  async function onMessage(raw: Buffer): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const result = BrowserClientMessageSchema.safeParse(parsed);
    if (!result.success) return;
    const msg = result.data;

    // Sayfayı yalnızca ODA KURUCUSU sürer; diğerleri izler.
    //
    // Sunucuda tek bir sekme var: iki kişi aynı anda tıklarsa ikisi de kaybeder.
    // Yetki kontrolü SUNUCUDA — istemcide düğmeyi gizlemek yeterli değil,
    // soket herkese açık.
    //
    // Host = odanın en eski canlı üyesi; realtime servisiyle aynı kural,
    // aynı yerden okunuyor. Kurucu çıkarsa kontrol sıradakine geçer.
    const host = await cachedHost(slug);
    if (host && host.userId !== userId) {
      // Fare/klavye sessizce yutulur: reddi her harekette geri yollamak
      // saniyede onlarca mesaj eder. Anlamlı eylemde bir kez haber veriyoruz.
      if (msg.type !== 'BROWSER_MOUSE' && msg.type !== 'BROWSER_KEY') {
        send(socket, {
          type: 'BROWSER_DENIED',
          message: 'Ortak tarayıcıyı yalnızca oda kurucusu kullanabilir',
        });
      }
      return;
    }

    switch (msg.type) {
      case 'BROWSER_START':
        await session.start(msg.url);
        session.broadcastState(displayName);
        return;
      case 'BROWSER_NAV':
        await session.navigate(msg.url);
        return;
      case 'BROWSER_MOUSE':
        await session.mouse(msg);
        return;
      case 'BROWSER_KEY':
        await session.key(msg);
        return;
      case 'BROWSER_BACK':
        await session.back();
        return;
      case 'BROWSER_FORWARD':
        await session.forward();
        return;
      case 'BROWSER_RELOAD':
        await session.reload();
        return;
      case 'BROWSER_STOP':
        await session.close();
        session.broadcastState(displayName);
        return;
    }
  }

  socket.on('close', () => {
    session.viewers.delete(socket);
    if (session.viewers.size === 0) session.scheduleIdleClose();
  });
}

const port = config.BROWSER_PORT;
await app.listen({ host: '0.0.0.0', port });
logger.info({ port }, 'Ortak tarayıcı servisi dinlemede');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      await app.close();
      await shutdownBrowser();
      await closeRedis();
      process.exit(0);
    })();
  });
}
