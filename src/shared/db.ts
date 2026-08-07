import pg from 'pg';
import type { QueryResult, QueryResultRow, PoolClient } from 'pg';
import { config } from './config.ts';
import { createLogger } from './logger.ts';

const { Pool, types } = pg;
const log = createLogger('db');

// pg, bigint (int8) değerlerini varsayılan olarak string döndürür çünkü JS'in
// Number'ı 2^53'ten büyük tam sayıları güvenle taşıyamaz. Bizim bigint
// kolonlarımız (duration_ms, size_bytes) bu sınırın çok altında kalacağı için
// güvenle number'a çeviriyoruz. Bu bilinçli bir karardır — sınırı aşabilecek
// bir kolon eklerseniz bu dönüşümü gözden geçirin.
types.setTypeParser(types.builtins.INT8, (value: string) => Number.parseInt(value, 10));

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  // Faz 4 yük testi dersi: havuz boyutu bir GECİKME tavanıdır. 10 bağlantıyla
  // 5.000 eşzamanlı el sıkışma sıraya girdi ve HELLO gecikmesi 9,6 saniyeye
  // çıktı. Havuzu büyütmek tek başına yetmez (Postgres'in de sınırı var) —
  // asıl çözüm sorguyu HİÇ yapmamaktı; bkz. realtime/ws.ts oda önbelleği.
  // Yine de 10 gereksiz derecede dardı.
  max: Number(process.env.PG_POOL_MAX ?? 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Sorgu bir dakikadan uzun sürerse bağlantıyı bırakma — bir yerde iş ters gitmiştir
  statement_timeout: 60_000,
});

pool.on('error', (err) => {
  // Havuzdaki BOŞTA bir bağlantı öldüğünde tetiklenir. Süreç çökmemeli:
  // pg yeni bağlantı açacaktır.
  log.error({ err }, 'Postgres havuzunda boşta bağlantı hatası');
});

const SLOW_QUERY_MS = 200;

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
): Promise<QueryResult<T>> {
  const startedAt = performance.now();
  try {
    const result = await pool.query<T>(text, params as unknown[] | undefined);
    const durationMs = performance.now() - startedAt;
    if (durationMs > SLOW_QUERY_MS) {
      log.warn(
        { durationMs: Math.round(durationMs), rows: result.rowCount, sql: squash(text) },
        'Yavaş sorgu',
      );
    }
    return result;
  } catch (err) {
    log.error({ err, sql: squash(text) }, 'Sorgu başarısız');
    throw err;
  }
}

/** Tek satır bekleyen sorgular için kısayol. Satır yoksa null döner. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.rows[0] ?? null;
}

/**
 * Transaction sarmalayıcı. Callback hata fırlatırsa ROLLBACK yapılır.
 * Bağlantı her durumda havuza iade edilir — bu `finally` bloğu olmadan
 * havuz birkaç hatadan sonra tükenir.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      log.error({ err: rollbackErr }, 'ROLLBACK başarısız');
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function pingDatabase(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    log.error({ err }, 'Veritabanı ping başarısız');
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
  log.info('Postgres havuzu kapatıldı');
}

/** Log'da tek satır görünmesi için SQL'i sadeleştirir. */
function squash(sql: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/** Postgres benzersizlik ihlali (unique_violation) kodu. */
export const PG_UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}
