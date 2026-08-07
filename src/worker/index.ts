/**
 * Transkod worker'ı (Faz 2).
 *
 * Döngü:
 *   1. Süresi dolmuş işleri kurtar (reaper)
 *   2. Kuyruktan iş al (atomik Lua claim)
 *   3. İşle → başarı: complete() · hata: fail() (üstel geri çekilme / DLQ)
 *
 * Birden fazla worker aynı anda çalışabilir: claim atomiktir, aynı işi iki
 * worker alamaz. Ölçeklemek için `docker compose up --scale worker=3`.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { config } from '../shared/config.ts';
import { createLogger } from '../shared/logger.ts';
import { pingDatabase, closeDatabase } from '../shared/db.ts';
import { pingRedis, closeRedis } from '../shared/redis.ts';
import { pingStorage } from '../shared/storage.ts';
import { metricsText, metricsContentType } from '../shared/metrics.ts';
import { claim, complete, fail, reapExpired, queueStats } from '../shared/queue.ts';
import { processTranscode, checkFfmpeg } from './transcode.ts';

const log = createLogger('worker');
const WORKER_ID = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
const METRICS_PORT = Number(process.env.WORKER_METRICS_PORT ?? 8093);

/**
 * Worker bir HTTP servisi değil ama METRİKLERİNİ yayınlamak zorunda.
 *
 * Bu olmadan `jobs_processed_total`, `job_retries_total` ve
 * `transcode_duration_seconds` hiçbir zaman toplanmaz — Prometheus pull
 * modeliyle çalışır, süreç kendini sunmazsa metrik yoktur. Grafana'daki
 * kuyruk paneli sessizce boş kalırdı; en tehlikeli hata türü budur, çünkü
 * "her şey yolunda" gibi görünür.
 *
 * Alternatif Pushgateway'dir; ancak uzun ömürlü bir süreç için pull daha
 * doğrudur (süreç ölürse hedef "down" görünür, bu da bir bilgidir).
 */
function startMetricsServer(): Server {
  const server = createServer((req, res) => {
    if (req.url === '/metrics') {
      void metricsText().then((body) => {
        res.writeHead(200, { 'Content-Type': metricsContentType });
        res.end(body);
      });
      return;
    }
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', workerId: WORKER_ID, instanceId: config.INSTANCE_ID }));
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(METRICS_PORT, '0.0.0.0', () => {
    log.info({ port: METRICS_PORT }, 'Worker metrik ucu dinlemede');
  });
  return server;
}

const QUEUE = 'transcode';
/** Boş kuyrukta yoklama aralığı. Transkod işleri uzun sürdüğü için 250ms fazlasıyla yeterli. */
const IDLE_POLL_MS = 250;
const REAP_INTERVAL_MS = 30_000;

let running = true;
let currentJobId: string | null = null;
let metricsServer: Server | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // Bağımlılık kontrolü — eksik bir bağımlılıkla döngüye girmek, her işi
  // boşuna başarısız edip DLQ'yu doldurmaktan başka işe yaramaz.
  const [database, cache, storage, ff] = await Promise.all([
    pingDatabase(),
    pingRedis(),
    pingStorage(),
    checkFfmpeg(),
  ]);

  if (!database || !cache || !storage) {
    log.fatal({ database, redis: cache, storage }, 'Bağımlılıklara ulaşılamıyor');
    process.exit(1);
  }
  if (!ff.ffmpeg || !ff.ffprobe) {
    log.fatal({ ...ff }, 'ffmpeg/ffprobe bulunamadı — worker Docker içinde çalıştırılmalı');
    process.exit(1);
  }

  metricsServer = startMetricsServer();

  const stats = await queueStats(QUEUE);
  log.info({ workerId: WORKER_ID, ...stats }, 'Worker başladı');

  // Reaper ayrı bir ritimde çalışır: çöken worker'ların bıraktığı işleri kurtarır.
  const reaper = setInterval(() => {
    void reapExpired(QUEUE).catch((err) => log.error({ err }, 'Reaper hatası'));
  }, REAP_INTERVAL_MS);
  reaper.unref();

  while (running) {
    let job = null;
    try {
      job = await claim(QUEUE, WORKER_ID);
    } catch (err) {
      log.error({ err }, 'İş alınamadı — kısa bekleme');
      await sleep(2000);
      continue;
    }

    if (!job) {
      await sleep(IDLE_POLL_MS);
      continue;
    }

    currentJobId = job.id;
    log.info({ jobId: job.id, attempt: job.attempts, maxAttempts: job.maxAttempts }, 'İş alındı');

    try {
      await processTranscode(job);
      await complete(job);
    } catch (err) {
      // fail() denemeleri sayar ve ya yeniden kuyruğa koyar ya DLQ'ya atar.
      await fail(job, err).catch((e) => log.error({ err: e }, 'fail() başarısız'));
    } finally {
      currentJobId = null;
    }
  }

  clearInterval(reaper);
}

async function shutdown(signal: string): Promise<void> {
  if (!running) return;
  running = false;
  log.info({ signal, workerId: WORKER_ID, currentJobId }, 'Kapanış başlıyor');

  // Devam eden işi ZORLA kesmiyoruz. Kesseydik yarım transkod bırakırdık;
  // bunun yerine görünürlük süresinin dolmasına güveniyoruz — reaper işi
  // başka bir worker'a devredecek. Bu, at-least-once modelinin doğal sonucu.
  const forceExit = setTimeout(() => {
    log.warn('Kapanış zaman aşımı — zorla çıkılıyor');
    process.exit(1);
  }, 15_000);
  forceExit.unref();

  metricsServer?.close();
  await Promise.allSettled([closeDatabase(), closeRedis()]);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.fatal({ reason }, 'İşlenmemiş promise reddi');
  void shutdown('unhandledRejection');
});

await main();
