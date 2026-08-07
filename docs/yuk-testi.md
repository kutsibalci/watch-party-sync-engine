# Faz 4 — Yük testi: ölçümler, kırılma noktaları ve yanlış alarmlar

Bu belge "sistem hızlı" demek için değil, **nerede ve neden kırıldığını**
göstermek için var. Üç ayrı darboğaz bulundu; ikisi gerçek, biri yanlış alarm.

Test aracı: k6, compose ağının içinden (Docker port yayınlama katmanı ölçüme
karışmasın diye). Script: [`ops/k6/ws-load.js`](../ops/k6/ws-load.js).

Donanım: 16 vCPU / 16 GB, Docker Desktop (WSL2). Tüm servisler aynı makinede —
yani sunucu, veritabanı ve yük üreteci CPU için yarışıyor. Mutlak sayılar
donanıma bağlıdır; **anlamlı olan karşılaştırmalar**.

## Ölçülen metrik

`broadcast_latency`: bir istemci komut gönderdiğinde, sunucunun yayınladığı
`STATE` mesajının **aynı istemciye geri dönmesi** ne kadar sürüyor.

Bu, yolun tamamını kapsar: soket → Lua betiği → Redis `PUBLISH` → abone
instance → soket. Sadece HTTP gecikmesi değil, gerçek fan-out maliyeti.

`hello_latency`: `ws.connect()` çağrısından `HELLO` mesajının alınmasına kadar.
Bağlantı kurulum maliyetini ölçer.

---

## Sonuçlar

| # | Kurulum | Toplam VU | Yayın p95 | Yayın p99 | HELLO p95 | Sonuç |
|---|---|---|---|---|---|---|
| 1 | 1 instance · 1 k6 | 800 | 5 ms | 30 ms | 21 ms | sağlıklı |
| 2 | 1 instance · 1 k6 | 2.500 | **258 ms** | **1.609 ms** | **8.700 ms** | ❌ sunucu doydu |
| 3 | 2 instance · 1 k6 | 2.500 | 14 ms | 47 ms | 48 ms | sağlıklı |
| 4 | 2 instance · 1 k6 | 5.000 | 130 ms | 203 ms | **9.400 ms** | ⚠ yanlış alarm |
| 5 | 2 instance · **2 k6** | 5.000 | **27 ms** | **74 ms** | **97 ms** | sağlıklı |

Ham çıktılar: [`docs/loadtest/`](./loadtest/)

---

## Kırılma #1 — Tek instance 2.500 bağlantıda doyuyor (GERÇEK)

Satır 2 ile 3 karşılaştırılınca net görünüyor: **aynı yük üreteci, aynı 2.500
VU**, tek fark instance sayısı.

```
1 instance:  yayın p99 = 1.609 ms   HELLO p95 = 8.700 ms
2 instance:  yayın p99 =    47 ms   HELLO p95 =    48 ms
```

Instance sayısını ikiye katlamak gecikmeyi yarıya indirmedi — **34 kat**
düşürdü. Sebebi doğrusal olmaması: tek instance dizinin dizinin dirseğini
(knee) geçmişti. Doygunluğa ulaşmış bir sistemde kuyruklar üstel büyür.

Sunucu tarafı kanıt: `nodejs_eventloop_lag_p99_seconds = 0,24 s`. Node'un olay
döngüsü 240 ms geride kalıyordu, yayın p99'u (203–269 ms) neredeyse tamamen
bununla açıklanıyor.

---

## Kırılma #2 — Presence fırtınası (GERÇEK, düzeltildi)

Naif hâlde **her** katılım ve ayrılma anında `PRESENCE` yayınlanıyordu. Her
yayın, abone **her instance**'ta şunu tetikliyordu:

```
2 Redis çağrısı (zrangebyscore + hgetall)  +  odadaki HER sokete bir gönderim
```

Maliyet **O(katılım × instance × üye)**. 5.000 bağlantı 250 odaya yayılırken
bu on binlerce gereksiz gönderim demekti.

**Çözüm:** presence yayınları 250 ms penceresinde birleştiriliyor
(`PRESENCE_COALESCE_MS`). Presence zaten "en son hâli" gösteren bir görünüm;
ara durumları göndermenin hiçbir değeri yok. Kullanıcı 250 ms'yi fark etmez.

