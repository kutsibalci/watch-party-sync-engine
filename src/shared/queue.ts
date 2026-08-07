import { randomUUID } from 'node:crypto';

import { redis } from './redis.ts';
import { query, queryOne, isUniqueViolation } from './db.ts';
import { createLogger } from './logger.ts';
import { jobRetriesTotal, jobsProcessedTotal } from './metrics.ts';

const log = createLogger('queue');

/**
 * Elle yazılmış iş kuyruğu — BullMQ/Celery kullanmıyoruz.
 *
 * Amaç bu dört mekanizmayı bizzat kurmak:
 *   1. VISIBILITY TIMEOUT — worker çökerse iş kaybolmaz, süre dolunca döner
 *   2. IDEMPOTENCY        — aynı iş iki kez işlenirse sonuç bozulmaz
 *   3. ÜSTEL GERİ ÇEKİLME — başarısız iş artan gecikmelerle yeniden denenir
 *   4. DEAD-LETTER QUEUE  — tükenen iş sessizce kaybolmaz, incelenmek üzere durur
 *
 * ┌─ NEDEN EXACTLY-ONCE YOK ─────────────────────────────────────────────┐
 * │ Hiçbir kuyruk "tam olarak bir kez" teslim garantisi veremez. Worker   │
 * │ işi bitirip "tamam" demeden hemen önce çökerse, iş görünürlük süresi  │
 * │ dolduğunda BAŞKA bir worker'a gider ve İKİNCİ KEZ işlenir.            │
 * │                                                                       │
 * │ Doğru model: AT-LEAST-ONCE teslimat + İDEMPOTENT işleyici.            │
 * │ Yani "iki kez çalışmasın" diye uğraşmak yerine, "iki kez çalışırsa    │
 * │ da sonuç aynı olsun" diye yazarız. Bu projede transkod idempotenttir: │
 * │ aynı çıktı anahtarına yazar ve DB'yi aynı sonuca günceller.           │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * Redis anahtar düzeni (type = 'transcode'):
 *   q:transcode:ready    LIST  — alınmayı bekleyen iş kimlikleri
 *   q:transcode:inflight ZSET  — alınmış işler, skor = görünürlük son tarihi (ms)
 *   q:transcode:delayed  ZSET  — yeniden deneme bekleyenler, skor = uygunluk anı
 */

export type JobRecord = {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
};

type JobRow = {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  status: string;
};

const READY = (type: string) => `q:${type}:ready`;
const INFLIGHT = (type: string) => `q:${type}:inflight`;
const DELAYED = (type: string) => `q:${type}:delayed`;

/** Bir işin tamamlanması için tanınan süre. Aşılırsa iş kuyruğa geri döner. */
export const VISIBILITY_TIMEOUT_MS = 10 * 60_000;

/** Yeniden deneme gecikmeleri: 1s, 4s, 9s, 16s … (attempt²) */
function backoffMs(attempt: number): number {
  return Math.min(attempt * attempt * 1000, 5 * 60_000);
}

// ------------------------------------------------------------------ Enqueue

/**
 * İşi kuyruğa alır.
 *
 * Kalıcı kayıt Postgres'te, hızlı yol Redis'te. `idempotencyKey` verilirse
 * veritabanındaki benzersizlik kısıtı aynı işin iki kez girmesini ENGELLER —
 * bunu uygulama katmanında "önce SELECT et" ile yapmak yarışı kapatmaz.
 *
 * @returns oluşturulan iş, ya da aynı anahtarla iş zaten varsa null
 */
