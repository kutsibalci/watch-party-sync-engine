# Senkron İzleme Motoru + Transkod Pipeline — Yol Haritası

Backend derinliği hedefli portföy projesi. DRM'li içeriğe **hiç dokunmaz** — dolayısıyla
hukuki risk yok, platform bağımlılığı yok, extension kırılması yok.

---

## 1. Kapsam

### v1'de VAR
- Kullanıcı kendi video dosyasını yükler → transkod → HLS olarak sunulur
- YouTube videoları (IFrame API üzerinden, dosya taşınmaz)
- Oda oluşturma, davet linki
- **Senkron oynatma** (play / pause / seek / drift düzeltme)
- Metin sohbet, katılımcı listesi (presence)

### v1'de YOK (bilinçli olarak)
- Netflix / Disney+ / HBO Max → DRM duvarı, çözülemez
- Sesli sohbet → Faz 5'e ertelendi
- Mobil uygulama → web-first
- Ödeme / abonelik → bu bir portföy projesi, ürün değil

### Projenin gerçek amacı
Bu bir startup değil. Amaç şu üç yetkinliği kanıtlanabilir şekilde göstermek:
1. **Stateful gerçek zamanlı servis** tasarımı (çoğu junior sadece stateless CRUD yazar)
2. **Asenkron iş işleme** pipeline'ı (kuyruk, worker, retry, idempotency)
3. **Yatay ölçekleme** ve ölçüm (yük testi, metrik, kırılma noktası analizi)

---

## 2. Mimari

```
                    ┌──────────────┐
                    │   Tarayıcı   │
                    └──┬────────┬──┘
                 HTTP  │        │  WebSocket
                       │        │
              ┌────────▼──┐  ┌──▼────────────┐
              │ API Servis│  │ Realtime      │
              │  (REST)   │  │ Servis (WS)   │
              └──┬─────┬──┘  └──┬─────────┬──┘
                 │     │        │         │
        ┌────────▼─┐ ┌─▼────────▼───┐  ┌──▼──────────┐
        │ Postgres │ │    Redis     │  │  Object     │
        │          │ │ pub/sub +    │  │  Storage    │
        │ kalıcı   │ │ oda state +  │  │ (MinIO/S3)  │
        │  veri    │ │   kuyruk     │  │             │
        └──────────┘ └──┬───────────┘  └──▲──────────┘
                        │ iş çeker         │ segment yazar
                    ┌───▼──────────────────┴──┐
                    │  Transkod Worker        │
                    │  (ffprobe + ffmpeg)     │
                    └─────────────────────────┘
```

### Neden iki ayrı servis?
API stateless ve yatayda serbestçe ölçeklenir. Realtime servis stateful — bağlantılar
belirli bir instance'a bağlıdır. Bunları ayırmak, Faz 3'teki ölçekleme problemini
yalıtır ve gerçek dünyada da böyle yapılır.

### Neden dosya API'den geçmiyor?
Yükleme doğrudan tarayıcıdan object storage'a (presigned URL ile) gider. API sunucusu
gigabaytlarca veriyi proxy'lemez. Bu, mülakatta anlatılacak bilinçli bir tasarım kararı.

---

## 3. Teknoloji seçimi

Mimari dilden bağımsız. Öneri ve alternatifler:

| Bileşen | Öneri | Alternatif | Not |
|---|---|---|---|
| Realtime servis | **Go** (`gorilla/websocket` veya `nhooyr/websocket`) | Node/TS (`ws`), Elixir Phoenix | Go: goroutine modeli WS için ideal, iş piyasası değeri yüksek |
| API servis | Go (`chi`/`gin`) | FastAPI, NestJS | Tek dil kullanmak öğrenci için daha iyi — ikisini de Go yapın |
| Worker | Go + `os/exec` ile ffmpeg | Python + ffmpeg-python | ffmpeg zaten harici süreç, dil önemsiz |
| Veritabanı | PostgreSQL | — | Alternatif aramayın |
| Cache / PubSub / Kuyruk | Redis | NATS (kuyruk için daha doğru) | v1'de Redis, üçünü de yapar |
| Object storage | MinIO (local docker) | S3, Cloudflare R2 | MinIO S3-uyumlu, ücretsiz geliştirme |
| Player | hls.js + YouTube IFrame API | Video.js | hls.js `playbackRate` kontrolü verir — drift düzeltme için şart |
| Yük testi | k6 (WS desteği var) | Locust, Artillery | k6 WebSocket senaryosu yazması kolay |
| Metrik | Prometheus + Grafana | — | Docker compose ile 5 dakikada kurulur |

> **Go bilmiyorsanız:** Node/TypeScript ile başlayın, mimari birebir aynı. Dili öğrenmekle
> uğraşmak, asıl öğrenilecek dağıtık sistem problemlerinden dikkat çalar.

---

## 4. Senkron algoritması — projenin kalbi

Bu bölüm projenin en değerli kısmı. Doğru yapın, README'de detaylandırın.

### 4.1 Otoriter sunucu modeli

Sunucu tek gerçek kaynaktır. Her odanın state'i:

```json
{
  "roomId": "abc123",
  "source":  { "type": "hls", "url": "..." },
  "positionMs": 125300,
  "isPlaying": true,
  "playbackRate": 1.0,
  "updatedAtServerMs": 1733500000000,
  "version": 47
}
```

Bir client'ın **olması gereken** pozisyonu:

```
hedefPozisyon = positionMs + (isPlaying ? (serverNow - updatedAtServerMs) * playbackRate : 0)
```

### 4.2 Saat farkı ölçümü (NTP benzeri)

Client'ın kendi saati sunucununkiyle aynı değil. Ölçün:

```
t0 = client istek gönderim zamanı
t1 = server alım zamanı
t2 = server yanıt gönderim zamanı
t3 = client yanıt alım zamanı

RTT    = (t3 - t0) - (t2 - t1)
offset = ((t1 - t0) + (t2 - t3)) / 2
```

Bunu **8-10 kez** örnekleyin, **en düşük RTT'ye sahip** örneğin offset'ini kullanın
(medyan da olur, ama en düşük RTT daha doğrudur — o pakette kuyruk gecikmesi en azdır).
Bağlantı boyunca 30 saniyede bir yeniden ölçün.

### 4.3 Drift düzeltme — üç kademeli

Bu, kullanıcı şikâyetlerinin bir numarası olan "senkron kayması" probleminin çözümü.
**Asla doğrudan seek yapmayın** — seek deneyimi bozar ve buffer'ı öldürür.

```
sapma = hedefPozisyon - gerçekPozisyon

|sapma| < 100ms        → hiçbir şey yapma  (algılanamaz)
100ms ≤ |sapma| < 1s   → playbackRate = 1.0 ± 0.02, yavaşça yakala, sonra 1.0'a dön
|sapma| ≥ 1s           → hard seek (kaçınılmaz)
```

İkinci kademe en önemlisi: %2 hız farkı kulakla duyulmaz ama 500ms sapmayı 25 saniyede
kapatır. Gerçek ürünlerde kullanılan yöntem budur.

### 4.4 Event protokolü ve sıra garantisi

```
Client → Server:   PLAY | PAUSE | SEEK(toMs) | HEARTBEAT(positionMs) | CHAT(text)
Server → Client:   STATE(fullState) | CHAT | PRESENCE | PONG(t1, t2)
```

**Kritik kural:** her state değişikliğinde `version` artar. Client, kendi gördüğünden
**küçük veya eşit** versiyonlu bir STATE alırsa **yoksayar**.

Bu tek satır, iki ayrı problemi çözer:
- Ağdan sırasız gelen mesajlar (out-of-order delivery)
- İki kullanıcının aynı anda PAUSE basması (last-write-wins, deterministik)