Etki: HELLO p95 11.900 ms → 8.400 ms. İyileşme gerçek ama yetersizdi — çünkü
asıl sebep bu değildi. Bkz. #3.

---

## Yanlış alarm #3 — Darboğaz yük üretecinin kendisiydi

Satır 4'te HELLO p95 = 9.400 ms görünüyordu. İlk iki hipotez **yanlış çıktı**:

| Hipotez | Yapılan | Sonuç |
|---|---|---|
| Postgres havuzu (max=10) darboğaz | Oda satırı önbelleğe alındı, havuz 20'ye çıkarıldı | HELLO değişmedi |
| TCP accept kuyruğu taşıyor | `backlog` 511 → 4.096 | HELLO değişmedi |

Tahmin etmeyi bırakıp **ölçtük**. Üç kanıt aynı yöne işaret etti:

**1. Aynı anda HTTP kusursuzdu.** Bilet için yapılan API çağrısı, HELLO 9
saniyeyken bile p50 = 3 ms, p95 = 7 ms. Host global olarak doygun olsaydı bu
da bozulurdu.

**2. Sunucu tarafı katılım hızlıydı.** `ws_join_duration_ms` metriği eklendi
(bilet doğrulama + oda yükleme + Redis'e katılım + üye okuma):

```
:8091  6.789 katılım · ortalama 34,3 ms · %99,2'si 250 ms altında
:8092  6.796 katılım · ortalama 33,5 ms · %99,2'si 250 ms altında
```

**3. Kesin deney.** Aynı sunucu, aynı toplam 5.000 VU — sadece yük **iki ayrı
k6 konteynerine** bölündü:

```
1 k6 konteyneri (5.000 VU):   HELLO p95 = 9.400 ms   yayın p95 = 130 ms
2 k6 konteyneri (2×2.500):    HELLO p95 =    97 ms   yayın p95 =  27 ms
```

Sunucu tarafında **hiçbir şey değişmedi**. Gecikme, k6'nın tek süreçte 5.000
sanal kullanıcının soket olay döngülerini zamanlamasından kaynaklanıyordu.

> **Alınan ders:** Yük testi sonuçlarına inanmadan önce yük üretecinin kendisinin
> darboğaz olmadığını kanıtlayın. Sunucu tarafı enstrümantasyon olmasaydı
> günlerce olmayan bir sorunu "optimize" edebilirdik.

---

## Gerçek kapasite (5.000 eşzamanlı bağlantı, 2 instance)

Yük üreteci doğru boyutlandırıldığında:

```
Yayın gecikmesi     p50  ~2 ms   p95  27 ms   p99  74 ms
HELLO gecikmesi     p50  ~9 ms   p95  97 ms   p99 310 ms
Saat senkron RTT    p50   1 ms   p95  18 ms
Komut teslim oranı  %100
Bağlantı hatası     0
```

Bu, tek bir geliştirici makinesinde, 250 oda üzerine dağılmış 5.000 eşzamanlı
WebSocket bağlantısıdır. Sistem doymuş değil; bir sonraki dirsek için daha
fazla k6 konteyneri gerekir.

---

## Yeniden üretmek için

```bash
# Altyapı + uygulama
docker compose --profile app up -d

# Tek instance, 2.500 VU  → kırılmayı görün
K6_TARGET_VUS=2500 K6_ROOM_COUNT=150 K6_WS_URLS=ws://realtime:8091/ws \
  docker compose --profile app --profile load run --rm k6 run /scripts/ws-load.js

# İki instance, aynı yük → farkı görün
K6_TARGET_VUS=2500 K6_ROOM_COUNT=150 \
  docker compose --profile app --profile load run --rm k6 run /scripts/ws-load.js
```

`QUICK=1` ile 40 saniyelik doğrulama koşusu yapılabilir.

## Bilinen sınırlar

- Tüm bileşenler tek makinede; gerçek dağıtımda ağ gecikmesi eklenir.
- k6 tek konteynerde 2.500 VU'dan sonra kendi darboğazına giriyor.
- Redis tek düğüm. Instance sayısı arttıkça `PUBLISH` fan-out'u Redis'te
  doğrusal büyür; sonraki adım Redis Cluster veya oda→instance yönlendirmesi
  (consistent hashing) olur.