export async function enqueue(
  type: string,
  payload: unknown,
  options: { idempotencyKey?: string; maxAttempts?: number; delayMs?: number } = {},
): Promise<JobRecord | null> {
  const id = randomUUID();
  const maxAttempts = options.maxAttempts ?? 5;
  const availableAt = new Date(Date.now() + (options.delayMs ?? 0));

  let row: JobRow | null;
  try {
    row = await queryOne<JobRow>(
      `INSERT INTO jobs (id, type, payload, max_attempts, available_at, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, type, payload, attempts, max_attempts, status`,
      [id, type, JSON.stringify(payload), maxAttempts, availableAt, options.idempotencyKey ?? null],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      log.info({ type, idempotencyKey: options.idempotencyKey }, 'İş zaten kuyrukta — atlandı');
      return null;
    }
    throw err;
  }
  if (!row) throw new Error('INSERT ... RETURNING satır döndürmedi');

  if (options.delayMs && options.delayMs > 0) {
    await redis.zadd(DELAYED(type), availableAt.getTime(), id);
  } else {
    await redis.lpush(READY(type), id);
  }

  log.info({ jobId: id, type }, 'İş kuyruğa alındı');
  return { id: row.id, type: row.type, payload: row.payload, attempts: row.attempts, maxAttempts: row.max_attempts };
}

// -------------------------------------------------------------------- Claim

/**
 * İş alma — TEK Lua betiğiyle atomik.
 *
 * Neden Lua? "RPOP et, sonra ZADD et" iki ayrı komuttur; ikisinin arasında
 * worker çökerse iş ne ready'de ne inflight'ta kalır — SESSİZCE KAYBOLUR.
 * Lua betiği Redis'te tek parça çalışır, bu boşluğu kapatır.
 *
 * Neden bloklamıyoruz (BRPOPLPUSH yerine)? Bloklayan komutlar atomik biçimde
 * ZSET'e yazamaz. Transkod işleri saniyeler-dakikalar sürdüğü için 250ms'lik
 * yoklama gecikmesi önemsiz; karşılığında iş kaybını imkânsız kılıyoruz.
 */
const CLAIM_SCRIPT = `
  local id = redis.call('RPOP', KEYS[1])
  if not id then return nil end
  redis.call('ZADD', KEYS[2], ARGV[1], id)
  return id
`;

