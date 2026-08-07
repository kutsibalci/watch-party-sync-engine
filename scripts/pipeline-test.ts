/**
 * Faz 2 testi — iş kuyruğu ve transkod hattı.
 *
 * İki bölümden oluşur:
 *   A) Kuyruk mekanizmaları: idempotency, visibility timeout, reaper, üstel
 *      geri çekilme, dead-letter queue. Doğrudan queue API'siyle test edilir.
 *   B) Uçtan uca hat: gerçek bir video üretilir, presigned URL ile yüklenir,
 *      worker transkod eder, HLS çıktısı tarayıcıdan çekilebilir hâle gelir.
 *
 * Kullanım:  npm run pipeline-test    (api + worker ayakta olmalı)
 *
 * Test videosu ffmpeg'in testsrc üreteciyle oluşturulur — depoya binary
 * koymuyoruz. Bu yüzden HOST'ta da ffmpeg gerekir; yoksa B bölümü atlanır.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { redis, closeRedis } from '../src/shared/redis.ts';
import { query, queryOne, pool } from '../src/shared/db.ts';
import { enqueue, claim, complete, fail, reapExpired, queueStats, purge } from '../src/shared/queue.ts';

const API = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:8090';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;
let skipped = 0;

async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const detail = await fn();
    passed++;
    process.stdout.write(`  ${GREEN}✓${RESET} ${name}${detail ? `  ${DIM}${detail}${RESET}` : ''}\n`);
  } catch (err) {
    failed++;
    process.stdout.write(
      `  ${RED}✗${RESET} ${name}\n    ${RED}${err instanceof Error ? err.message : String(err)}${RESET}\n`,
    );
  }
}

function skip(name: string, reason: string): void {
  skipped++;
  process.stdout.write(`  ${YELLOW}⊘${RESET} ${name}  ${DIM}atlandı: ${reason}${RESET}\n`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

/** Sürüm bayrağı komuta göre değişir: ffmpeg `-version`, docker `--version` ister. */
function hasCommand(cmd: string, versionFlag = '-version'): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [versionFlag], { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/** Komutu çalıştırır; başarısızsa stderr ile birlikte hata fırlatır. */
function exec(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, shell: false });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => { stderr = (stderr + c.toString()).slice(-2000); });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} çıkış ${code}: ${stderr.slice(-400)}`)));
  });
}

const FFMPEG_SAMPLE_ARGS = [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=5',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-shortest',
];

/**
 * Test videosunu üretir. Depoya binary koymuyoruz.
 *
 * Host'ta ffmpeg yoksa (Windows'ta genellikle yoktur) worker container'ındaki
 * ffmpeg kullanılır — zaten transkod için orada kurulu.
 */
async function generateSample(destPath: string): Promise<string> {
  if (await hasCommand('ffmpeg')) {
    await exec('ffmpeg', [...FFMPEG_SAMPLE_ARGS, destPath]);
    return 'host ffmpeg';
  }

  const containerPath = '/tmp/pipeline-sample.mp4';
  await exec('docker', [
    'compose', 'exec', '-T', 'worker',
    'ffmpeg', ...FFMPEG_SAMPLE_ARGS, containerPath,
  ]);
  await exec('docker', ['compose', 'cp', `worker:${containerPath}`, destPath]);
  return 'worker container ffmpeg';
}

// ====================================================== A) Kuyruk mekanizmaları
process.stdout.write(`\n  Faz 2 hat testi → ${API}\n\n  ${DIM}A) Kuyruk mekanizmaları${RESET}\n\n`);

const TEST_QUEUE = `test-${Date.now()}`;

await check('enqueue → claim → complete akışı', async () => {
  const job = await enqueue(TEST_QUEUE, { hello: 'world' });
  assert(job, 'enqueue null döndü');

  const claimed = await claim(TEST_QUEUE, 'test-worker');
  assert(claimed, 'claim null döndü');
  assert(claimed.id === job.id, 'farklı iş alındı');
  assert(claimed.attempts === 1, `attempts ${claimed.attempts} olmalı 1`);

  await complete(claimed);
  const row = await queryOne<{ status: string }>('SELECT status FROM jobs WHERE id = $1', [job.id]);
  assert(row?.status === 'succeeded', `durum ${row?.status}`);

  const stats = await queueStats(TEST_QUEUE);
  assert(stats.ready === 0 && stats.inflight === 0, `kuyruk temiz değil: ${JSON.stringify(stats)}`);
  return 'tek turda tamamlandı';
});

await check('Idempotency: aynı anahtar ikinci kez kuyruğa girmiyor', async () => {
  const key = `idem-${Date.now()}`;
  const first = await enqueue(TEST_QUEUE, { n: 1 }, { idempotencyKey: key });
  const second = await enqueue(TEST_QUEUE, { n: 2 }, { idempotencyKey: key });

  assert(first, 'ilk enqueue null');
  assert(second === null, 'ikinci enqueue null dönmeliydi (kısıt yakalamalıydı)');

  const { rows } = await query('SELECT id FROM jobs WHERE idempotency_key = $1', [key]);
  assert(rows.length === 1, `${rows.length} kayıt var, 1 olmalıydı`);

  const claimed = await claim(TEST_QUEUE, 'test-worker');
  await complete(claimed!);
  return 'veritabanı kısıtı yarışı kapattı';
});

await check('İki worker aynı işi ALAMIYOR (atomik claim)', async () => {
  const job = await enqueue(TEST_QUEUE, { race: true });
  assert(job, 'enqueue null');

  // Aynı anda beş worker claim etmeye çalışsın
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) => claim(TEST_QUEUE, `worker-${i}`)),
  );
  const winners = results.filter((r) => r !== null);
  assert(winners.length === 1, `${winners.length} worker iş aldı, 1 olmalıydı`);

  await complete(winners[0]!);
  return '5 worker yarıştı, 1 kazandı';
});

await check('Üstel geri çekilme: başarısız iş gecikmeli olarak geri dönüyor', async () => {
  const job = await enqueue(TEST_QUEUE, { willFail: true }, { maxAttempts: 3 });
  const claimed = await claim(TEST_QUEUE, 'test-worker');
  assert(claimed, 'claim null');

  await fail(claimed, new Error('kasıtlı hata'));

  const stats = await queueStats(TEST_QUEUE);
  assert(stats.delayed === 1, `delayed ${stats.delayed} olmalı 1`);
  assert(stats.ready === 0, 'iş hemen ready olmamalıydı');

  const row = await queryOne<{ status: string; attempts: number; last_error: string }>(
    'SELECT status, attempts, last_error FROM jobs WHERE id = $1', [job!.id],
  );
  assert(row?.status === 'queued', `durum ${row?.status}`);
  assert(row.attempts === 1, `attempts ${row.attempts}`);
  assert(row.last_error.includes('kasıtlı hata'), 'hata mesajı kaydedilmemiş');

  // Gecikme dolunca claim onu ready'ye terfi ettirmeli (1. deneme → 1 sn)
  await sleep(1200);
  const again = await claim(TEST_QUEUE, 'test-worker');
  assert(again, 'gecikmeli iş geri dönmedi');
  assert(again.attempts === 2, `attempts ${again.attempts} olmalı 2`);
  await complete(again);
  return 'gecikme sonrası yeniden alındı';
});

await check('Dead-letter: denemeler tükenince iş DLQ\'ya düşüyor', async () => {
  const job = await enqueue(TEST_QUEUE, { doomed: true }, { maxAttempts: 1 });
  const claimed = await claim(TEST_QUEUE, 'test-worker');
  assert(claimed, 'claim null');
  assert(claimed.attempts === 1 && claimed.maxAttempts === 1, 'deneme sayacı hatalı');

  await fail(claimed, new Error('kurtarılamaz hata'));

  const row = await queryOne<{ status: string }>('SELECT status FROM jobs WHERE id = $1', [job!.id]);
  assert(row?.status === 'dead', `durum ${row?.status}, 'dead' olmalıydı`);

  const stats = await queueStats(TEST_QUEUE);
  assert(stats.dead >= 1, 'dead sayacı artmadı');
  assert(stats.ready === 0 && stats.delayed === 0, 'ölü iş hâlâ kuyrukta');
  return 'DLQ\'ya alındı, kuyruk temiz';
});

await check('Visibility timeout: çöken worker\'ın işi kurtarılıyor', async () => {
  const job = await enqueue(TEST_QUEUE, { crashy: true }, { maxAttempts: 3 });
  const claimed = await claim(TEST_QUEUE, 'crashing-worker');
  assert(claimed, 'claim null');

  // Worker çöktü: complete() veya fail() ÇAĞRILMADI. İş inflight'ta asılı.
  let stats = await queueStats(TEST_QUEUE);
  assert(stats.inflight === 1, `inflight ${stats.inflight} olmalı 1`);

  // Reaper henüz bir şey yapmamalı — süre dolmadı
  const reapedEarly = await reapExpired(TEST_QUEUE);
  assert(reapedEarly === 0, 'reaper süresi dolmamış işi aldı');

  // Görünürlük son tarihini geçmişe çekerek zaman aşımını simüle et
  await redis.zadd(`q:${TEST_QUEUE}:inflight`, Date.now() - 1000, job!.id);

  const reaped = await reapExpired(TEST_QUEUE);
  assert(reaped === 1, `${reaped} iş kurtarıldı, 1 olmalıydı`);

  stats = await queueStats(TEST_QUEUE);
  assert(stats.inflight === 0, 'iş hâlâ inflight');
  assert(stats.ready === 1, `ready ${stats.ready} olmalı 1`);

  const recovered = await claim(TEST_QUEUE, 'healthy-worker');
  assert(recovered, 'kurtarılan iş alınamadı');
  await complete(recovered);
  return 'inflight → ready → yeniden işlendi';
});

await purge(TEST_QUEUE);
await query('DELETE FROM jobs WHERE type = $1', [TEST_QUEUE]);

// ======================================================== B) Uçtan uca hat
process.stdout.write(`\n  ${DIM}B) Uçtan uca transkod hattı${RESET}\n\n`);

const ffmpegAnywhere = (await hasCommand('ffmpeg')) || (await hasCommand('docker', '--version'));
let workDir: string | null = null;

if (!ffmpegAnywhere) {
  skip('Test videosu üretiliyor', 'ne host\'ta ffmpeg ne docker var');
  skip('Presigned URL ile yükleme', 'test videosu üretilemedi');
  skip('Worker transkod ediyor', 'test videosu üretilemedi');
  skip('HLS çıktısı tarayıcıdan çekilebiliyor', 'test videosu üretilemedi');
  skip('Bozuk dosya reddediliyor', 'test videosu üretilemedi');
} else {
  workDir = await mkdtemp(path.join(tmpdir(), 'pipeline-test-'));
  const samplePath = path.join(workDir, 'sample.mp4');

  const stamp = Date.now();
  const user = await api('POST', '/api/auth/register', {
    email: `pipeline-${stamp}@example.com`,
    password: 'CokGizliParola123',
    displayName: 'Pipeline Testi',
  });
  const token = user.accessToken as string;

  await check('Test videosu üretiliyor (ffmpeg testsrc, 5 sn)', async () => {
    const source = await generateSample(samplePath);
    const s = await stat(samplePath);
    assert(s.size > 1000, `üretilen dosya çok küçük: ${s.size} bayt`);
    return `${Math.round(s.size / 1024)} KB · ${source}`;
  });

  let videoId = '';

  await check('Presigned URL alınıyor ve dosya DOĞRUDAN storage\'a yükleniyor', async () => {
    const fileBuffer = await readFile(samplePath);
    const { video, upload } = await api('POST', '/api/videos', {
      title: 'Pipeline testi',
      filename: 'sample.mp4',
      contentType: 'video/mp4',
      sizeBytes: fileBuffer.length,
    }, token);

    videoId = video.id;
    assert(upload.url.includes('X-Amz-Signature'), 'URL imzalı değil');
    assert(!upload.url.includes('minio:9000'), 'URL dahili host ile imzalanmış — tarayıcı çözemez');

    const put = await fetch(upload.url, {
      method: 'PUT',
      headers: upload.headers,
      body: new Uint8Array(fileBuffer),
    });
    assert(put.ok, `PUT başarısız: ${put.status} ${await put.text()}`);
    return `videoId ${videoId.slice(0, 8)}…`;
  });

  await check('complete → kuyruğa alınıyor, ikinci çağrı yeni iş yaratmıyor', async () => {
    const first = await api('POST', `/api/videos/${videoId}/complete`, undefined, token);
    assert(first.enqueued === true, 'ilk complete kuyruğa almadı');

    const second = await api('POST', `/api/videos/${videoId}/complete`, undefined, token);
    assert(second.enqueued === false, 'ikinci complete yeni iş yarattı — idempotency bozuk');

    const { rows } = await query(
      `SELECT id FROM jobs WHERE idempotency_key = $1`, [`transcode:${videoId}`],
    );
    assert(rows.length === 1, `${rows.length} iş kaydı var, 1 olmalıydı`);
    return 'tek iş kaydı';
  });

  let hlsUrl = '';

  await check('Worker transkod ediyor, video "ready" oluyor', async () => {
    const deadline = Date.now() + 180_000;
    let last: any = null;
    while (Date.now() < deadline) {
      const { video } = await api('GET', `/api/videos/${videoId}`, undefined, token);
      last = video;
      if (video.status === 'ready') {
        hlsUrl = video.hlsUrl;
        assert(video.durationMs > 4000 && video.durationMs < 6500,
          `süre beklenenden farklı: ${video.durationMs}ms`);
        assert(hlsUrl, 'hlsUrl boş');
        return `${Math.round(video.durationMs)}ms · ${hlsUrl.split('/').slice(-3).join('/')}`;
      }
      if (video.status === 'failed') throw new Error(`transkod başarısız: ${video.errorMessage}`);
      await sleep(1500);
    }
    throw new Error(`180 sn içinde bitmedi, son durum: ${last?.status} (${last?.errorMessage ?? '-'})`);
  });

  await check('HLS master playlist tarayıcıdan (anonim) çekilebiliyor', async () => {
    const res = await fetch(hlsUrl);
    assert(res.ok, `master.m3u8 alınamadı: HTTP ${res.status}`);
    const text = await res.text();
    assert(text.startsWith('#EXTM3U'), 'geçerli bir m3u8 değil');
    assert(text.includes('EXT-X-STREAM-INF'), 'varyant tanımı yok');
    // İki kalite üretmiş olmalıyız
    const variants = (text.match(/EXT-X-STREAM-INF/g) ?? []).length;
    assert(variants === 2, `${variants} varyant var, 2 olmalıydı`);
    return `${variants} varyant`;
  });

  await check('Segmentler gerçekten yüklenmiş ve indirilebiliyor', async () => {
    const master = await (await fetch(hlsUrl)).text();
    const variantPath = master.split('\n').find((l) => l.trim() && !l.startsWith('#'));
    assert(variantPath, 'varyant playlist yolu bulunamadı');

    const base = hlsUrl.slice(0, hlsUrl.lastIndexOf('/'));
    const variantUrl = `${base}/${variantPath.trim()}`;
    const variant = await (await fetch(variantUrl)).text();
    assert(variant.includes('#EXTINF'), 'varyant playlist boş');

    const segment = variant.split('\n').find((l) => l.trim().endsWith('.ts'));
    assert(segment, 'segment bulunamadı');
    const segUrl = `${variantUrl.slice(0, variantUrl.lastIndexOf('/'))}/${segment.trim()}`;
    const segRes = await fetch(segUrl);
    assert(segRes.ok, `segment alınamadı: HTTP ${segRes.status}`);
    const bytes = (await segRes.arrayBuffer()).byteLength;
    assert(bytes > 1000, `segment çok küçük: ${bytes} bayt`);
    return `${Math.round(bytes / 1024)} KB segment`;
  });

  await check('Bozuk dosya ffprobe\'da yakalanıyor, video "failed" oluyor', async () => {
    const junk = Buffer.from('bu bir video degil, sadece metin'.repeat(50));
    const { video, upload } = await api('POST', '/api/videos', {
      title: 'Bozuk dosya',
      filename: 'bozuk.mp4',
      contentType: 'video/mp4',
      sizeBytes: junk.length,
    }, token);

    const put = await fetch(upload.url, {
      method: 'PUT', headers: upload.headers, body: new Uint8Array(junk),
    });
    assert(put.ok, `PUT başarısız: ${put.status}`);

    await api('POST', `/api/videos/${video.id}/complete`, undefined, token);

    // maxAttempts=3, geri çekilme 1s + 4s → ~30 sn yeterli
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const { video: v } = await api('GET', `/api/videos/${video.id}`, undefined, token);
      if (v.status === 'failed') {
        assert(
          /ffprobe|video akışı|okuyamadı/i.test(v.errorMessage ?? ''),
          `hata mesajı beklenmedik: ${v.errorMessage}`,
        );
        return v.errorMessage.slice(0, 60);
      }
      await sleep(2000);
    }
    throw new Error('bozuk dosya 90 sn içinde failed olmadı');
  });

  await check('Yükleme reddi: desteklenmeyen uzantı 400 dönüyor', async () => {
    try {
      await api('POST', '/api/videos', {
        title: 'Kötü uzantı',
        filename: 'zararli.exe',
        contentType: 'application/octet-stream',
        sizeBytes: 1024,
      }, token);
      throw new Error('istek kabul edildi, reddedilmeliydi');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes('400'), `beklenen 400, gelen: ${msg}`);
      return 'reddedildi';
    }
  });
}

if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});

process.stdout.write(
  `\n  ${passed} başarılı, ${failed} başarısız${skipped ? `, ${skipped} atlandı` : ''}\n\n`,
);

await closeRedis().catch(() => {});
await pool.end().catch(() => {});
process.exit(failed > 0 ? 1 : 0);
