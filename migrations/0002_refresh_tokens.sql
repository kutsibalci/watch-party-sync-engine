-- 0002_refresh_tokens.sql — dönen (rotating) yenileme jetonları
--
-- Erişim jetonu 15 dakikalık ve bu bilinçli: JWT iptal edilemez, o yüzden
-- çalındığında zararı ömrüyle sınırlı olmalı. Ama iki saatlik bir filmi 15
-- dakikada bir yeniden giriş yaparak izlemek de olmaz — bağlantı koptuğunda
-- "Oturum süresi doldu" alıp odadan düşülüyordu.
--
-- Çözüm ikinci bir jeton: uzun ömürlü ama İPTAL EDİLEBİLİR ve tek kullanımlık.
--
-- Neden Redis değil de Postgres? Bu jeton bir aylık ömür taşıyor ve iptal
-- edilebilmesi güvenliğin kendisi. Bilet (30 saniyelik, Redis'te) kaybolsa
-- yeniden alınır; yenileme jetonu kaybolursa herkes çıkışa düşer.

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Jetonun KENDİSİ değil SHA-256 özeti durur. Veritabanı sızarsa özetlerle
  -- oturum açılamaz. Parola gibi yavaş özet gerekmiyor: jeton 32 bayt rastgele,
  -- sözlük saldırısına konu değil.
  token_hash  text NOT NULL,

  -- Aynı girişten türeyen bütün jetonlar aynı aileyi paylaşır. Kullanılmış bir
  -- jeton ikinci kez sunulursa bu bir çalıntı işaretidir ve aileyi topluca
  -- iptal ediyoruz — saldırgan da meşru kullanıcı da yeniden giriş yapar.
  family_id   uuid NOT NULL,

  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- Döndürüldüyse dolu: tek kullanımlığın kanıtı ve yeniden kullanım tespitinin
  -- dayanağı.
  replaced_at timestamptz,
  revoked_at  timestamptz
);

CREATE UNIQUE INDEX refresh_tokens_hash_key ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
-- Süresi geçmişleri toplamak için
CREATE INDEX refresh_tokens_expiry_idx ON refresh_tokens (expires_at);
