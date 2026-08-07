# Yük testi ham çıktıları

Her dosya bir k6 koşusunun özetidir. Analiz ve yorum:
[`../yuk-testi.md`](../yuk-testi.md)

Adlandırma: `<instance sayısı>x-<hedef VU>[-değişiklik].json`

| Dosya | Kurulum | Neyi gösteriyor |
|---|---|---|
| `1x-800vu.json` | 1 instance · 800 VU | Sağlıklı taban çizgisi |
| `1x-2500vu.json` | 1 instance · 2.500 VU | **Gerçek kırılma** — yayın p99 = 1.609 ms |
| `2x-2500vu.json` | 2 instance · 2.500 VU | Aynı yük, ikinci instance ile: p99 = 47 ms |
| `2x-5000vu.json` | 2 instance · 5.000 VU | HELLO p95 = 9,4 sn → araştırmanın başlangıcı |
| `2x-5000vu-cached.json` | + oda önbelleği | **Hipotez 1 yanlış** — HELLO değişmedi |
| `2x-5000vu-coalesced.json` | + presence birleştirme | Gerçek iyileşme (11,9 → 8,4 sn) ama yetersiz |
| `2x-5000vu-backlog.json` | + TCP backlog 4.096 | **Hipotez 2 yanlış** — HELLO değişmedi |
| `2x-5000vu-diagnostic.json` | + HTTP gecikme metriği | Kanıt: HTTP p50 = 3 ms, yani host doygun değil |
| `split-a.json` `split-b.json` | 2 instance · 2×2.500 VU | **Kesin deney** — yük iki k6 konteynerine bölündü, HELLO p95 = 97 ms |

Son üç satır birlikte okunur: sunucuda hiçbir şey değişmeden HELLO gecikmesi
9.400 ms'den 97 ms'ye düştü. Darboğaz yük üretecinin kendisiydi.

Yeniden üretmek için: [`../yuk-testi.md#yeniden-üretmek-için`](../yuk-testi.md)