export async function claim(type: string, workerId: string): Promise<JobRecord | null> {
  await promoteDelayed(type);

  const deadline = Date.now() + VISIBILITY_TIMEOUT_MS;
  const id = (await redis.eval(CLAIM_SCRIPT, 2, READY(type), INFLIGHT(type), String(deadline))) as
    | string
    | null;

  if (!id) return null;

  const row = await queryOne<JobRow>(
    `UPDATE jobs
        SET status = 'in_flight', attempts = attempts + 1,
            locked_at = now(), locked_by = $2
      WHERE id = $1
      RETURNING id, type, payload, attempts, max_attempts, status`,
    [id, workerId],
  );

  if (!row) {
    // Redis'te var ama Postgres'te yok: veri tabanı sıfırlanmış olabilir.
    // İşi düşür, kuyruğu kirletmesin.
    log.warn({ jobId: id }, 'Redis kuyruğunda olan iş veritabanında yok — düşürüldü');
    await redis.zrem(INFLIGHT(type), id);
    return null;
  }

  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

// ------------------------------------------------------------------ Tamamla

export async function complete(job: JobRecord): Promise<void> {
  await redis.zrem(INFLIGHT(job.type), job.id);
  await query(`UPDATE jobs SET status = 'succeeded', locked_at = NULL, locked_by = NULL WHERE id = $1`, [job.id]);
  jobsProcessedTotal.inc({ type: job.type, outcome: 'succeeded' });
  log.info({ jobId: job.id, type: job.type, attempts: job.attempts }, 'İş tamamlandı');
}

/**
 * Başarısızlık: denemeler tükenmediyse üstel geri çekilmeyle yeniden kuyruğa,
 * tükendiyse dead-letter'a.
 */
export async function fail(job: JobRecord, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await redis.zrem(INFLIGHT(job.type), job.id);

  if (job.attempts >= job.maxAttempts) {
    await query(`UPDATE jobs SET status = 'dead', last_error = $2 WHERE id = $1`, [job.id, message]);
    jobsProcessedTotal.inc({ type: job.type, outcome: 'dead' });
    // DLQ sessiz olmamalı: buraya düşen her iş insan gözü ister.
    log.error({ jobId: job.id, type: job.type, attempts: job.attempts, error: message },
      'İş dead-letter kuyruğuna düştü');
    return;
  }

  const delay = backoffMs(job.attempts);
  const availableAt = Date.now() + delay;
  await query(
    `UPDATE jobs SET status = 'queued', last_error = $2, available_at = $3,
            locked_at = NULL, locked_by = NULL
      WHERE id = $1`,
    [job.id, message, new Date(availableAt)],
  );
  await redis.zadd(DELAYED(job.type), availableAt, job.id);

  jobRetriesTotal.inc({ type: job.type });
  jobsProcessedTotal.inc({ type: job.type, outcome: 'failed' });
  log.warn({ jobId: job.id, attempts: job.attempts, retryInMs: delay, error: message },
    'İş başarısız — yeniden denenecek');
}

// ---------------------------------------------------------------- Bakım

/** Zamanı gelen gecikmeli işleri ready listesine taşır. */
async function promoteDelayed(type: string): Promise<number> {
  const due = await redis.zrangebyscore(DELAYED(type), '-inf', Date.now());
  if (due.length === 0) return 0;

  const pipeline = redis.multi();
  for (const id of due) {
    pipeline.zrem(DELAYED(type), id);
    pipeline.lpush(READY(type), id);
  }
  await pipeline.exec();
  return due.length;
}

/**
 * Görünürlük süresi dolmuş işleri kurtarır.
 *
 * Bu fonksiyon olmasaydı, çöken bir worker'ın elindeki iş SONSUZA KADAR
 * inflight'ta kalırdı — kuyrukta görünmez, asla işlenmez.
 */
export async function reapExpired(type: string): Promise<number> {
  const expired = await redis.zrangebyscore(INFLIGHT(type), '-inf', Date.now());
  if (expired.length === 0) return 0;

  for (const id of expired) {
    const row = await queryOne<JobRow>(
      `SELECT id, type, payload, attempts, max_attempts, status FROM jobs WHERE id = $1`,
      [id],
    );
    await redis.zrem(INFLIGHT(type), id);

    if (!row) continue;

    if (row.attempts >= row.max_attempts) {
      await query(
        `UPDATE jobs SET status = 'dead', last_error = 'görünürlük süresi doldu (worker çökmüş olabilir)' WHERE id = $1`,
        [id],
      );
      jobsProcessedTotal.inc({ type, outcome: 'dead' });
      log.error({ jobId: id }, 'Süresi dolan iş dead-letter\'a alındı');
    } else {
      await query(
        `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL WHERE id = $1`,
        [id],
      );
      await redis.lpush(READY(type), id);
      jobRetriesTotal.inc({ type });
      log.warn({ jobId: id, attempts: row.attempts }, 'Görünürlük süresi doldu — iş kuyruğa iade edildi');
    }
  }

  return expired.length;
}

/** Uzun süren işlerde görünürlük süresini uzatır (kalp atışı). */
export async function extendVisibility(job: JobRecord, extraMs = VISIBILITY_TIMEOUT_MS): Promise<void> {
  await redis.zadd(INFLIGHT(job.type), Date.now() + extraMs, job.id);
}

// -------------------------------------------------------------------- Gözlem

export async function queueStats(type: string): Promise<{
  ready: number;
  inflight: number;
  delayed: number;
  dead: number;
}> {
  const [ready, inflight, delayed, deadRow] = await Promise.all([
    redis.llen(READY(type)),
    redis.zcard(INFLIGHT(type)),
    redis.zcard(DELAYED(type)),
    queryOne<{ count: string }>(`SELECT count(*) FROM jobs WHERE type = $1 AND status = 'dead'`, [type]),
  ]);
  return { ready, inflight, delayed, dead: Number(deadRow?.count ?? 0) };
}

/** Testler için: bir kuyruğun tüm Redis izlerini siler. */
export async function purge(type: string): Promise<void> {
  await redis.del(READY(type), INFLIGHT(type), DELAYED(type));
}
