# Executor-First License Architecture — Implementation Report

Branch: `feat/executor-first-license-architecture`
Implementation commit: `455671cb52136b7e735b788fefc515bbe514a84d`
Report commit: dicatat pada commit dokumentasi terpisah setelah laporan ini.

## 1. Arsitektur sebelum dan sesudah

**Sebelum**

- Phase 4 sudah punya lifecycle key, `key_sessions`, HMAC HWID, dan endpoint web
  `/api/keys/*` yang seluruhnya membutuhkan sesi Discord.
- `key_sessions.user_id` adalah `NOT NULL` dan terikat ke `users`, sehingga tidak
  bisa dipakai executor tanpa login Discord.
- Tidak ada model product, product-to-script mapping, atau entitlement. Validasi
  script hanya memeriksa `scripts.status = 'published'`, `enabled`, dan
  `deleted_at`, sehingga key valid bisa mengakses semua script published.
- HWID reset masih bisa dilakukan sendiri oleh pemilik key.
- Dashboard masih berupa shell kosong tanpa data lisensi.

**Sesudah**

- Lisensi adalah identitas utama. Executor melakukan aktivasi hanya dengan key
  dan HWID, tanpa sesi Discord.
- Buyer identity disimpan terpisah di `key_purchases`; identitas executor berada
  di `executor_sessions`. Tidak ada jalur kode yang menulis identitas executor ke
  record pembeli.
- Product entitlement menjadi syarat akses script: `products` →
  `product_scripts` → `key_entitlements`.
- Executor session memakai tabel terpisah `executor_sessions`, sehingga
  `key_sessions.user_id NOT NULL` dan alur dashboard web Phase 4 tidak diubah.
- Nonce replay protection disimpan di `executor_nonces` dengan unique constraint.
- HWID reset self-service dihapus dari routing dan entry point service menolak
  dengan `forbidden`; reset hanya lewat admin.
- Dashboard menampilkan purchase dan executor sebagai dua kelompok informasi
  terpisah, plus sesi, entitlement, device history, dan audit history.

## 2. Database migration yang ditambahkan

File: `supabase/migrations/0002_executor_first.sql` (additive, tanpa menghapus
data/kolom lama).

Tabel baru:

- `products` (`code` unique, `active`).
- `product_scripts` (PK gabungan `product_id`, `script_id`).
- `key_entitlements` (unique `key_id, product_id`, status/source check,
  `starts_at`/`expires_at`).
- `key_purchases` (satu record per key, buyer Discord id/username, payment
  status, purchase reference, product).
- `executor_sessions` (token hash + versi hash, HWID hash + fingerprint,
  status, idle/absolute expiry, metadata executor, IP/user agent).
- `executor_nonces` (unique `nonce_hash`, FK ke session dan key).

Kolom baru:

- `keys.product_id`, `claimed_at`, `claim_kind`, `claim_ref`,
  `key_hash_version`.
- `key_sessions.session_token_hash_version`.
- `script_access_logs.executor_session_id`, `key_session_id`, `entitlement_id`,
  `denial_code`, `grant_expires_at`.
- `audit_logs.actor_type`, `actor_ref`.

Constraint dan index penting:

- `executor_sessions_one_active_per_key` unique partial pada `status = 'active'`.
- Unique `executor_sessions.session_token_hash`.
- Unique `executor_nonces.nonce_hash`.
- Index untuk lookup key, session, expiry, entitlement, dan product mapping.
- Constraint event `key_device_history` diperluas tanpa menghapus nilai lama.

Backfill legacy:

- Product `legacy` dibuat tanpa mapping script.
- Semua key lama mendapat entitlement `legacy`.
- `keys.product_id` diisi ke product legacy.
- Buyer lama dengan `owner_discord_id` mendapat `key_purchases` source `legacy`.
- Key lama dengan owner ditandai `claim_kind = 'discord'`.

Migration belum dijalankan ke production atau database mana pun di luar test
embedded PGlite.

## 3. Endpoint yang diimplementasikan

Prefix: `/api/executor/v1` (public, tanpa sesi Discord).

- `POST /activate`
  - Input: `key`, `hwid`, `scriptId`, metadata opsional (`clientVersion`,
    `robloxUserId`, `robloxUsername`, `executorName`, `executorVersion`).
  - Melakukan lock baris key, validasi status/expiry, cek HWID binding, cek
    entitlement, claim atomik, supersede sesi executor aktif, dan membuat sesi
    baru.
  - Mengembalikan token sesi satu kali.
