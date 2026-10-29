// Service Manajemen Berita di Panel Admin (Sanitasi, CRUD, Tagging, & Otorisasi)
const sanitizeHtml = require('sanitize-html');
const { db } = require('../db/index');
const { slugify } = require('./categoryService');

// Konfigurasi Sanitasi HTML untuk Konten Artikel
const SANITIZE_OPTIONS = {
  allowedTags: [
    'h2', 'h3', 'h4', 'p', 'b', 'i', 'strong', 'em', 'u', 's',
    'ul', 'ol', 'li', 'a', 'blockquote', 'hr', 'br', 'span'
  ],
  allowedAttributes: {
    'a': ['href', 'target', 'rel', 'title']
  },
  allowedSchemes: ['http', 'https', 'mailto']
};

function cleanArticleHtml(htmlContent) {
  return sanitizeHtml(htmlContent || '', SANITIZE_OPTIONS);
}

// 1. Ambil Statistik Ringkasan untuk Dashboard
function getDashboardStats() {
  const totalArticles = db.prepare('SELECT COUNT(*) AS total FROM articles').get().total;
  const draftArticles = db.prepare("SELECT COUNT(*) AS total FROM articles WHERE status = 'draft'").get().total;
  const submittedArticles = db.prepare("SELECT COUNT(*) AS total FROM articles WHERE status = 'diajukan'").get().total;
  const publishedArticles = db.prepare("SELECT COUNT(*) AS total FROM articles WHERE status = 'terbit'").get().total;
  
  // Hitung total berita dibaca hari ini dari tabel tracking article_views
  const todayViews = db.prepare("SELECT COUNT(*) AS total FROM article_views WHERE viewed_date = CURRENT_DATE").get().total;

  return {
    totalArticles,
    draftArticles,
    submittedArticles,
    publishedArticles,
    todayViews
  };
}

