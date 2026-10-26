# Değişiklik günlüğü

## 1.0.0 — 2026-10-27

İlk herkese açık sürüm.

### Öne çıkanlar
- **Header'lı HLS oynatma:** cURL komutundan ya da adresten Referer/Origin/Cookie/User-Agent ve özel token
  header'larıyla oynatma. Header'lar master playlist'ten segmentlere kadar her istekte gönderilir.
- **Tarayıcı eklentisi ve köprü:** Chrome, Edge, Brave, Opera ve Vivaldi için eklenti. İlk açılış sihirbazı eklentiyi
  seçilen tarayıcıya kurar; port ve token otomatik ayarlanır.
- **Token servisi desteği:** JSON dönen token servislerinden m3u8 adresi çıkarılır. Eklenti bu servisleri playlist
  sanmaz, ardından gelen m3u8 ile eşleştirir.
- **Otomatik token yenileme:** `st`/`e`, `token`, `hdnts` gibi süreli imzalar dolmadan ya da 401/403/410 alındığında
  yenilenir. Yayın kesilmeden devam eder.
- **Yeni arayüz:** yayın kütüphanesi (favoriler, filtreler, arama), canlı gecikme göstergesi, kalite, bit hızı ve tampon
  bilgisi, resim içinde resim, klavye kısayolları, açıklayıcı hata ekranları.

### Notlar
- Program daha önce "M3U8 Player" adıyla geliştiriliyordu. Eski veriler (`%APPDATA%\M3U8 Player`) ilk açılışta
  `%APPDATA%\HLS Deck` klasörüne taşınır.
- Kurulum dosyaları kod imzalı değildir. SmartScreen uyarısında **Ek bilgi → Yine de çalıştır**'ı seç.
