import { config } from '../shared/config.ts';
import { closeDatabase } from '../shared/db.ts';
import { closeRedis } from '../shared/redis.ts';
import { buildApp } from './app.ts';

const app = buildApp();

async function start(): Promise<void> {
  try {
    // 0.0.0.0: container içinde dışarıdan erişilebilmesi için şart.
    // localhost'a bağlanırsanız port yayınlansa bile bağlantı reddedilir.
    await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
    app.log.info(
      { port: config.API_PORT, env: config.NODE_ENV },
      'API servisi dinlemede',
    );
  } catch (err) {
    app.log.fatal({ err }, 'API başlatılamadı');
    process.exit(1);
  }
}

/**
 * Nazik kapanış (graceful shutdown):
 * 1) Yeni bağlantı kabul etmeyi bırak
 * 2) Devam eden istekleri bitir
 * 3) Veritabanı ve Redis havuzlarını kapat
 * Bu olmadan her deploy'da işlenmekte olan istekler yarıda kesilir.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info({ signal }, 'Kapanış başlıyor');

  // Emniyet supabı: 10 saniyede temiz kapanamazsa zorla çık.
  const forceExit = setTimeout(() => {
    app.log.error('Nazik kapanış zaman aşımına uğradı, zorla çıkılıyor');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    await app.close();
    await Promise.allSettled([closeDatabase(), closeRedis()]);
    app.log.info('Kapanış tamamlandı');
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'Kapanış sırasında hata');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  app.log.fatal({ reason }, 'İşlenmemiş promise reddi');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  app.log.fatal({ err }, 'Yakalanmamış istisna');
  void shutdown('uncaughtException');
});

await start();