Bunu README'de anlatın — idempotency ve ordering'i anladığınızın kanıtıdır.

### 4.5 Yeniden bağlanma

Client koptuğunda: exponential backoff ile yeniden bağlan → bağlanınca sunucudan tam
STATE iste → saat offset'ini yeniden ölç → drift düzeltmeyi uygula. Kısmi/artımlı state
göndermeye çalışmayın; tam state göndermek çok daha basit ve v1'de yeterli.

---

## 5. Transkod pipeline'ı

### Akış

```
1. POST /api/videos            → DB'ye kayıt (status: pending), presigned PUT URL döner
2. Tarayıcı → doğrudan storage'a yükler (API'yi bypass eder)
3. POST /api/videos/{id}/complete → kuyruğa iş atılır (status: queued)
4. Worker işi çeker            → status: processing
   a. Dosyayı indir
   b. ffprobe ile DOĞRULA  ← güvenlik açısından zorunlu
   c. ffmpeg → HLS, çoklu bitrate (360p + 720p)
   d. Segmentleri + master.m3u8'i storage'a yükle
   e. DB güncelle → status: ready
5. İlerleme: worker ffmpeg stderr'ini parse eder → Redis → WS ile client'a
```

### ffmpeg komutu (başlangıç noktası)

```bash
ffmpeg -i input.mp4 \
  -filter_complex "[0:v]split=2[v1][v2];[v1]scale=w=640:h=360[v1out];[v2]scale=w=1280:h=720[v2out]" \
  -map "[v1out]" -c:v:0 libx264 -b:v:0 800k  -preset veryfast \
  -map "[v2out]" -c:v:1 libx264 -b:v:1 2800k -preset veryfast \
  -map a:0 -c:a aac -b:a 128k -ac 2 \
  -map a:0 -c:a aac -b:a 128k -ac 2 \
  -f hls -hls_time 4 -hls_playlist_type vod \
  -hls_segment_filename "out/%v/seg_%03d.ts" \
  -master_pl_name master.m3u8 \
  -var_stream_map "v:0,a:0 v:1,a:1" "out/%v/index.m3u8"
```

### Güvenlik — çoğu öğrenci projesinde eksik olan kısım

Kullanıcı yüklemesi **düşman girdisidir**. Uygulayın:

- `ffprobe` ile format/süre/codec doğrulaması — uzantıya asla güvenmeyin
- Dosya boyutu ve süre limiti (örn. 2 GB / 3 saat)
- ffmpeg sürecine timeout ve `nice` ile CPU önceliği düşürme
- Worker'ı ayrı container'da, ağ erişimi kısıtlı çalıştırın
- Çıktı yolu enjeksiyonuna karşı dosya adlarını sanitize edin

### Kuyruk — kendiniz yazın

Hazır kütüphane kullanmayın. Redis üzerinde şunları **elle** implemente edin:

