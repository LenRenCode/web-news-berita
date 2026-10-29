// Server Utama Aplikasi Web Berita "NamaBerita"
require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');

const { db, dataDir, uploadsDir } = require('./db/index');
const { initSchema } = require('./db/schema');
const { seedData } = require('./db/seed');
const { getAdminPath } = require('./utils/adminPath');
const { csrfProtection } = require('./middleware/csrf');
const adminRouter = require('./routes/admin');
const publicRouter = require('./routes/public');

// Inisialisasi skema database dan data awal.
initSchema();
seedData();

const app = express();
const PORT = process.env.PORT || 3000;
const sessionSecret = process.env.SESSION_SECRET;
const adminPath = getAdminPath();

if (!sessionSecret) {
  throw new Error('SESSION_SECRET wajib diatur di file .env.');
}

// Simpan sesi login bersama data aplikasi agar mudah dipindahkan.
const sessionDbPath = path.join(dataDir, 'sessions.db');
const sessionDb = new Database(sessionDbPath);
const sessionStore = new SqliteStore({
  client: sessionDb,
  expired: {
    clear: true,
    intervalMs: 15 * 60 * 1000 // Bersihkan sesi kedaluwarsa tiap 15 menit
  }
});

app.use(session({
  store: sessionStore,
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 // 1 hari
  }
}));

// Parsing request.
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Tampilan EJS dan file statis.
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.adminPath = adminPath;
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));
app.use(csrfProtection);
app.use(adminPath, adminRouter);
app.use('/', publicRouter);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[SERVER] NamaBerita berjalan di http://localhost:${PORT}`);
  });
}

module.exports = app;
