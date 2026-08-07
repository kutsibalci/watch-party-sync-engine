import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { query, queryOne } from '../../shared/db.ts';
import { redis } from '../../shared/redis.ts';
import { badRequest, notFound, forbidden, conflict, internal } from '../../shared/errors.ts';
import { requireAuth, currentUser } from '../middleware/auth.ts';
import { keys, presignUpload, headObject, publicUrl } from '../../shared/storage.ts';
import { enqueue, queueStats } from '../../shared/queue.ts';

type VideoRow = {
  id: string;
  owner_id: string;
  title: string;
  status: 'pending' | 'queued' | 'processing' | 'ready' | 'failed';
  source_key: string | null;
  hls_master_key: string | null;
  duration_ms: number | null;
  size_bytes: number | null;
  error_message: string | null;
  created_at: Date;
};

/** ffmpeg'in güvenle işleyebileceği ve tarayıcının yükleyebileceği biçimler. */
const ALLOWED_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

const CreateVideoSchema = z.object({
  title: z.string().trim().min(1).max(200),
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(120).default('application/octet-stream'),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
});

function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw badRequest(
      'İstek gövdesi geçersiz',
      result.error.issues.map((i) => ({ field: i.path.join('.') || '(kök)', message: i.message })),
    );
  }
  return result.data;
}

async function readProgress(videoId: string): Promise<number | null> {
  const raw = await redis.get(`video:${videoId}:progress`);
  return raw === null ? null : Number(raw);
}

async function toPublicVideo(row: VideoRow) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    durationMs: row.duration_ms,
    sizeBytes: row.size_bytes,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    hlsUrl: row.hls_master_key ? publicUrl(row.hls_master_key) : null,
    progress: row.status === 'processing' ? await readProgress(row.id) : null,
  };
}

export async function registerVideoRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------- 1) yükleme adresi iste
  app.post('/', { preHandler: requireAuth }, async (req, reply) => {
    const user = currentUser(req);
    const { title, filename, contentType, sizeBytes } = parseBody(CreateVideoSchema, req.body);

    // Uzantıyı DOĞRULA — dosya adı kullanıcı girdisidir, güvenilmez.
    const ext = path.extname(filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw badRequest(
        `Desteklenmeyen dosya türü: ${ext || '(uzantısız)'}`,
        { allowed: [...ALLOWED_EXTENSIONS] },
      );
    }

    const row = await queryOne<VideoRow>(
      `INSERT INTO videos (owner_id, title, status, size_bytes)
       VALUES ($1, $2, 'pending', $3)
       RETURNING *`,
      [user.sub, title, sizeBytes],
    );
    if (!row) throw internal('INSERT ... RETURNING satır döndürmedi');

    const sourceKey = keys.source(row.id, ext);
    await query('UPDATE videos SET source_key = $2 WHERE id = $1', [row.id, sourceKey]);

    const uploadUrl = await presignUpload(sourceKey, contentType);

    req.log.info({ videoId: row.id, sourceKey, sizeBytes }, 'Yükleme adresi verildi');

    return reply.status(201).send({
      video: await toPublicVideo({ ...row, source_key: sourceKey }),
      upload: {
        url: uploadUrl,
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        expiresInSeconds: 900,
      },
    });
  });

  // ------------------------------------------- 2) yükleme bitti, işle diye bildir
  app.post('/:id/complete', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const { id } = req.params as { id: string };

    const row = await queryOne<VideoRow>('SELECT * FROM videos WHERE id = $1', [id]);
    if (!row) throw notFound('Video bulunamadı');
    if (row.owner_id !== user.sub) throw forbidden('Bu video size ait değil');
    if (!row.source_key) throw conflict('Video için kaynak anahtarı yok');

    if (row.status !== 'pending' && row.status !== 'failed') {
      // Zaten kuyrukta/işlenmiş — istemcinin tekrar tıklaması hata değil,
      // sadece mevcut durumu döndür.
      return { video: await toPublicVideo(row), enqueued: false };
    }

    // Dosyanın GERÇEKTEN yüklendiğini doğrula. İstemcinin "yükledim" demesi
    // yeterli değil; presigned PUT başarısız olmuş olabilir.
    const head = await headObject(row.source_key);
    if (!head) throw conflict('Dosya storage\'a yüklenmemiş görünüyor');
    if (head.size === 0) throw badRequest('Yüklenen dosya boş');

    await query(`UPDATE videos SET status = 'queued', size_bytes = $2, error_message = NULL WHERE id = $1`,
      [id, head.size]);

    // idempotencyKey: aynı video iki kez "complete" edilirse ikinci çağrı
    // yeni iş YARATMAZ. Bu kontrol veritabanı kısıtıyla yapılır, uygulama
    // katmanındaki bir SELECT ile değil — yarışı ancak kısıt kapatır.
    const job = await enqueue(
      'transcode',
      { videoId: id, sourceKey: row.source_key },
      { idempotencyKey: `transcode:${id}`, maxAttempts: 3 },
    );

    req.log.info({ videoId: id, jobId: job?.id ?? null, sizeBytes: head.size },
      job ? 'Transkod kuyruğa alındı' : 'Transkod zaten kuyrukta');

    const updated = await queryOne<VideoRow>('SELECT * FROM videos WHERE id = $1', [id]);
    return { video: await toPublicVideo(updated!), enqueued: job !== null };
  });

  // --------------------------------------------------------- 3) durum sorgula
  app.get('/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await queryOne<VideoRow>('SELECT * FROM videos WHERE id = $1', [id]);
    if (!row) throw notFound('Video bulunamadı');
    return { video: await toPublicVideo(row) };
  });

  // ------------------------------------------------------------ 4) videolarım
  app.get('/', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const { rows } = await query<VideoRow>(
      'SELECT * FROM videos WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 50',
      [user.sub],
    );
    return { videos: await Promise.all(rows.map(toPublicVideo)) };
  });

  // ---------------------------------------------------- 5) kuyruk gözlemi
  // Teşhis için: kaç iş bekliyor, kaçı işleniyor, kaçı dead-letter'da.
  app.get('/queue/stats', { preHandler: requireAuth }, async () => {
    return { transcode: await queueStats('transcode') };
  });
}