- `BRPOPLPUSH` ile atomik iş çekme + in-flight listesi
- **Visibility timeout**: worker çökerse iş geri döner
- **Idempotency**: aynı iş iki kez işlenirse sonuç bozulmamalı (job_id ile DB'de kontrol)
- **Exponential backoff** ile retry (1s, 2s, 4s, 8s…)
- 5 denemeden sonra **dead-letter queue**

Bunlar mülakatta en çok sorulan asenkron konuları. Kendi yazarsanız gerçekten öğrenirsiniz.

---

## 6. Veri modeli (başlangıç)

```sql
users        (id, email, password_hash, created_at)

videos       (id, owner_id, title, status, source_key, hls_master_key,
              duration_ms, size_bytes, error_message, created_at)
              -- status: pending | queued | processing | ready | failed

rooms        (id, owner_id, current_video_id, source_type, is_public, created_at)
              -- source_type: hls | youtube

room_members (room_id, user_id, role, joined_at)
              -- role: host | guest

jobs         (id, type, payload, status, attempts, last_error,
              available_at, created_at)
              -- Redis kuyruğunun kalıcı aynası; audit ve DLQ için
```

**Oynatma state'i Postgres'te DURMAZ.** Saniyede birçok kez değişir — Redis'te,
TTL'li olarak tutulur. Postgres sadece kalıcı veriler için.

---

## 7. Fazlar

### Faz 0 — İskelet · ✅ TAMAMLANDI
- [x] `docker-compose.yml`: postgres, redis, minio, grafana + prometheus
- [x] Repo yapısı: `src/api`, `src/realtime`, `src/worker`, `src/shared`
- [x] Migration aracı (advisory lock + checksum doğrulama) + ilk şema
- [x] Sağlık kontrolü uçları (liveness/readiness ayrı), yapılandırılmış loglama (pino)
- [x] Auth: kayıt, giriş, JWT (scrypt, kullanıcı numaralandırma kapalı)
- [x] Duman testi: 13 senaryo

**Çıktı:** `docker compose --profile app up` ile her şey ayağa kalkıyor. ✅

### Faz 1 — Senkron motoru, TEK instance · ✅ TAMAMLANDI ← Kalp
- [x] WebSocket bağlantı yönetimi, ping/pong ile ölü bağlantı tespiti
- [x] Bellekte oda state'i (`Map<slug, Room>`) — JS tek iş parçacıklı olduğu
      için mutex yok; tüm state mutasyonları senkron tutuldu
- [x] PLAY / PAUSE / SEEK / SET_SOURCE / HEARTBEAT eventleri + version numarası
- [x] PONG ile saat offset ölçümü (en düşük RTT'li örnek seçilir)
- [x] İstemci tarafında üç kademeli drift düzeltme
- [x] Presence (katılımcı listesi), metin sohbet
- [x] Host çıkarsa yeni host seçimi (bağlı en eski üye) ← basit leader election
- [x] YouTube IFrame API entegrasyonu
- [x] Oda API'si: oluştur / getir / katıl / listele
- [x] Senkron testi: 18 senaryo (iki WS istemcisiyle otomatik)

**Çıktı:** İki tarayıcı sekmesi arasında senkron çalışıyor; sapma arayüzdeki
telemetri tablosunda canlı görünüyor. ✅

> **Faz 1'de öğrenilen, plana yazılmamış olan:** YouTube oynatıcısı
> `setPlaybackRate(1.02)` çağrısını `getAvailablePlaybackRates()` listesine
> yuvarlayabiliyor — yani ikinci kademe (%2 hız farkıyla yakalama) her
> oynatıcıda çalışmıyor. Bunu varsaymak yerine **çalışma anında ölçüyoruz**:
> hızı bir kez ayarlayıp geri okuyoruz, tutmazsa daha geniş bantlı seek
> stratejisine düşüyoruz. Faz 2'deki HTML5 `<video>` + hls.js oynatıcısı ince
> hız ayarını tam destekleyecek.

### Faz 2 — Upload + transkod · ✅ TAMAMLANDI
- [x] Presigned URL üretimi, doğrudan MinIO'ya yükleme (API'den geçmez)
- [x] Redis kuyruğu: visibility timeout + reaper + üstel geri çekilme + DLQ
      (**elle yazıldı**, hazır kütüphane yok) — atomik claim Lua betiğiyle
- [x] Worker: ffprobe doğrulama → ffmpeg çoklu bitrate HLS → storage'a yükleme
- [x] İlerleme yayını (ffmpeg `-progress` çıktısı → Redis → API üzerinden yoklama)
- [x] Hata yolu: bozuk dosya, ffmpeg çökmesi, zaman aşımı, yetim çıktı temizliği
- [x] hls.js ile oynatma + senkron motoruyla entegrasyon (oynatıcı adaptörü)
- [x] Hat testi: 14 senaryo (6 kuyruk mekanizması + 8 uçtan uca)

**Çıktı:** Dosya yükle → ilerleme çubuğunu izle → odada arkadaşınla senkron izle. ✅

> **Faz 2'de öğrenilen, plana yazılmamış olanlar:**
>
> **1. Presigned URL'in imzası host'u kapsar.** Docker içinde `S3_ENDPOINT`
> `http://minio:9000`'dir; bu adresle imzalanan URL tarayıcıya verilirse
> tarayıcı `minio` ismini çözemez. Host'u sonradan değiştirmek de imzayı
> bozar. Çözüm: dahili ve genel endpoint'i ayırıp presigned URL'leri **genel**
> adresle imzalamak (`S3_PUBLIC_ENDPOINT`).
>
> **2. Realtime servisinin S3 kimlik bilgisine ihtiyacı yok ama URL üretmesi
> gerekiyor.** Adresleme bilgisi (`S3_PUBLIC_ENDPOINT`, `S3_BUCKET`) temel
> yapılandırmaya, kimlik bilgileri storage bölümüne alındı. En az yetki ilkesi.
>
> **3. Veritabanında mutlak URL saklanmaz.** `videos.hls_master_key` bir
> storage anahtarıdır; URL ortama göre değişir (dev/prod/CDN). Anahtarı saklayıp
> URL'i çalışma anında üretmek taşınabilirlik sağlar.

### Faz 2.5 — Bilinen eksikler (Faz 3/4'e taşındı)
- [ ] İlerleme WebSocket ile **itilmiyor**, istemci yokluyor. Doğru çözümü
      Redis Pub/Sub gerektirir; Faz 3'te oda yayını için zaten kuracağız.
- [ ] WebSocket token'ı query string'de. Tek kullanımlık ticket'a geçilmeli (Faz 4).
- [ ] `public/app.js` protokol sabitlerini `src/shared/protocol.ts`'ten
      **kopyalıyor**. Ortak modülü tarayıcıya derleyip tekrarı kaldırmak gerek (Faz 4).

### Faz 3 — Yatay ölçekleme · ✅ TAMAMLANDI ← En değerli faz
**Önce bilinçli olarak kırıldı.** İkinci realtime instance'ı eklendi, aynı test
çalıştırıldı ve bölünme ölçüldü — sonra çözüldü.

- [x] Kırılma belgelendi → `docs/faz3-kirilma-oncesi.txt` (8/12 test başarısız)
- [x] Redis Pub/Sub: her instance `room:{slug}` kanalına abone olur; abonelik
      ilk yerel bağlantıda açılır, son bağlantıda kapanır
- [x] Oda state'i Redis HASH'e taşındı; geçişler tek Lua betiğinde **atomik**
      (oku → ilerlet → değiştir → versiyon++ → yaz → **yayınla**)
- [x] Presence tüm instance'lara yayıldı; kalp atışı ZSET'i ile hayalet üye temizliği
- [x] Host seçimi Redis'ten okunuyor — tüm instance'lardaki en eski canlı üye
- [x] Yarış durumu testi: iki instance'a 10 zıt komut → tek versiyonda buluşuyor
- [x] Nazik kapanış: 1012 sinyali + Redis'ten üye düşürme
- [x] Ölçekleme testi: 12 senaryo → `docs/faz3-kirilma-sonrasi.txt`

**Çıktı:** İki instance, kullanıcılar hangisine düşerse düşsün senkron çalışıyor. ✅

**Ölçülen fark:**

| | Öncesi (bellek) | Sonrası (Redis) |
|---|---|---|
| Test sonucu | 4 geçti / 8 kaldı | **12 geçti / 0 kaldı** |
| Host | **İki ayrı host** (split-brain) | Tek host, iki instance da aynı |
| Versiyon | A=v2, B=v1 (ayrıştı) | İkisi de v13 (10 zıt komut sonrası) |
| Pozisyon farkı | **8.460 ms** | **0,0 ms** |
| Sohbet / komut | Karşı tarafa ulaşmıyor | Ulaşıyor |

> **Faz 3'te öğrenilen, plana yazılmamış olanlar:**
>
> **1. Yayın, betiğin İÇİNDE olmalı.** Versiyonu artırıp sonra ayrı bir komutla
> `PUBLISH` etseydik, iki instance'ın yayınları versiyon sırasından farklı
> sırada çıkabilirdi. İstemci "eski versiyon" diye doğru mesajı atardı. Lua
> betiği hem mutasyonu hem yayını tek atomik adımda yapıyor.
>
> **2. Test yanlış sebeple geçebilir.** "Host devri" testi kırık sürümde de
> geçiyordu: B yalnızca kendini gördüğü için zaten host'tu. Teste ön koşul
> eklendi — devirden önce B'nin Alice'i host GÖRDÜĞÜ doğrulanıyor. Geçen bir
> test, doğru şeyi test ettiğinin kanıtı değildir.
>
> **3. "Kim sağ?" sorusu kalp atışıyla cevaplanır.** Bir instance çökerse
> bıraktığı üye kayıtlarını kimse silmez. ZSET'te son görülme zamanı tutuluyor;
> 45 saniyedir görülmeyen üye listeden düşüyor. Bu, kuyruktaki visibility
> timeout ile **aynı fikir** — dağıtık sistemlerde tekrar eden bir desen.
>
> **4. `--scale` yerine ayrı portlar.** Compose ölçeklemesinde hangi istemcinin
> hangi replikaya düştüğü rastgeledir; test kâh geçer kâh kalır. Ayrı portlar
> bölünmeyi deterministik olarak üretir. Üretimde önlerine yük dengeleyici
> konur ve bu, uygulama kodunu etkilemez — state zaten paylaşımlı.

### Faz 4 — Yük testi ve gözlemlenebilirlik · ✅ TAMAMLANDI

- [x] Prometheus metrikleri (`sync_drift_ms`, `ws_broadcast_latency_ms`,
      `ws_join_duration_ms`, kuyruk ve HTTP metrikleri)
- [x] Grafana panosu **kod olarak** sağlanıyor (`ops/grafana/provisioning/`)
- [x] k6 WebSocket senaryosu, Docker içinde — host'a kurulum yok
- [x] 800 → 2.500 → 5.000 eşzamanlı bağlantı taraması
- [x] **Kırılma noktası bulundu ve belgelendi** → [`docs/yuk-testi.md`](./docs/yuk-testi.md)
- [x] Teknik borç kapatıldı: WS bileti, protokol tekrarı, ilerleme push'u
- [x] Üretim imajı (çok aşamalı, root olmayan, tsx'siz) + GitHub Actions CI

**Ölçülen:**

| Kurulum | Bağlantı | Yayın p95 | Yayın p99 | Sonuç |
|---|---|---|---|---|
| 1 instance | 800 | 5 ms | 30 ms | sağlıklı |
| 1 instance | 2.500 | 258 ms | 1.609 ms | ❌ doydu |
| 2 instance | 2.500 | 14 ms | 47 ms | ✅ |
| 2 instance | 5.000 | 27 ms | 74 ms | ✅ |

> **Faz 4'te öğrenilen, plana yazılmamış olanlar:**
>
> **1. Yük üreteci de bir darboğazdır.** 5.000 VU'da HELLO gecikmesi 9,4
> saniye görünüyordu. İki yanlış hipotez (Postgres havuzu, TCP accept kuyruğu)
> denendi ve ikisi de hiçbir şey değiştirmedi. Ölçüm gerçeği gösterdi: aynı
> anda HTTP 3 ms, sunucu tarafı katılım 34 ms. Yük iki k6 konteynerine
> bölününce HELLO 97 ms'ye düştü — **sunucuda hiçbir şey değişmeden.**
>
> **2. Enstrümantasyon olmadan optimizasyon tahmindir.** `ws_join_duration_ms`
> metriği eklenene kadar üç tur boyunca yanlış yerleri düzeltmeye çalıştık.
>
> **3. Doğrusal olmayan iyileşme normaldir.** Instance sayısını ikiye
> katlamak gecikmeyi yarıya değil **34 kata** düşürdü; çünkü tek instance
> dirseği geçmişti ve kuyruklar üstel büyüyordu.
>
> **4. `p(99)` k6'nın varsayılan özetinde YOKTUR.** `summaryTrendStats`
> açıkça verilmezse kırılma noktası aramanın tamamı görünmez.

### Faz 5 — Sesli sohbet (WebRTC) · ⏸ BİLİNÇLİ OLARAK ERTELENDİ

Mesh P2P ≤5 katılımcıya kadar çalışır; ötesinde SFU gerekir ve bu ayrı bir
projedir. Mevcut kapsamı derinleştirmek, yeni bir yarım özellik eklemekten
daha değerli görüldü. Analiz ve mimari kararlar bu belgede duruyor (bkz.
P2P bölümü); uygulanmadı ve README'de eksik olarak işaretlendi.

<details>
<summary>Faz 4 orijinal planı (referans)</summary>
- [ ] Prometheus metrikleri:
      - `ws_active_connections` (gauge)
      - `ws_broadcast_latency_ms` (histogram)
      - `sync_drift_ms` (histogram) ← projeye özgü, en etkileyici metrik
      - `transcode_duration_seconds`, `job_retries_total`, `job_dlq_total`
- [ ] Grafana dashboard
- [ ] k6 WebSocket senaryosu: N oda × M kullanıcı, rastgele play/pause/seek
- [ ] Ölçüm: 100 → 500 → 1000 → 2000 eşzamanlı bağlantı
- [ ] **Kırılma noktasını bulun.** Nerede, neden, nasıl düzelttiniz?
- [ ] Grafik: eşzamanlı bağlantı sayısı vs p99 broadcast gecikmesi

**Çıktı:** README'de "tek instance 1.400 bağlantıda p99 gecikme 180ms'ye çıktı, sebep
X'ti, Y ile 3.000'e taşıdım" cümlesi. CV'nizin en güçlü satırı bu olacak.

</details>

### Faz 5 planı (uygulanmadı — referans)
- [ ] Sinyalleşme (mevcut WS kanalı üzerinden)
- [ ] Mesh P2P, **≤5 katılımcı** sınırı
- [ ] coturn TURN sunucusu (docker) — oturumların %25-30'u buna düşecek
- [ ] Film sesini konuşma sırasında kısma (ducking)
- [ ] 6. kişi katılınca SFU'ya düşme (çok daha büyük iş)

---

## 8. Yük testi planı

```js
// k6 — scripts/load/ws.js iskeleti
import ws from 'k6/ws';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const broadcastLatency = new Trend('broadcast_latency_ms');

export const options = {
  stages: [
    { duration: '2m', target: 200 },
    { duration: '3m', target: 1000 },
    { duration: '3m', target: 2000 },   // kırılma noktasını ara
    { duration: '2m', target: 0 },
  ],
};

export default function () {
  const roomId = `room-${__VU % 200}`;   // 200 oda, VU'lar dağıtılır
  ws.connect(`ws://127.0.0.1:8091/ws?room=${roomId}`, {}, (socket) => {
    socket.on('open', () => {
      socket.setInterval(() => {
        socket.send(JSON.stringify({ type: 'HEARTBEAT', sentAt: Date.now() }));
      }, 5000);
    });
    socket.on('message', (msg) => {
      const m = JSON.parse(msg);
      if (m.type === 'STATE' && m.echoOf) {
        broadcastLatency.add(Date.now() - m.echoOf);
      }
    });
    socket.setTimeout(() => socket.close(), 60000);
  });
}
```

**Ölçülecekler:** eşzamanlı bağlantı, broadcast gecikmesi (p50/p95/p99), instance başına
bellek, CPU, Redis pub/sub throughput, dosya tanımlayıcı (fd) limiti.

**Beklenen ilk kırılma noktaları** (bunları bulmak öğrenmenin kendisi):
- İşletim sistemi fd limiti (`ulimit -n`)
- Her bağlantı için ayrı goroutine + büyük buffer → bellek
- Broadcast'te oda mutex'inin uzun süre tutulması → kuyruk birikmesi
- Redis pub/sub'da tek kanaldan fan-out darboğazı

---

## 9. README nasıl yazılmalı

Portföy değerinin yarısı buradan gelir. Karar günlüğü gibi yazın:

```markdown
# Senkron İzleme Motoru

