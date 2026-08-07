import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { query, queryOne } from '../shared/db.ts';
import { redis } from '../shared/redis.ts';
import { createLogger } from '../shared/logger.ts';
import { transcodeDuration } from '../shared/metrics.ts';
import { downloadToFile, putObject, deletePrefix, keys } from '../shared/storage.ts';
import { userChannel, type UserEvent } from '../shared/media.ts';
import { extendVisibility, type JobRecord } from '../shared/queue.ts';

const log = createLogger('transcode');

/**
 * İlerlemeyi hem Redis'e YAZAR (yoklama yapan istemciler için) hem de
 * kullanıcı kanalına YAYINLAR (WebSocket üzerinden itilmek üzere).
 *
 * Faz 3'te oda yayını için kurduğumuz Pub/Sub altyapısı burada bedavaya
 * geliyor: worker yayınlıyor, kullanıcının bağlı olduğu realtime instance'ı
 * dinleyip iletiyor. Worker'ın hangi instance olduğunu bilmesine gerek yok.
 */
async function publishProgress(
  videoId: string,
  ownerId: string,
  status: UserEvent['status'],
  percent: number | null,
  errorMessage?: string,
): Promise<void> {
  const event: UserEvent = {
    kind: 'VIDEO_PROGRESS',
    videoId,
    status,
    percent,
    ...(errorMessage ? { errorMessage } : {}),
  };
  await redis.publish(userChannel(ownerId), JSON.stringify(event)).catch(() => {});
}

/** ffmpeg bu süreyi aşarsa öldürülür. Sonsuza kadar çalışan iş, kuyruğu kilitler. */
const FFMPEG_TIMEOUT_MS = 30 * 60_000;
const FFPROBE_TIMEOUT_MS = 30_000;
const MAX_DURATION_MS = 3 * 60 * 60_000; // 3 saat

export type TranscodePayload = { videoId: string; sourceKey: string };

/** Çıktı kaliteleri. Her biri master.m3u8'de ayrı bir varyant olur. */
const RENDITIONS = [
  { name: '360p', width: 640, height: 360, videoBitrate: '800k', maxrate: '856k', bufsize: '1200k', audioBitrate: '96k' },
  { name: '720p', width: 1280, height: 720, videoBitrate: '2800k', maxrate: '2996k', bufsize: '4200k', audioBitrate: '128k' },
] as const;

// ------------------------------------------------------------------ Süreçler

type RunResult = { code: number | null; stdout: string; stderr: string };

/**
 * Harici süreç çalıştırıcı — zaman aşımı ve çıktı tavanı ile.
 *
 * Çıktıyı sınırsız biriktirmek bellek sızıntısıdır: ffmpeg saatlerce ilerleme
 * satırı basar. Son N karakteri tutmak teşhis için yeterlidir.
 */
function run(
  command: string,
  args: string[],
  options: { timeoutMs: number; onStderrLine?: (line: string) => void },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });

    let stdout = '';
    let stderrTail = '';
    let pending = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 1_000_000) stdout = stdout.slice(-1_000_000);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-8_000);

      if (options.onStderrLine) {
        pending += text;
        // ffmpeg ilerleme satırlarını \r ile ayırır, \n ile değil
        const parts = pending.split(/[\r\n]+/);
        pending = parts.pop() ?? '';
        for (const line of parts) if (line.trim()) options.onStderrLine(line);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} ${options.timeoutMs}ms zaman aşımına uğradı`));
        return;
      }
      resolve({ code, stdout, stderr: stderrTail });
    });
  });
}

// ---------------------------------------------------------------- Doğrulama

type ProbeResult = { durationMs: number; width: number; height: number; hasAudio: boolean };

/**
 * ffprobe ile doğrulama — GÜVENLİK AÇISINDAN ZORUNLU.
 *
 * Kullanıcı yüklemesi düşman girdisidir. Dosya adı ".mp4" olabilir ama içeriği
 * bambaşka olabilir. ffmpeg'i doğrulanmamış girdiye salmak, onun tüm demuxer
 * yüzeyini saldırıya açmak demektir. Önce ne olduğunu öğreniyoruz.
 */
async function probe(filePath: string): Promise<ProbeResult> {
  const result = await run(
    'ffprobe',
    [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ],
    { timeoutMs: FFPROBE_TIMEOUT_MS },
  );

  if (result.code !== 0) {
    throw new Error(`ffprobe dosyayı okuyamadı (çıkış ${result.code}): ${result.stderr.slice(-300)}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('ffprobe çıktısı ayrıştırılamadı');
  }

  const streams: any[] = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const hasAudio = streams.some((s) => s.codec_type === 'audio');

  if (!video) throw new Error('Dosyada video akışı yok');

  const durationSec = Number(parsed.format?.duration ?? video.duration ?? 0);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('Video süresi belirlenemedi');
  }

  const durationMs = Math.round(durationSec * 1000);
  if (durationMs > MAX_DURATION_MS) {
    throw new Error(`Video çok uzun: ${Math.round(durationMs / 60000)} dk (tavan 180 dk)`);
  }

  return {
    durationMs,
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    hasAudio,
  };
}