- `POST /validate`
  - Bearer executor session token.
  - Input: `scriptId`, `hwid`, `timestamp`, `nonce`, `clientVersion` opsional.
  - Memeriksa token hash, status sesi, idle/absolute expiry, status key, HWID
    binding, timestamp tolerance ±5 menit, entitlement, dan konsumsi nonce.
- `POST /session/revoke`
  - Bearer executor session token.
  - Hanya mencabut sesi pemanggil; idempotent; tidak mengubah kepemilikan key.

Endpoint admin tambahan:

- `GET /api/admin/keys/:id/sessions`
- `POST /api/admin/keys/:id/sessions/:sessionId/revoke`

Endpoint web Phase 4 yang dipertahankan:

- `POST /api/keys/activate`, `POST /api/keys/validate`, `GET /api/keys/me`,
  `GET /api/keys/:id/usage`, `GET /api/keys/:id/devices`, serta endpoint admin
  key yang sudah ada.

Endpoint `POST /api/keys/reset-hwid` dihapus dari routing. Service
`resetHwid` kini menolak dengan `forbidden`, sehingga self-service tidak bisa
dipakai lewat jalur lama.

## 4. Perubahan buyer/executor identity

- Buyer dicatat di `key_purchases` dari transaksi terverifikasi server
  (`buyer_discord_id`, `buyer_discord_username`, `purchase_reference`,
  `product_id`, `payment_status`).
- Executor dicatat di `executor_sessions` (`roblox_user_id`,
  `roblox_username`, `executor_name`, `executor_version`, `client_version`,
  `hwid_hash`, `hwid_fingerprint`, IP, user agent).
- Metadata executor diperlakukan sebagai telemetri tidak tepercaya dan tidak
  pernah dipakai untuk autentikasi.
- Kode executor hanya menulis ke `executor_sessions`, `keys`, device history,
  access log, dan audit log. Tidak ada penulisan ke `key_purchases`.
- Test `buyer identity separation` memverifikasi buyer Discord tetap sama
  walaupun key diaktivasi dengan Roblox identity lain.

## 5. Session dan nonce/replay security

- Idle timeout: 30 menit (`EXECUTOR_IDLE_MS`).
- Absolute lifetime: 24 jam (`EXECUTOR_ABSOLUTE_MS`).
- Satu sesi executor aktif per key, dijamin partial unique index dan update
  supersede dalam transaksi yang sama.
- Aktivasi baru mencabut sesi aktif sebelumnya (`superseded`, `revoked_at`).
- Aktivasi ulang dengan key + HWID sama mengganti sesi tanpa menaikkan
  `activation_count`.
- Validasi memperpanjang `idle_expires_at` tetapi tidak pernah melewati
  `absolute_expires_at`.
- Revocation langsung berlaku karena setiap validasi membaca status sesi dari
  database.
- Timestamp wajib berada dalam toleransi ±5 menit; selain itu
  `timestamp_invalid`.
- Nonce di-hash dengan HMAC yang di-scope ke session id, disimpan di
  `executor_nonces` dengan unique `nonce_hash`. Insert memakai
  `on conflict do nothing`; konflik berarti replay dan ditolak
  (`replay_detected`).
- Token sesi dan nonce tidak pernah disimpan plaintext.
- Denial audit ditulis setelah transaksi utama rollback melalui sinyal denial
  terpisah, sehingga kegagalan utama tidak menghapus jejak audit.

## 6. Product entitlement

`src/modules/access/script-access.ts` sekarang mengembalikan grant hanya jika:

1. Script ada, `status = 'published'`, `enabled = true`, `deleted_at is null`.
2. Key punya `key_entitlements` aktif untuk product yang `active`.
3. Product memetakan script melalui `product_scripts`.
4. `starts_at <= now` dan `expires_at` kosong atau belum lewat.

Tidak ada fallback "semua script published". Legacy key hanya mendapat
entitlement legacy tanpa mapping; akses tetap ditolak sampai mapping eksplisit
ditambahkan. Test legacy membuktikan key ditolak (`entitlement_missing`) lalu
berhasil setelah `product_scripts` diisi.

## 7. HWID handling

