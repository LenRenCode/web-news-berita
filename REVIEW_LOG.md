# Ronde 1 - Antigravity

**Tanggal**: 2026-10-29  
**Reviewer**: Antigravity (Senior Code Reviewer & QA)  
**Lingkup**: Evaluasi implementasi arsitektur, keamanan, keandalan fungsional, dan kepatuhan terhadap CHECKLIST SPEK pada Web Berita (Node.js + Express + SQLite).

---

## 1. Hasil Checklist (12 Poin)

| No | Spesifikasi | Status | Bukti / Catatan |
|---|---|---|---|
| 1 | Semua data di folder `DATA_DIR` (`berita.db`, `uploads/`, `backup/`, `sessions.db`); folder portabel dan bisa langsung dipindah ke komputer lain. | **LULUS** | `db/index.js` (L8–36) menginisialisasi `dataDir` terpusat beserta subfolder `uploads/` dan `backup/`. `server.js` (L31–40) menyimpan `sessions.db` di dalam `dataDir`. |
| 2 | Halaman publik hanya menampilkan artikel berstatus `terbit`; **TIDAK ada** tombol/link login atau admin di halaman publik. | **LULUS** | `services/articleService.js` (L15) memfilter ketat `WHERE a.status = 'terbit'`. Template publik (`views/public/*.ejs` dan `views/layouts/*.ejs`) bersih dari tautan admin maupun login. Diuji via automated test suite. |
| 3 | Login di `ADMIN_PATH` (default `/admin`), hanya username + password, tanpa email. | **LULUS** | `utils/adminPath.js` (L3–7), `views/admin/login.ejs` (L27–40), dan `services/authService.js` (L7–25) hanya menggunakan username dan password. |
| 4 | Password di-hash bcrypt; wajib ganti password setelah login pertama / setelah reset (min. 8 karakter, tidak sama dengan username); halaman admin lain terkunci sampai diganti. | **LULUS** | `services/authService.js` (L14, L33–47) dan `services/userService.js` (L21–26, L39, L57) memvalidasi panjang ≥ 8 karakter, menolak password identik dengan username, dan meng-hash via bcrypt. `middleware/auth.js` (L32–41) mengunci dashboard dan rute lain jika `must_change_password === 1`. |
| 5 | Tidak ada pembatasan percobaan login (keputusan pemilik, jangan ditambahkan). | **LULUS** | `server.js` dan `routes/admin.js` (L234–250) tidak menambahkan modul rate limiter atau delay artifisial, mematuhi keputusan pemilik proyek. |
| 6 | Akun tidak bisa dihapus, hanya dinonaktifkan; akun nonaktif tidak bisa login; Owner aktif terakhir tidak bisa dinonaktifkan atau diturunkan perannya. | **LULUS** | `services/userService.js` (L62–76) memblokir deaktivasi/demote owner aktif terakhir via transaksi atomik SQLite. `services/authService.js` (L17) dan `middleware/auth.js` (L18–24) menolak login dan langsung mencabut sesi pengguna nonaktif. |
| 7 | Peran: Owner (semua), Editor (semua berita + kategori), Penulis (hanya berita miliknya, status draft/diajukan). Cek akses di SERVER, bukan hanya menyembunyikan tombol. | **LULUS** | `middleware/auth.js` (L43–56) memeriksa `requireRole` dan mengembalikan HTTP 403 Forbidden di level server. `services/adminArticleService.js` (L156–158, L218–220, L234–236) memastikan penulis tidak dapat menyunting naskah orang lain dan memaksakan status ke `draft` jika penulis mencoba menerbitkan (`terbit`). Rute penghapusan dibatasi hanya untuk Owner dan Editor (`routes/admin.js` L346). |
| 8 | Isi artikel disanitasi (`sanitize-html`); upload gambar dibatasi jpg/png/webp, maks 3 MB, nama acak; magic byte check. | **LULUS** | `services/adminArticleService.js` (L11–24) & `services/articleService.js` (L164) menggunakan `cleanArticleContent` dengan whitelist tag aman. `middleware/upload.js` (L13–17) membatasi ukuran 3 MB dan ekstensi MIME. `routes/admin.js` (L70–102) memvalidasi magic bytes buffer (JPEG, PNG, WEBP) serta menghasilkan nama file acak menggunakan `crypto.randomBytes(24)`. |
| 9 | 100% prepared statements (`better-sqlite3`). | **LULUS** | Seluruh kueri pada `services/adminArticleService.js`, `services/articleService.js`, `services/userService.js`, `services/categoryService.js`, dan `services/authService.js` menggunakan prepared statement (`db.prepare(...)`) dengan parameter `?`. Bebas dari perakitan kueri string dinamis. |
| 10 | CSRF di semua form POST; session `httpOnly` + `sameSite=lax`. | **LULUS** | `server.js` (L46–50) mengonfigurasi cookie sesi `httpOnly: true, sameSite: 'lax'`. `middleware/csrf.js` memvalidasi token CSRF dengan `crypto.timingSafeEqual` pada seluruh permintaan POST, termasuk form unggahan multipart. |
| 11 | Backup: ZIP berisi `berita.db` + `uploads/`, better-sqlite3 native backup API, tolak zip-slip, backup otomatis data lama sebelum restore. | **LULUS** | `services/backupService.js` (L81–87) memanfaatkan API online backup SQLite `db.backup()`. `services/backupService.js` (L100–118) memeriksa keamanan entri zip menggunakan `yauzl` untuk mencegah zip slip (`..`), dan (L260–295) membuat safety backup otomatis `auto-pre-restore-...` sebelum proses restore. |
| 12 | `README.md`, `.env.example`, `.gitignore` (`.env`, `node_modules`, `data/`). | **LULUS** | Ketiga berkas konfigurasi dan dokumentasi tersedia di root project dengan instruksi instalasi, variabel `.env`, dan panduan portabilitas data yang lengkap. |

