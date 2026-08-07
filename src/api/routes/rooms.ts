import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { queryOne, query, isUniqueViolation, withTransaction } from '../../shared/db.ts';
import { badRequest, notFound, forbidden, conflict, internal } from '../../shared/errors.ts';
import { requireAuth, currentUser } from '../middleware/auth.ts';
import { issueTicket } from '../../shared/ticket.ts';

type RoomRow = {
  id: string;
  slug: string;
  name: string;
  owner_id: string;
  source_type: 'hls' | 'youtube';
  youtube_video_id: string | null;
  current_video_id: string | null;
  is_public: boolean;
  created_at: Date;
};

const CreateRoomSchema = z.object({
  name: z.string().trim().min(1, 'Oda adı boş olamaz').max(100),
  // Faz 1'de yalnızca YouTube. HLS kaynakları Faz 2'de transkod ile gelecek.
  youtubeVideoId: z
    .string()
    .regex(/^[\w-]{11}$/, 'Geçerli bir YouTube video kimliği girin (11 karakter)')
    .optional(),
  isPublic: z.boolean().default(false),
});

function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw badRequest(
      'İstek gövdesi geçersiz',
      result.error.issues.map((i) => ({
        field: i.path.join('.') || '(kök)',
        message: i.message,
      })),
    );
  }
  return result.data;
}

/** Slug şema kısıtına uymalı: ^[a-z0-9-]{6,32}$ */
function generateSlug(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'; // karışan karakterler (l,o,0,1) yok
  const bytes = randomBytes(10);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function toPublicRoom(row: RoomRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    sourceType: row.source_type,
    youtubeVideoId: row.youtube_video_id,
    isPublic: row.is_public,
    createdAt: row.created_at,
  };
}