// 2. Ambil Daftar Berita dengan Filter, Pencarian, & Otorisasi Peran
function getAdminArticles({ user, search = '', status = '', page = 1, limit = 10 }) {
  const conditions = [];
  const params = [];

  // Aturan Peran: Penulis hanya dapat melihat berita miliknya sendiri
  if (user.role === 'penulis') {
    conditions.push('a.author_id = ?');
    params.push(user.id);
  }

  // Filter pencarian judul
  if (search && search.trim()) {
    conditions.push('a.title LIKE ?');
    params.push(`%${search.trim()}%`);
  }

  // Filter status artikel
  if (status && ['draft', 'diajukan', 'terbit'].includes(status)) {
    conditions.push('a.status = ?');
    params.push(status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Hitung total hasil
  const countRow = db.prepare(`SELECT COUNT(*) AS total FROM articles a ${whereClause}`).get(...params);
  const total = countRow ? countRow.total : 0;
  const totalPages = Math.ceil(total / limit) || 1;
  const offset = (page - 1) * limit;

  // Query data artikel
  const articles = db.prepare(`
    SELECT 
      a.id, a.title, a.slug, a.status, a.views, a.created_at, a.published_at, a.image_path,
      c.name AS category_name,
      u.username AS author_name,
      a.author_id
    FROM articles a
    LEFT JOIN categories c ON a.category_id = c.id
    LEFT JOIN users u ON a.author_id = u.id
    ${whereClause}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return {
    articles,
    total,
    page,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1
  };
}

// 3. Ambil Berita Berdasarkan ID (Beserta Tag) untuk Form Edit
function getArticleForEdit(id) {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
  if (!article) return null;

  const tags = db.prepare(`
    SELECT t.name 
    FROM tags t
    JOIN article_tags at ON t.id = at.tag_id
    WHERE at.article_id = ?
  `).all(id);

  article.tagsString = tags.map(t => t.name).join(', ');
  return article;
}

// Helper Menyimpan Tag
function syncArticleTags(articleId, tagsString) {
  // Hapus relasi tag lama
  db.prepare('DELETE FROM article_tags WHERE article_id = ?').run(articleId);

  if (!tagsString || !tagsString.trim()) return;

  const tagNames = [...new Set(
    tagsString
      .split(',')
      .map(t => t.trim())
      .filter(t => t.length > 0)
  )];

  const insertTagStmt = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
  const getTagStmt = db.prepare('SELECT id FROM tags WHERE name = ?');
  const linkStmt = db.prepare('INSERT OR IGNORE INTO article_tags (article_id, tag_id) VALUES (?, ?)');

  for (const name of tagNames) {
    insertTagStmt.run(name);
    const tag = getTagStmt.get(name);
    if (tag) {
      linkStmt.run(articleId, tag.id);
    }
  }
}

// 4. Tambah Berita Baru
function createArticle({ user, title, category_id, status, content, summary, tags, image_path }) {
  const cleanTitle = (title || '').trim();
  if (!cleanTitle) {
    return { success: false, message: 'Judul berita wajib diisi.' };
  }

  // Sanitasi Konten HTML
  const sanitizedContent = cleanArticleHtml(content);

  // Buat slug unik
  let baseSlug = slugify(cleanTitle) || 'berita';
  let slug = baseSlug;
  let counter = 1;
  while (db.prepare('SELECT id FROM articles WHERE slug = ?').get(slug)) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  // Validasi Aturan Status Berdasarkan Peran
  let finalStatus = 'draft';
  if (user.role === 'penulis') {
    // Penulis hanya boleh memilih draft atau diajukan
    finalStatus = status === 'diajukan' ? 'diajukan' : 'draft';
  } else {
    // Editor dan Owner boleh menerbitkan
    finalStatus = ['draft', 'diajukan', 'terbit'].includes(status) ? status : 'draft';
  }

  const publishedAt = finalStatus === 'terbit' ? new Date().toISOString() : null;

  // Ringkasan otomatis jika tidak diisi
  const cleanSummary = (summary || '').trim() ||
    sanitizedContent.replace(/<[^>]*>?/gm, '').slice(0, 160).trim();

  const insertStmt = db.prepare(`
    INSERT INTO articles (
      title, slug, summary, content, image_path, category_id,
      author_id, status, views, published_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  try {
    const info = insertStmt.run(
      cleanTitle,
      slug,
      cleanSummary,
      sanitizedContent,
      image_path || '/images/default-article.svg',
      category_id ? parseInt(category_id) : null,
      user.id,
      finalStatus,
      publishedAt
    );

    const articleId = info.lastInsertRowid;
    syncArticleTags(articleId, tags);

    return { success: true, articleId };
  } catch (err) {
    return { success: false, message: 'Gagal membuat berita: ' + err.message };
  }
}

// 5. Perbarui Berita
function updateArticle({ id, user, title, category_id, status, content, summary, tags, image_path }) {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
  if (!article) {
    return { success: false, message: 'Berita tidak ditemukan.' };
  }

  // Cek Hak Akses: Penulis hanya boleh mengedit berita miliknya sendiri
  if (user.role === 'penulis' && article.author_id !== user.id) {
    return { success: false, message: 'Anda tidak memiliki hak untuk mengedit berita ini.' };
  }

  const cleanTitle = (title || '').trim();
  if (!cleanTitle) {
    return { success: false, message: 'Judul berita wajib diisi.' };
  }

  // Sanitasi Konten HTML
  const sanitizedContent = cleanArticleHtml(content);

  // Periksa apakah judul berubah, jika ya perbarui slug
  let slug = article.slug;
  if (cleanTitle !== article.title) {
    let baseSlug = slugify(cleanTitle) || 'berita';
    slug = baseSlug;
    let counter = 1;
    while (db.prepare('SELECT id FROM articles WHERE slug = ? AND id != ?').get(slug, id)) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }
  }

  // Validasi Status Berdasarkan Peran
  let finalStatus = article.status;
  if (user.role === 'penulis') {
    // Penulis hanya boleh memilih draft atau diajukan
    finalStatus = status === 'diajukan' ? 'diajukan' : 'draft';
  } else {
    // Editor dan Owner bebas memilih status
    finalStatus = ['draft', 'diajukan', 'terbit'].includes(status) ? status : article.status;
  }

  // Atur tanggal terbit
  let publishedAt = article.published_at;
  if (finalStatus === 'terbit' && !publishedAt) {
    publishedAt = new Date().toISOString();
  } else if (finalStatus !== 'terbit') {
    // Jika dikembalikan ke draft/diajukan oleh redaksi
    publishedAt = null;
  }

  const finalImagePath = image_path || article.image_path || '/images/default-article.svg';
  const cleanSummary = (summary || '').trim() ||
    sanitizedContent.replace(/<[^>]*>?/gm, '').slice(0, 160).trim();

  const updateStmt = db.prepare(`
    UPDATE articles SET
      title = ?,
      slug = ?,
      summary = ?,
      content = ?,
      image_path = ?,
      category_id = ?,
      status = ?,
      published_at = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  try {
    updateStmt.run(
      cleanTitle,
      slug,
      cleanSummary,
      sanitizedContent,
      finalImagePath,
      category_id ? parseInt(category_id) : null,
      finalStatus,
      publishedAt,
      id
    );

    syncArticleTags(id, tags);

    return { success: true };
  } catch (err) {
    return { success: false, message: 'Gagal memperbarui berita: ' + err.message };
  }
}

// 6. Hapus Berita
function deleteArticle(id, user) {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
  if (!article) {
    return { success: false, message: 'Berita tidak ditemukan.' };
  }

  // Penulis hanya boleh menghapus berita miliknya sendiri
  if (user.role === 'penulis' && article.author_id !== user.id) {
    return { success: false, message: 'Anda tidak memiliki hak untuk menghapus berita ini.' };
  }

  try {
    db.prepare('DELETE FROM articles WHERE id = ?').run(id);
    return { success: true };
  } catch (err) {
    return { success: false, message: 'Gagal menghapus berita: ' + err.message };
  }
}

module.exports = {
  cleanArticleHtml,
  getDashboardStats,
  getAdminArticles,
  getArticleForEdit,
  createArticle,
  updateArticle,
  deleteArticle
};