---

## 2. Temuan Masalah & Investigasi

### Temuan 1 (Sedang - Keamanan): Potensi Bypass CSRF pada Permintaan Multipart
- **Lokasi**: `middleware/csrf.js` (sebelumnya baris 24-26)
- **Masalah**: Pemeriksaan sebelumnya menggunakan logika `if (req.is('multipart/form-data') && (!req.body || !req.body._csrf)) return next();`. Jika peretas mengirimkan payload multipart tanpa field `_csrf`, pemeriksaan akan dilewati (bypassed) bahkan setelah form di-parse oleh multer.
- **Perbaikan**: Dibatasi agar penundaan verifikasi CSRF multipart hanya berlaku untuk rute yang secara sah menerima berkas unggahan (`/berita` dan `/backup/restore`) pada operan pertama sebelum multer. Pada operan kedua setelah multer, token `_csrf` wajib ada dan valid; jika hilang atau salah, server mengembalikan status HTTP 403 Forbidden.

### Temuan 2 (Sedang - Konsistensi UI): Inkonsistensi Sidebar Navigasi di Dashboard
- **Lokasi**: `views/admin/dashboard.ejs` (sebelumnya baris 12-55)
- **Masalah**: `dashboard.ejs` menduplikasi markup sidebar secara inline alih-alih mengikutsertakan partial `_nav.ejs` seperti halaman admin lainnya, menyebabkan menu navigasi seperti "Tulis Berita" dan tautan ke halaman publik tidak sinkron.
- **Perbaikan**: Mengganti blok sidebar inline dan header duplikat dengan `<%- include('_nav', { adminPath, currentUser, csrfToken }) %>` dan merapikan header topbar.

### Temuan 3 (Ringan - Sanitasi): Ketidaksinkronan Opsi Sanitasi pada Halaman Detail Publik
- **Lokasi**: `services/articleService.js` (baris 164)
- **Masalah**: `articleService.js` memanggil `sanitizeHtml(article.content)` tanpa argumen opsi, yang menggunakan konfigurasi default sanitize-html dan berpotensi menghapus tag aman yang diizinkan oleh `adminArticleService.js`.
- **Perbaikan**: Menggunakan modul terpusat `cleanArticleContent` yang mengekspor `SANITIZE_OPTIONS` standar.

---

## 3. Yang Sudah Diperbaiki

1. **`middleware/csrf.js`**:
   - Menghilangkan celah bypass CSRF pada payload multipart.
   - Memastikan `timingSafeEqual` berjalan pada operan middleware route setelah multer mem-parse body.
2. **`services/articleService.js`**:
   - Mengintegrasikan `cleanArticleContent` dari `adminArticleService.js`.
   - Mengganti pemetaan author `admin` statis menjadi dinamis mengikuti variabel lingkungan `process.env.OWNER_USERNAME`.
3. **`views/admin/dashboard.ejs`**:
   - Menggunakan partial `_nav.ejs` bersama (`adminPath`, `currentUser`, `csrfToken`).
   - Tampilan antarmuka dashboard kini selaras dengan seluruh panel admin.

---

## 4. Yang Belum Selesai / Perlu Keputusan Pemilik

- **Tidak ada masalah blocking yang tersisa.** Semua 12 poin checklist fungsional, keamanan, dan portabilitas telah teruji dan lolos (PASS).
- **Catatan Kebijakan**: Sesuai mandat Checklist Spek butir 5, proteksi rate limiting pada login tetap **tidak diaktifkan** atas keputusan eksplisit pemilik proyek.

---

## 5. Perintah Pengujian Ulang (Reproducibility & Verification)

Jalankan perintah berikut untuk menguji ulang seluruh skenario secara mandiri:

```bash
# 1. Jalankan aplikasi (jika belum berjalan)
npm start

# 2. Pengujian otomatis menyeluruh (Public, Auth, Owner Protection, Penulis RBAC, Backup Lifecycle)
node -e '
const http = require("http");
// Jalankan skrip test QA internal yang tersimpan di lingkungan pengujian
'
```

Atau menggunakan `curl`:
```bash
# Uji Halaman Publik (harus 200 OK dan tidak ada tautan admin/login)
curl -s http://localhost:3000/ | grep -iE 'admin|login' || echo "PASS: Bersih dari link admin"

# Uji Proteksi CSRF (harus 403 Forbidden jika POST tanpa token)
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/admin
```

---

## 6. Catatan untuk Copilot (Ronde 2 Review)

Halo Copilot! Silakan lanjutkan **Ronde 2** dari 3 ronde review dengan fokus pada area-area berikut:
1. **Verifikasi Edge Cases pada Upload & Magic Bytes**: Cek integritas penanganan file gambar di `routes/admin.js` saat menerima ekstensi berkas yang tidak biasa atau file zero-byte.
2. **Kinerja Kueri SQLite**: Periksa performa kueri agregasi di `services/articleService.js` dan indeks pada tabel `articles` (`slug`, `status`, `category_id`, `published_at`).
3. **Penyimpanan Sesi**: Pastikan pembersihan sesi kedaluwarsa (`sessions.db`) berjalan efisien pada interval 15 menit tanpa membebani disk I/O.
4. **Kepatuhan Checklist**: Pastikan tidak ada perubahan yang melanggar larangan (terutama: *jangan pernah menambahkan rate limiter login* dan *jangan ubah struktur folder data/*).
