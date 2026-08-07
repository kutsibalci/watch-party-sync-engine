import { Redis } from 'ioredis';
import { config } from './config.ts';
import { createLogger } from './logger.ts';

const log = createLogger('redis');

function build(name: string): Redis {
  const client = new Redis(config.REDIS_URL, {
    // Bağlantı yokken komutları sonsuza kadar biriktirme — hızlı başarısız ol
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    retryStrategy(times) {
      // Üstel geri çekilme, 2 saniyede tavan yap
      const delay = Math.min(times * 200, 2_000);
      log.warn({ attempt: times, delayMs: delay, client: name }, 'Redis yeniden bağlanıyor');
      return delay;
    },
  });

  client.on('error', (err) => log.error({ err, client: name }, 'Redis hatası'));
  client.on('ready', () => log.info({ client: name }, 'Redis hazır'));

  return client;
}

/** Genel amaçlı komut istemcisi (GET/SET/kuyruk işlemleri). */
export const redis = build('main');

/**
 * Pub/Sub için AYRI bir bağlantı gerekir: bir Redis bağlantısı SUBSCRIBE
 * moduna girdiğinde normal komut çalıştıramaz. Faz 3'te oda yayınları için
 * bu fabrikayı kullanacağız.
 */
export function createSubscriber(name = 'subscriber'): Redis {
  return build(name);
}

export async function pingRedis(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch (err) {
    log.error({ err }, 'Redis ping başarısız');
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  await redis.quit();
  log.info('Redis bağlantısı kapatıldı');
}