- Raw HWID tidak pernah disimpan. Semua binding memakai
  `hashHwid` (HMAC-SHA-256, normalisasi v1) yang sudah ada.
- Dashboard hanya menerima `hwid_fingerprint` 12 karakter.
- Aktivasi pertama mengikat HWID ke key dan sesi.
- Aktivasi/validasi dengan HWID berbeda ditolak (`hwid_mismatch`) dan dicatat
  di `key_device_history`.
- Reset HWID hanya admin; menghapus binding, menaikkan `hwid_reset_count`,
  mencabut sesi web dan executor, mencatat `key_hwid_resets`,
  `key_device_history` (`reset_admin`), dan audit `key.hwid_reset_admin`.
- Histori reset lama tidak dihapus.

## 8. Dashboard changes

File: `app/(authenticated)/dashboard/page.tsx` dan
`app/(authenticated)/dashboard/actions.ts`.

- Statistik ringkas: akun, jumlah lisensi, kebijakan sesi.
- Setiap lisensi menampilkan dua bagian terpisah:
  - **Purchase information**: buyer Discord ID/username, product, payment
    status, purchase reference, tanggal pembelian, status lisensi, aktivasi.
  - **Executor information**: Roblox user, executor name/version, HWID
    fingerprint, status sesi, first activation, last activity, idle dan absolute
    expiry.
- Detail lisensi: daftar sesi executor, entitlement beserta script yang
  dipetakan, device history, dan audit history.
- Admin/owner dapat: revoke lisensi, reset HWID, dan revoke sesi executor aktif.
- Non-admin hanya melihat lisensi miliknya dan diberi keterangan bahwa reset
  HWID/revocation bersifat admin-only.
- Plaintext key tidak pernah ditampilkan.
- Mengikuti token dan komponen `DESIGN.md`; tidak ada redesign di luar kebutuhan
  data lisensi.

## 9. File yang dibuat/diubah

Dibuat:

- `supabase/migrations/0002_executor_first.sql`
- `src/modules/executor/service.ts`
- `src/modules/executor/dashboard.ts`
- `src/routes/executor.ts`
- `src/validators/executor.ts`
- `app/(authenticated)/dashboard/actions.ts`
- `test/executor.test.ts`

Diubah:

- `.env.example`
- `src/core/env.ts`
- `src/core/errors.ts`
- `src/modules/keys/crypto.ts`
- `src/modules/keys/service.ts`
- `src/modules/keys/audit.ts`
- `src/modules/keys/errors.ts`
- `src/modules/access/script-access.ts`
- `src/routes/index.ts`
- `src/routes/keys.ts`
- `src/validators/keys.ts`
- `app/(authenticated)/dashboard/page.tsx`
- `test/env.test.ts`
- `test/helpers/keys.ts`
- `test/keys-http.test.ts`
- `test/keys-service.test.ts`
- `test/keys-unit.test.ts`

## 10. Hasil setiap test

| Pemeriksaan | Hasil |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run format:check` | PASS |
| `npm test` | PASS — 30 file, 305 test |
| `npm run build` | PASS dengan `NEXT_PUBLIC_SITE_URL` diset |
| `npm run test:integration:concurrency` | FAIL — `BOYFINITY_CONCURRENCY_TEST_DATABASE_URL` tidak tersedia |

Catatan build: percobaan pertama gagal karena `NEXT_PUBLIC_SITE_URL` belum
diset untuk production build (`src/lib/site.ts`). Build diulang dengan nilai
contoh `https://boyfinity.example` dan berhasil. Ini kebutuhan konfigurasi yang
sudah ada, bukan regresi implementasi ini.

Cakupan test executor (`test/executor.test.ts`, 18 test):

- Aktivasi key-only tanpa sesi Discord.
- Dua aktivasi bersamaan dengan HWID sama dan berbeda.
- Aktivasi ulang key + HWID sama tanpa menambah `activation_count`.
- HWID mismatch saat aktivasi dan validasi.
- Token sesi tidak valid.
- Idle timeout 30 menit.
- Absolute expiry 24 jam.
- Penggantian sesi (token lama ditolak).
- Revocation langsung dan idempotent.
- Nonce replay.
- Timestamp terlalu lama dan terlalu jauh.
- Entitlement valid, entitlement hilang, entitlement suspended.
- Script unpublished, disabled, dan deleted.
- Buyer identity tidak berubah saat key dipakai orang lain.
- Legacy license mapping eksplisit.
- Audit denial tetap tersimpan setelah rollback.

