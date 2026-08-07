/**
 * Realtime servisi — WebSocket senkron motoru (Faz 1).
 *
 * API'den AYRI bir süreç olmasının sebebi bu servisin STATEFUL olmasıdır:
 * bağlantılar ve oda state'i belirli bir instance'ın belleğinde yaşar.
 * Faz 3'teki ölçekleme problemi tam olarak bu ayrımdan doğar.
 */
import Fastify from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';

import { config } from '../shared/config.ts';
import { createLogger } from '../shared/logger.ts';
import { pingDatabase, closeDatabase } from '../shared/db.ts';
import { pingRedis, closeRedis } from '../shared/redis.ts';
import { metricsText, metricsContentType } from '../shared/metrics.ts';
import { registerWebSocket, startPingLoop } from './ws.ts';
import { hub } from './room.ts';

// Logger'ı FastifyBaseLogger olarak tipliyoruz. Somut pino tipini doğrudan
// verirsek Fastify'ın Logger generic'i özelleşir ve bu instance'ı varsayılan
// `FastifyInstance` bekleyen fonksiyonlara (registerWebSocket, eklentiler)
// geçiremeyiz.
const logger: FastifyBaseLogger = createLogger('realtime');

const app = Fastify({
  loggerInstance: logger,
  genReqId: () => crypto.randomUUID(),
});

const startedAt = Date.now();

await app.register(cors, {
  origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(','),
  credentials: true,
});

await app.register(websocket, {
  options: {
    // WebSocket çerçevesi tavanı. Sohbet 500 karakterle sınırlı; bundan
    // büyük bir çerçeve gelirse bu bir hata ya da saldırıdır.
    maxPayload: 64 * 1024,
  },
});

registerWebSocket(app);

app.get('/healthz', async () => ({
  status: 'ok',
  instanceId: config.INSTANCE_ID,
  uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  localRooms: hub.localRoomCount(),
  localConnections: hub.localConnectionCount(),
}));

app.get('/readyz', async (_req, reply) => {
  const [database, cache] = await Promise.all([pingDatabase(), pingRedis()]);
  const ready = database && cache;
  return reply
    .status(ready ? 200 : 503)
    .send({ status: ready ? 'ready' : 'not_ready', checks: { database, redis: cache } });
});

app.get('/metrics', async (_req, reply) => {
  reply.header('Content-Type', metricsContentType);
  return metricsText();
});

/**
 * Teşhis ucu: odanın Redis'teki state'i, TÜM instance'lardaki üyeler ve bu
 * instance'a bağlı istemcilerin bildirdiği sapmalar.
 *
 * Faz 3'te bu ucu iki porttan da çağırıp aynı state'i görmek, paylaşımın
 * çalıştığının en hızlı kanıtı: :8091/debug/... ve :8092/debug/...
 */
app.get('/debug/rooms/:slug', async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const info = await hub.debug(slug);
  if (!info) return reply.status(404).send({ error: 'Oda Redis\'te yok (hiç bağlantı olmamış)' });
  return info;
});

hub.start();
const pingLoop = startPingLoop();

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Kapanış başlıyor');

  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  clearInterval(pingLoop);

  // İstemcilere "yeniden bağlan" sinyali: 1012 = Service Restart.
  // Bunu göndermezseniz tarayıcılar rastgele gecikmelerle yeniden bağlanır
  // ve deploy anında sunucuya eşzamanlı bağlantı fırtınası biner.
  //
  // Bu instance'ın üyelerini Redis'ten de düşürüyoruz ki kalan instance'lar
  // hayalet üye görmesin — kalp atışının süresinin dolmasını beklemeye gerek yok.
  for (const conn of hub.allLocalConnections()) {
    if (conn.socket.readyState === 1) conn.socket.close(1012, 'server restarting');
  }

  await hub.stop();
  await app.close();
  await Promise.allSettled([closeDatabase(), closeRedis()]);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({
    port: config.REALTIME_PORT,
    host: '0.0.0.0',
    /**
     * TCP accept kuyruğu. Varsayılan 511.
     *
     * Faz 4 yük testinde bulundu: 5.000 bağlantıda HELLO gecikmesi çift
     * tepeli çıktı — p50 = 28 ms ama p95 = 8,4 SANİYE. Sunucunun olay
     * döngüsü gecikmesi yalnızca 240 ms'ti, yani süreç tıkanmıyordu.
     *
     * Saniye mertebesindeki bu değerler TCP'nin SYN yeniden iletim
     * aralıklarıyla (1s, 3s, 7s) örtüşüyor: accept kuyruğu dolduğunda çekirdek
     * yeni SYN'leri DÜŞÜRÜR, istemci zaman aşımına uğrayıp tekrar dener.
     * Uygulama bunu hiç görmez — bu yüzden metriklerde görünmüyordu.
     *
     * NOT: çekirdeğin `net.core.somaxconn` değeri bu sayıya bir tavan koyar;
     * konteynerde 4096'dır. Daha yükseği için sysctl gerekir.
     */
    backlog: 4096,
  });
  app.log.info({ port: config.REALTIME_PORT, backlog: 4096 }, 'Realtime servisi dinlemede');
} catch (err) {
  app.log.fatal({ err }, 'Realtime başlatılamadı');
  process.exit(1);
}