// ------------------------------------------------------------------ İlerleme

/** "out_time_ms=12345678" satırlarından yüzde hesaplar. */
function makeProgressParser(durationMs: number, onPercent: (pct: number) => void) {
  let last = -1;
  return (line: string): void => {
    // -progress pipe:2 çıktısı: out_time_us=... veya out_time_ms=...
    const m = /out_time_(us|ms)=(\d+)/.exec(line);
    if (!m) return;
    const value = Number(m[2]);
    const elapsedMs = m[1] === 'us' ? value / 1000 : value;
    const pct = Math.max(0, Math.min(99, Math.round((elapsedMs / durationMs) * 100)));
    // Aynı yüzdeyi tekrar tekrar yazmayalım — Redis'i boşuna dövmeyelim
    if (pct !== last) {
      last = pct;
      onPercent(pct);
    }
  };
}

// -------------------------------------------------------------------- ffmpeg

function buildFfmpegArgs(input: string, outDir: string, hasAudio: boolean): string[] {
  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input];

  // Tek video girişini N kopyaya böl, her kopyayı hedef çözünürlüğe ölçekle.
  // pad: kaynak en-boy oranı farklıysa siyah bantla tam çerçeveye tamamla —
  // aksi hâlde HLS varyantları farklı boyutlarda olur ve oynatıcı kalite
  // değiştirirken zıplar.
  const split = `[0:v]split=${RENDITIONS.length}${RENDITIONS.map((_, i) => `[s${i}]`).join('')}`;
  const scales = RENDITIONS.map(
    (r, i) =>
      `[s${i}]scale=w=${r.width}:h=${r.height}:force_original_aspect_ratio=decrease,` +
      `pad=${r.width}:${r.height}:(ow-iw)/2:(oh-ih)/2[v${i}]`,
  );
  args.push('-filter_complex', `${split};${scales.join(';')}`);

  const streamMap: string[] = [];

  RENDITIONS.forEach((r, i) => {
    args.push(
      '-map', `[v${i}]`,
      `-c:v:${i}`, 'libx264',
      `-b:v:${i}`, r.videoBitrate,
      `-maxrate:v:${i}`, r.maxrate,
      `-bufsize:v:${i}`, r.bufsize,
      '-preset', 'veryfast',
      '-profile:v', 'main',
      '-sc_threshold', '0',
      '-g', '48',
      '-keyint_min', '48',
    );
    if (hasAudio) {
      args.push('-map', 'a:0', `-c:a:${i}`, 'aac', `-b:a:${i}`, r.audioBitrate, '-ac', '2');
      streamMap.push(`v:${i},a:${i}`);
    } else {
      streamMap.push(`v:${i}`);
    }
  });

  args.push(
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(outDir, '%v', 'seg_%04d.ts'),
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', streamMap.join(' '),
    // İlerlemeyi ayrıştırılabilir biçimde stderr'e bas
    '-progress', 'pipe:2',
    '-nostats',
    path.join(outDir, '%v', 'index.m3u8'),
  );

  return args;
}

// -------------------------------------------------------------------- Ana iş