export async function registerRoomRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------ oda oluştur
  app.post('/', { preHandler: requireAuth }, async (req, reply) => {
    const user = currentUser(req);
    const { name, youtubeVideoId, isPublic } = parseBody(CreateRoomSchema, req.body);

    // Slug çakışması astronomik derecede düşük olasılıklı (32^10) ama
    // "düşük olasılık" != "imkânsız". Yarışı SELECT ile değil, benzersizlik
    // kısıtının ihlalini yakalayıp yeniden deneyerek kapatıyoruz.
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = generateSlug();
      try {
        const row = await withTransaction(async (client) => {
          const inserted = await client.query<RoomRow>(
            `INSERT INTO rooms (slug, owner_id, name, source_type, youtube_video_id, is_public)
             VALUES ($1, $2, $3, 'youtube', $4, $5)
             RETURNING id, slug, name, owner_id, source_type, youtube_video_id,
                       current_video_id, is_public, created_at`,
            [slug, user.sub, name, youtubeVideoId ?? null, isPublic],
          );
          const created = inserted.rows[0];
          if (!created) throw internal('INSERT ... RETURNING satır döndürmedi');

          // Oda sahibi kalıcı 'host' rolüyle üye kaydedilir.
          // NOT: buradaki 'host' KALICI sahipliktir. Odayı o an kimin
          // yönettiği (etkin host) ise realtime servisinde, bağlı en eski
          // üye olarak belirlenir — ikisini karıştırmayın.
          await client.query(
            `INSERT INTO room_members (room_id, user_id, role)
             VALUES ($1, $2, 'host')
             ON CONFLICT (room_id, user_id) DO NOTHING`,
            [created.id, user.sub],
          );
          return created;
        });

        req.log.info({ roomId: row.id, slug: row.slug, userId: user.sub }, 'Oda oluşturuldu');
        return reply.status(201).send({ room: toPublicRoom(row) });
      } catch (err) {
        if (isUniqueViolation(err)) continue; // slug çakıştı, yeniden dene
        throw err;
      }
    }

    throw internal('Benzersiz oda kimliği üretilemedi');
  });

  // -------------------------------------------------------------- oda getir
  app.get('/:slug', { preHandler: requireAuth }, async (req) => {
    const { slug } = req.params as { slug: string };

    const row = await queryOne<RoomRow>(
      `SELECT id, slug, name, owner_id, source_type, youtube_video_id,
              current_video_id, is_public, created_at
         FROM rooms WHERE slug = $1`,
      [slug],
    );
    if (!row) throw notFound('Oda bulunamadı');

    return { room: toPublicRoom(row) };
  });

  // --------------------------------------------------------------- odaya gir
  // Kalıcı üyelik kaydı. Gerçek zamanlı katılım WebSocket üzerinden olur;
  // bu uç yalnızca "bu kullanıcı bu odaya girmişti" bilgisini saklar.
  app.post('/:slug/join', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const { slug } = req.params as { slug: string };

    const row = await queryOne<RoomRow>('SELECT id, slug FROM rooms WHERE slug = $1', [slug]);
    if (!row) throw notFound('Oda bulunamadı');

    await query(
      `INSERT INTO room_members (room_id, user_id, role)
       VALUES ($1, $2, 'guest')
       ON CONFLICT (room_id, user_id) DO NOTHING`,
      [row.id, user.sub],
    );

    return { joined: true, slug: row.slug };
  });

  // ------------------------------------------- WebSocket bileti (Faz 4)
  // Tarayıcı WebSocket'te özel başlık gönderemediği için JWT'yi query
  // string'de taşımak zorundaydık. Bilet bunu 30 saniyelik, tek kullanımlık
  // ve tek odaya kilitli bir sırra indiriyor.
  app.post('/:slug/ticket', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const { slug } = req.params as { slug: string };

    const room = await queryOne<RoomRow>('SELECT id, slug FROM rooms WHERE slug = $1', [slug]);
    if (!room) throw notFound('Oda bulunamadı');

    const { ticket, expiresInSeconds } = await issueTicket({
      userId: user.sub,
      displayName: user.displayName,
      slug: room.slug,
    });

    return { ticket, expiresInSeconds };
  });

  // ------------------------------------------------- odaya video bağla (Faz 2)
  // Odanın kaynağını YouTube'dan, transkod edilmiş kendi videomuza çevirir.
  app.patch('/:slug/video', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const { slug } = req.params as { slug: string };
    const { videoId } = parseBody(
      z.object({ videoId: z.string().uuid() }),
      req.body,
    );

    const room = await queryOne<RoomRow>('SELECT * FROM rooms WHERE slug = $1', [slug]);
    if (!room) throw notFound('Oda bulunamadı');
    if (room.owner_id !== user.sub) throw forbidden('Odanın kaynağını yalnızca sahibi değiştirebilir');

    const video = await queryOne<{ id: string; status: string; owner_id: string }>(
      'SELECT id, status, owner_id FROM videos WHERE id = $1',
      [videoId],
    );
    if (!video) throw notFound('Video bulunamadı');
    if (video.owner_id !== user.sub) throw forbidden('Bu video size ait değil');
    if (video.status !== 'ready') {
      throw conflict(`Video henüz hazır değil (durum: ${video.status})`);
    }

    // rooms_source_consistent kısıtı: hls kaynağında youtube_video_id NULL olmalı.
    const updated = await queryOne<RoomRow>(
      `UPDATE rooms
          SET source_type = 'hls', current_video_id = $2, youtube_video_id = NULL
        WHERE id = $1
        RETURNING *`,
      [room.id, videoId],
    );

    req.log.info({ slug, videoId }, 'Oda kaynağı HLS videoya çevrildi');
    return { room: toPublicRoom(updated!) };
  });

  // ------------------------------------------------------------ odalarım
  app.get('/', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const { rows } = await query<RoomRow>(
      `SELECT r.id, r.slug, r.name, r.owner_id, r.source_type, r.youtube_video_id,
              r.current_video_id, r.is_public, r.created_at
         FROM rooms r
         JOIN room_members m ON m.room_id = r.id
        WHERE m.user_id = $1
        ORDER BY r.created_at DESC
        LIMIT 50`,
      [user.sub],
    );
    return { rooms: rows.map(toPublicRoom) };
  });
}