Test Phase 4 diperbarui agar entitlement-aware: helper `seedScript` sekarang
membuat product + mapping, dan key diberi entitlement eksplisit.

## 11. Known limitations

- Concurrency database nyata belum diuji. PGlite men-serialisasi transaksi,
  jadi test paralel membuktikan logika state transition dan unique constraint,
  bukan kontensi row lock PostgreSQL sungguhan.
- Suite `test:integration:concurrency` yang ada hanya menguji concurrency auth,
  bukan executor, dan tidak berjalan tanpa database uji khusus.
- Rate limit aktivasi memakai IP dan fingerprint best-effort dari header
  `x-key-fingerprint`; fingerprint itu tidak diautentikasi. Validasi dan revoke
  memakai IP + token hash sebagai dimensi tambahan.
- Tidak ada job pembersihan `executor_nonces` atau sesi kedaluwarsa; data
  dibiarkan untuk audit dan dapat dibersihkan oleh retention job terpisah.
- Dashboard menampilkan seluruh lisensi untuk admin tanpa pagination.
- Checkout/purchase otomatis belum diimplementasikan; `key_purchases` diisi oleh
  backfill legacy atau proses server-side di masa depan.
- Mapping script ke product masih manual (SQL/admin), sesuai keputusan bahwa
  legacy tidak mendapat akses otomatis.

## 12. Security risks yang masih tersisa

- Executor client tetap untrusted dan tidak bisa membuktikan dirinya sebagai
  Roblox client asli. Implementasi ini tidak mengklaim sebaliknya.
- Siapa pun yang memiliki key dapat menjadi pengguna pertama dan mengikat HWID
  miliknya (sesuai claim policy A). Buyer identity tidak berubah, tetapi
  pembeli tidak otomatis menjadi pemegang akses.
- Metadata Roblox/executor dapat dipalsukan; hanya ditampilkan sebagai telemetri.
- Rate limit berbasis IP dapat dilewati dengan banyak IP; fingerprint header
  dapat dipalsukan. Ini mengurangi, bukan menghilangkan, abuse.
- Token sesi executor adalah bearer token. Jika bocor, token berlaku sampai
  di-revoke atau kedaluwarsa; tidak ada rotasi otomatis.
- Dashboard server actions mengandalkan pemeriksaan sesi + role di server, tetapi
  belum ada audit UI-side untuk setiap tindakan admin selain audit service.
- `KEY_HMAC_SECRET` opsional. Bila tidak diset, key baru tetap memakai hash v1
  dengan `SESSION_HMAC_SECRET`; rotasi `SESSION_HMAC_SECRET` akan membuat hash key
  lama tidak bisa dicocokkan.

## 13. Langkah manual yang masih diperlukan

1. Review migration `0002_executor_first.sql`.
2. Jalankan migration di database non-production yang disetujui.
3. Set `KEY_HMAC_SECRET` (minimal 16 karakter) untuk production agar hash key
   baru memakai v2; jangan rotasi `SESSION_HMAC_SECRET` sebelum key lama dimigrasi.
4. Tentukan product dan mapping `product_scripts` yang disetujui owner.
5. Petakan key legacy ke product yang benar jika akses script diperlukan.
6. Sediakan `BOYFINITY_CONCURRENCY_TEST_DATABASE_URL` dengan database bernama
   `boyfinity_concurrency_test`, lalu jalankan suite concurrency.
7. Set `NEXT_PUBLIC_SITE_URL` pada environment build production.
8. Tambahkan retention/cleanup untuk `executor_nonces` dan sesi kedaluwarsa bila
   diperlukan.
9. Uji dashboard dengan data lisensi nyata di staging sebelum deploy.

## 14. Commit hash dan branch

- Branch: `feat/executor-first-license-architecture`
- Base: `main` pada `6708930`
- Implementation commit: `455671cb52136b7e735b788fefc515bbe514a84d`
  (`feat(executor): implement executor-first license architecture`)
- Report ini di-commit terpisah setelah implementation commit; hash dokumentasi
  dapat dilihat pada `git log -- docs/reports/executor-first-implementation-report.md`.

Tidak ada deploy, tidak ada migration production, dan `.env.local` tidak dibaca
atau di-commit.
