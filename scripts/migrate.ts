/**
 * Basit, bağımlılıksız migration aracı.
 *
 * Kullanım:
 *   npm run migrate          # bekleyen migration'ları uygula
 *   npm run migrate:status   # durumu listele
 *
 * Neden hazır araç değil? Migration'ın nasıl çalıştığını görmek — advisory
 * lock, checksum doğrulama, transaction sınırı — bu projede öğrenilecek
 * şeylerden biri. Üretimde golang-migrate / Flyway / Atlas kullanın.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { pool, query, withTransaction } from '../src/shared/db.ts';
import { createLogger } from '../src/shared/logger.ts';

const log = createLogger('migrate');
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '..', 'migrations');

// Aynı anda iki instance migration çalıştırırsa şema bozulur. Postgres'in
// advisory lock'u bunu tek satırda çözer; anahtar rastgele ama sabit olmalı.
const LOCK_KEY = 8_274_119_365_201n;

type MigrationFile = { version: string; filename: string; sql: string; checksum: string };
type AppliedRow = { version: string; checksum: string; applied_at: Date };

async function ensureMigrationsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function loadMigrations(): Promise<MigrationFile[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries.filter((f) => f.endsWith('.sql')).sort();

  const migrations: MigrationFile[] = [];
  for (const filename of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
    migrations.push({
      // '0001_init.sql' -> '0001'
      version: filename.split('_')[0] ?? filename,
      filename,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16),
    });
  }
  return migrations;
}

async function getApplied(): Promise<Map<string, AppliedRow>> {
  const { rows } = await query<AppliedRow>(
    'SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version',
  );
  return new Map(rows.map((r) => [r.version, r]));
}

async function up(): Promise<void> {
  await ensureMigrationsTable();

  await query('SELECT pg_advisory_lock($1)', [LOCK_KEY.toString()]);
  try {
    const migrations = await loadMigrations();
    const applied = await getApplied();

    // Uygulanmış bir migration sonradan düzenlenmişse sessizce geçme — uyar.
    for (const m of migrations) {
      const prev = applied.get(m.version);
      if (prev && prev.checksum !== m.checksum) {
        log.error(
          { version: m.version, beklenen: prev.checksum, bulunan: m.checksum },
          'Uygulanmış migration dosyası değiştirilmiş! Yeni bir migration ekleyin, eskisini düzenlemeyin.',
        );
        process.exitCode = 1;
        return;
      }
    }

    const pending = migrations.filter((m) => !applied.has(m.version));
    if (pending.length === 0) {
      log.info('Bekleyen migration yok — şema güncel');
      return;
    }

    for (const m of pending) {
      const startedAt = performance.now();
      // Her migration TEK transaction içinde: yarıda kalırsa hiçbir şey uygulanmaz.
      await withTransaction(async (client) => {
        await client.query(m.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          [m.version, m.checksum],
        );
      });
      log.info(
        { version: m.version, file: m.filename, ms: Math.round(performance.now() - startedAt) },
        'Uygulandı',
      );
    }

    log.info({ count: pending.length }, 'Migration tamamlandı');
  } finally {
    await query('SELECT pg_advisory_unlock($1)', [LOCK_KEY.toString()]);
  }
}

async function status(): Promise<void> {
  await ensureMigrationsTable();
  const migrations = await loadMigrations();
  const applied = await getApplied();

  process.stdout.write('\n  Durum      Sürüm   Dosya\n  ' + '-'.repeat(52) + '\n');
  for (const m of migrations) {
    const prev = applied.get(m.version);
    const state = !prev
      ? 'BEKLIYOR '
      : prev.checksum === m.checksum
        ? 'uygulandi'
        : 'DEGISMIS!';
    process.stdout.write(`  ${state}  ${m.version.padEnd(6)}  ${m.filename}\n`);
  }
  process.stdout.write('\n');
}

const command = process.argv[2] ?? 'up';

try {
  if (command === 'up') await up();
  else if (command === 'status') await status();
  else {
    log.error({ command }, 'Bilinmeyen komut. Kullanım: migrate [up|status]');
    process.exitCode = 1;
  }
} catch (err) {
  log.error({ err }, 'Migration başarısız');
  process.exitCode = 1;
} finally {
  await pool.end();
}
