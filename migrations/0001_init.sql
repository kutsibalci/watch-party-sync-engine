-- 0001_init.sql — temel şema
--
-- Tasarım notu: OYNATMA STATE'İ (pozisyon, isPlaying, version) BU ŞEMADA YOKTUR.
-- Saniyede birçok kez değişir; Postgres'e yazmak hem gereksiz hem de darboğaz olur.
-- Oda oynatma state'i Redis'te, TTL'li olarak tutulur (Faz 1/3).
-- Buradaki tablolar yalnızca kalıcı olması gereken veriler içindir.

-- ---------------------------------------------------------------- Yardımcılar
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------------- users
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  -- Büyük/küçük harf duyarsız benzersizlik: e-posta'nın kendisini bozmadan
  -- normalize edilmiş bir kopya üzerinden unique index kuruyoruz.
  email_norm    text GENERATED ALWAYS AS (lower(email)) STORED,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_email_len CHECK (char_length(email) BETWEEN 3 AND 254),
  CONSTRAINT users_display_name_len CHECK (char_length(display_name) BETWEEN 1 AND 64)
);

CREATE UNIQUE INDEX users_email_norm_key ON users (email_norm);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------------ videos
CREATE TYPE video_status AS ENUM ('pending', 'queued', 'processing', 'ready', 'failed');

CREATE TABLE videos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          text NOT NULL,
  status         video_status NOT NULL DEFAULT 'pending',

  source_key     text,          -- storage'daki ham yükleme anahtarı
  hls_master_key text,          -- transkod sonrası master.m3u8 anahtarı
  duration_ms    bigint,
  size_bytes     bigint,
  error_message  text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT videos_title_len CHECK (char_length(title) BETWEEN 1 AND 200),
  -- 'ready' olan her videonun oynatılabilir bir manifesti olmalı
  CONSTRAINT videos_ready_needs_manifest
    CHECK (status <> 'ready' OR hls_master_key IS NOT NULL)
);

CREATE INDEX videos_owner_created_idx ON videos (owner_id, created_at DESC);
-- Kısmi index: worker yalnızca bitmemiş işlerle ilgilenir, index küçük kalır
CREATE INDEX videos_pending_idx ON videos (status, created_at)
  WHERE status <> 'ready';

CREATE TRIGGER videos_set_updated_at
  BEFORE UPDATE ON videos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------------- rooms
CREATE TYPE room_source_type AS ENUM ('hls', 'youtube');

CREATE TABLE rooms (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL,          -- davet linkinde görünen kısa kimlik
  owner_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             text NOT NULL,

  source_type      room_source_type NOT NULL DEFAULT 'youtube',
  current_video_id uuid REFERENCES videos(id) ON DELETE SET NULL,
  youtube_video_id text,

  is_public        boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rooms_slug_format CHECK (slug ~ '^[a-z0-9-]{6,32}$'),
  CONSTRAINT rooms_name_len CHECK (char_length(name) BETWEEN 1 AND 100),
  -- Kaynak tipi ile dolu alan tutarlı olmalı
  CONSTRAINT rooms_source_consistent CHECK (
    (source_type = 'hls'     AND youtube_video_id IS NULL) OR
    (source_type = 'youtube' AND current_video_id IS NULL)
  )
);

CREATE UNIQUE INDEX rooms_slug_key ON rooms (slug);
CREATE INDEX rooms_owner_idx ON rooms (owner_id, created_at DESC);

CREATE TRIGGER rooms_set_updated_at
  BEFORE UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------ room_members
CREATE TYPE room_role AS ENUM ('host', 'guest');

CREATE TABLE room_members (
  room_id   uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      room_role NOT NULL DEFAULT 'guest',
  joined_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX room_members_user_idx ON room_members (user_id);
-- Bir odada en fazla bir host olabilir (Faz 1'deki host devri bu kısıtla korunur)
CREATE UNIQUE INDEX room_members_single_host_idx ON room_members (room_id)
  WHERE role = 'host';

-- -------------------------------------------------------------------- jobs
-- Redis kuyruğunun kalıcı aynası. Redis hızlı yolu, Postgres ise denetim
-- (audit), yeniden deneme geçmişi ve dead-letter incelemesi içindir.
CREATE TYPE job_status AS ENUM ('queued', 'in_flight', 'succeeded', 'failed', 'dead');

CREATE TABLE jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text NOT NULL,                 -- örn. 'transcode'
  payload         jsonb NOT NULL,
  status          job_status NOT NULL DEFAULT 'queued',

  attempts        int NOT NULL DEFAULT 0,
  max_attempts    int NOT NULL DEFAULT 5,
  last_error      text,

  available_at    timestamptz NOT NULL DEFAULT now(),  -- üstel geri çekilme için
  locked_at       timestamptz,                         -- visibility timeout başlangıcı
  locked_by       text,                                -- worker kimliği

  -- Aynı işin iki kez kuyruğa girmesini veritabanı seviyesinde engeller.
  -- Faz 2'deki idempotency tartışmasının temel taşı.
  idempotency_key text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT jobs_attempts_sane CHECK (attempts >= 0 AND attempts <= max_attempts + 1)
);

CREATE UNIQUE INDEX jobs_idempotency_key_uq ON jobs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Worker'ın "alınabilir iş" taraması bu index'i kullanır
CREATE INDEX jobs_claimable_idx ON jobs (type, available_at)
  WHERE status IN ('queued', 'in_flight');

CREATE INDEX jobs_dead_idx ON jobs (created_at DESC)
  WHERE status = 'dead';

CREATE TRIGGER jobs_set_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