## Ne yapar
[2 cümle + 15 saniyelik GIF]

## Mimari
[yukarıdaki diyagram]

## Çözdüğüm teknik problemler
### 1. Saat senkronu ve drift düzeltme
Problem: ... / Denedim: ... / Neden yetersizdi: ... / Çözüm: ... / Sonuç: p95 sapma 40ms

### 2. Sırasız mesajlar ve eşzamanlı komutlar
Problem: iki kullanıcı aynı anda pause bastığında state salınıyordu
Çözüm: monotonik version numarası + client-side eski versiyon reddi

### 3. İki instance'a çıkınca odaların bölünmesi
[kırılma ekran görüntüsü] → Redis Pub/Sub → [düzelme ekran görüntüsü]

### 4. Kuyrukta exactly-once neden imkânsız
at-least-once + idempotency key yaklaşımı ve visibility timeout implementasyonu

## Yük testi sonuçları
[grafik] Tek instance: 1.400 bağlantıda p99 = 180ms. Darboğaz: ...
3 instance + Redis: 4.200 bağlantı, p99 = 95ms.

## Çalıştırma
docker compose up
```

**Yapmayın:** özellik listesi, teknoloji rozetleri, "modern ve hızlı" gibi ifadeler.
**Yapın:** problem → deneme → başarısızlık → çözüm → ölçüm.

---

## 10. Bu proje neyi kanıtlıyor

| Yetkinlik | Kanıt |
|---|---|
| Stateful gerçek zamanlı sistemler | WebSocket oda motoru, presence, reconnect |
| Dağıtık sistemler temelleri | Saat senkronu, versiyonlama, leader election, pub/sub |
| Asenkron iş işleme | Kendi kuyruğu: retry, DLQ, visibility timeout, idempotency |
| Ölçekleme | Tek instance → çoklu instance geçişi ve ölçülmüş sonuç |
| Gözlemlenebilirlik | Prometheus metrikleri, Grafana, yük testi raporu |
| Güvenlik bilinci | Kullanıcı yüklemesini düşman girdisi olarak ele alma |
| Mühendislik yargısı | DRM'li içeriği kapsam dışı bırakma kararı ve gerekçesi |

Son satır önemsiz görünüyor ama değil: **neyi yapmamaya karar verdiğinizi gerekçesiyle
anlatabilmek**, kıdemli mühendis davranışıdır ve mülakatta fark edilir.

---

## 11. Sık yapılan hatalar

1. **Faz 3'ü atlamak.** Tek instance'ta kalırsa proje sıradanlaşır. Asıl değer orada.
2. **Redis'i baştan eklemek.** Önce kırın, sonra çözün. Kırılmayı görmeden öğrenilmez.
3. **Hazır kuyruk kütüphanesi kullanmak.** Öğrenme değerinin yarısını siler.
4. **Yük testi yapmamak.** Sayı olmayan proje, iddia olmayan projedir.
5. **Kapsamı büyütmek.** Sesli sohbet, mobil, ödeme… Faz 4'ü bitirmeden hiçbirine bakmayın.
6. **Netflix'e "sadece deneme olsun" diye dokunmak.** Kapsam dışı, tartışmaya kapalı.