export async function processTranscode(job: JobRecord): Promise<void> {
  const payload = job.payload as TranscodePayload;
  const { videoId, sourceKey } = payload;
  const startedAt = performance.now();

  const workDir = await mkdtemp(path.join(tmpdir(), `transcode-${videoId}-`));
  const inputPath = path.join(workDir, 'input');
  const outDir = path.join(workDir, 'out');

  const progressKey = `video:${videoId}:progress`;
  const hlsPrefix = keys.hlsDir(videoId);

  // Uzun süren iş: görünürlük süresini periyodik uzat ki reaper işi
  // "worker çökmüş" sanıp ikinci kez kuyruğa koymasın.
  const keepAlive = setInterval(() => {
    void extendVisibility(job).catch((err) =>
      log.warn({ err, jobId: job.id }, 'Görünürlük uzatılamadı'),
    );
  }, 60_000);

  // İlerlemeyi kime bildireceğimizi bilmek için sahibi okuyoruz.
  const owner = await queryOne<{ owner_id: string }>(
    'SELECT owner_id FROM videos WHERE id = $1', [videoId],
  );
  const ownerId = owner?.owner_id ?? null;
  const notify = (status: UserEvent['status'], percent: number | null, err?: string) =>
    ownerId ? publishProgress(videoId, ownerId, status, percent, err) : Promise.resolve();

  try {
    await query(`UPDATE videos SET status = 'processing', error_message = NULL WHERE id = $1`, [videoId]);
    await redis.set(progressKey, '0', 'EX', 3600);
    await notify('processing', 0);

    // Yeniden deneme senaryosu: önceki denemeden kalan yarım çıktı olabilir.
    // Transkodu idempotent yapan şey bu temizlik — aynı iş iki kez çalışsa da
    // sonuç aynı olur.
    await deletePrefix(hlsPrefix);

    // 1) İndir
    log.info({ videoId, sourceKey }, 'Kaynak indiriliyor');
    await downloadToFile(sourceKey, inputPath);
    const inputStat = await stat(inputPath);
    if (inputStat.size === 0) throw new Error('İndirilen dosya boş');

    // 2) DOĞRULA (ffmpeg'den önce!)
    const info = await probe(inputPath);
    log.info({ videoId, ...info }, 'Kaynak doğrulandı');

    // 3) Transkod
    const parseProgress = makeProgressParser(info.durationMs, (pct) => {
      void redis.set(progressKey, String(pct), 'EX', 3600);
      void notify('processing', pct);
    });

    const args = buildFfmpegArgs(inputPath, outDir, info.hasAudio);
    log.info({ videoId, renditions: RENDITIONS.map((r) => r.name) }, 'ffmpeg başlıyor');

    const result = await run('ffmpeg', args, {
      timeoutMs: FFMPEG_TIMEOUT_MS,
      onStderrLine: parseProgress,
    });

    if (result.code !== 0) {
      throw new Error(`ffmpeg başarısız (çıkış ${result.code}): ${result.stderr.slice(-500)}`);
    }

    // 4) Çıktıyı yükle
    const uploaded = await uploadDirectory(outDir, hlsPrefix);
    log.info({ videoId, files: uploaded }, 'HLS çıktısı yüklendi');

    if (uploaded === 0) throw new Error('ffmpeg başarılı döndü ama çıktı üretmedi');

    // 5) Kaydı tamamla
    await query(
      `UPDATE videos
          SET status = 'ready', hls_master_key = $2, duration_ms = $3, error_message = NULL
        WHERE id = $1`,
      [videoId, keys.hlsMaster(videoId), info.durationMs],
    );
    await redis.set(progressKey, '100', 'EX', 300);
    await notify('ready', 100);

    const seconds = (performance.now() - startedAt) / 1000;
    transcodeDuration.observe(seconds);
    log.info({ videoId, seconds: Math.round(seconds), durationMs: info.durationMs }, 'Transkod tamamlandı');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Yarım kalan çıktıyı bırakmıyoruz: bir sonraki deneme temiz başlasın,
    // storage'da yetim segment birikmesin.
    await deletePrefix(hlsPrefix).catch(() => {});
    await redis.del(progressKey).catch(() => {});

    // Son deneme miydi? Kuyruk katmanı kararı verecek ama kullanıcıya
    // görünen durumu burada yazıyoruz.
    const isLastAttempt = job.attempts >= job.maxAttempts;
    await query(
      `UPDATE videos SET status = $2, error_message = $3 WHERE id = $1`,
      [videoId, isLastAttempt ? 'failed' : 'queued', message],
    ).catch(() => {});
    await notify(isLastAttempt ? 'failed' : 'queued', null, message);

    throw err;
  } finally {
    clearInterval(keepAlive);
    await rm(workDir, { recursive: true, force: true }).catch((err) =>
      log.warn({ err, workDir }, 'Geçici dizin silinemedi'),
    );
  }
}

/** Yerel dizini özyinelemeli olarak storage'a yükler. */
async function uploadDirectory(localDir: string, keyPrefix: string): Promise<number> {
  let count = 0;

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const localPath = path.join(dir, entry.name);
      const key = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(localPath, key);
      } else {
        const body = await readFile(localPath);
        await putObject(key, body, contentTypeFor(entry.name));
        count++;
      }
    }
  }

  await walk(localDir, keyPrefix);
  return count;
}

function contentTypeFor(filename: string): string {
  if (filename.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (filename.endsWith('.ts')) return 'video/mp2t';
  if (filename.endsWith('.m4s')) return 'video/iso.segment';
  return 'application/octet-stream';
}

/** ffmpeg ve ffprobe kurulu mu? Worker açılışta bunu kontrol eder. */
export async function checkFfmpeg(): Promise<{ ffmpeg: boolean; ffprobe: boolean }> {
  const probeOne = async (cmd: string): Promise<boolean> => {
    try {
      const r = await run(cmd, ['-version'], { timeoutMs: 10_000 });
      return r.code === 0;
    } catch {
      return false;
    }
  };
  const [ffmpeg, ffprobe] = await Promise.all([probeOne('ffmpeg'), probeOne('ffprobe')]);
  return { ffmpeg, ffprobe };
}
