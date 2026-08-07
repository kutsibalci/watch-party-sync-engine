import type { FastifyInstance } from 'fastify';
import { pingDatabase } from '../../shared/db.ts';
import { pingRedis } from '../../shared/redis.ts';
import { metricsText, metricsContentType } from '../../shared/metrics.ts';

const startedAt = Date.now();

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Liveness — "süreç ayakta mı?"
   * Bağımlılıkları KONTROL ETMEZ. Etseydi, Postgres bir anlığına düştüğünde
   * orkestratör sağlıklı çalışan uygulamayı da yeniden başlatırdı.
   */
  app.get('/healthz', async () => ({
    status: 'ok',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  }));

  /**
   * Readiness — "istek alabilir miyim?"
   * Bağımlılıklar düşükse 503 döner; yük dengeleyici trafiği keser ama
   * süreç öldürülmez.
   */
  app.get('/readyz', async (_req, reply) => {
    const [database, cache] = await Promise.all([pingDatabase(), pingRedis()]);
    const ready = database && cache;

    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks: { database, redis: cache },
    });
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', metricsContentType);
    return metricsText();
  });
}
