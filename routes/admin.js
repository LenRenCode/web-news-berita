const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const express = require('express');
const multer = require('multer');
const { db, uploadsDir } = require('../db');
const { loginUser, changePassword } = require('../services/authService');
const {
  ARTICLE_STATUSES,
  cleanArticleContent,
  getArticleForEditor,
  getArticleStats,
  getCategoryById,
  getEditorData,
  listArticles,
  removeArticle,
  removeCategory,
  saveArticle,
  saveCategory
} = require('../services/adminArticleService');
const { requireAuth, requirePasswordChanged, requireRole } = require('../middleware/auth');
const { csrfProtection, createCsrfToken } = require('../middleware/csrf');
const { getAdminPath } = require('../utils/adminPath');

const router = express.Router();
const adminPath = getAdminPath();
const loginError = 'Username atau password salah';
const articleEditor = requireAuth;
const canManageContent = requireRole('owner', 'editor');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter(req, file, callback) {
    const accepted = {
      'image/jpeg': /\.(jpe?g)$/i,
      'image/png': /\.png$/i,
      'image/webp': /\.webp$/i
    };
    const extension = accepted[file.mimetype];
    if (!extension || !extension.test(path.extname(file.originalname))) {
      return callback(new Error('Gambar harus berformat JPG, PNG, atau WEBP.'));
    }
    return callback(null, true);
  }
});

function uploadSingleImage(req, res, next) {
  upload.single('image')(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).send('Ukuran gambar maksimal 3 MB.');
    }
    if (error instanceof multer.MulterError || error.message === 'Gambar harus berformat JPG, PNG, atau WEBP.') {
      return res.status(400).send(error.message);
    }
    return next(error);
  });
}

function saveImage(file) {
  if (!file) return null;

  const signatures = [
    { mime: 'image/jpeg', extension: '.jpg', matches: buffer =>
      buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
    { mime: 'image/png', extension: '.png', matches: buffer =>
      buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    { mime: 'image/webp', extension: '.webp', matches: buffer =>
      buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' }
  ];
  const image = signatures.find(signature => signature.mime === file.mimetype && signature.matches(file.buffer));
  if (!image) throw new Error('Isi file tidak cocok dengan gambar JPG, PNG, atau WEBP.');

  const filename = `${crypto.randomBytes(24).toString('hex')}${image.extension}`;
  fs.writeFileSync(path.join(uploadsDir, filename), file.buffer, { flag: 'wx' });
  return `/uploads/${filename}`;
}

function removeNewImage(imagePath) {
  if (!imagePath) return;
  const filename = path.basename(imagePath);
  const imageFile = path.join(uploadsDir, filename);
  if (path.dirname(imageFile) === path.resolve(uploadsDir) && fs.existsSync(imageFile)) {
    fs.unlinkSync(imageFile);
  }
}

function renderDashboard(req, res) {
  const user = res.locals.currentUser;
  const stats = getArticleStats(user.role === 'penulis' ? user.id : null);
  const recentArticles = listArticles({ user }).slice(0, 8);
  return res.render('admin/dashboard', { adminPath, stats, recentArticles });
}

function renderArticleForm(res, { article = null, error = null, status = 200 }) {
  res.locals.csrfToken = res.locals.csrfToken || null;
  if (article && typeof article.content === 'string') {
    article.content = cleanArticleContent(article.content);
  }
  return res.status(status).render('admin/article-form', {
    adminPath,
    article,
    categories: getEditorData(),
    error,
    statuses: res.locals.currentUser.role === 'penulis'
      ? ['draft', 'diajukan']
      : ARTICLE_STATUSES
  });
}

function finishArticleSave(req, res, next, articleId) {
  const oldArticle = articleId ? getArticleForEditor(articleId, res.locals.currentUser) : null;
  let newImagePath;

  try {
    newImagePath = saveImage(req.file);
    const result = saveArticle({
      articleId,
      user: res.locals.currentUser,
      fields: req.body,
      imagePath: newImagePath
    });

    if (!result) {
      removeNewImage(newImagePath);
      return res.status(404).render('public/not-found', {
        categories: getEditorData(),
        title: 'Berita Tidak Ditemukan'
      });
    }

    if (newImagePath && result.previousImagePath && result.previousImagePath !== newImagePath) {
      removeNewImage(result.previousImagePath);
    }

    return res.redirect(`${adminPath}/berita?tersimpan=1`);
  } catch (error) {
    removeNewImage(newImagePath);
    if (error instanceof Error && !error.code) {
      return renderArticleForm(res, {
        article: {
          ...(oldArticle || {}),
          ...req.body,
          id: articleId,
          image_path: oldArticle?.image_path || null,
          tags: typeof req.body.tags === 'string' ? req.body.tags : oldArticle?.tags || []
        },
        error: error.message,
        status: 400
      });
    }
    return next(error);
  }
}

router.get('/', (req, res, next) => {
  if (!req.session.user?.id) {
    res.locals.csrfToken = createCsrfToken(req);
    return res.render('admin/login', { adminPath, error: null });
  }

  return requireAuth(req, res, (error) => {
    if (error) return next(error);
    if (res.headersSent) return undefined;
    if (res.locals.currentUser.must_change_password) {
      return res.redirect(`${adminPath}/ganti-password`);
    }
    return res.redirect(`${adminPath}/dashboard`);
  });
});

router.get('/login', (req, res) => res.redirect(adminPath));

router.post('/', (req, res, next) => {
  const result = loginUser(req.body.username, req.body.password);
  if (!result.success) {
    return res.status(401).render('admin/login', { adminPath, error: loginError });
  }

  return req.session.regenerate((error) => {
    if (error) return next(error);
    req.session.user = result.user;
    return req.session.save((saveError) => {
      if (saveError) return next(saveError);
      return res.redirect(result.user.must_change_password
        ? `${adminPath}/ganti-password`
        : `${adminPath}/dashboard`);
    });
  });
});

router.post('/login', (req, res) => res.redirect(307, adminPath));

router.get('/ganti-password', requireAuth, (req, res) => {
  res.locals.csrfToken = createCsrfToken(req);
  return res.render('admin/change-password', {
    adminPath,
    currentUser: res.locals.currentUser,
    error: null
  });
});

router.post('/ganti-password', requireAuth, (req, res, next) => {
  const { new_password: password, confirm_password: confirmation } = req.body;
  const result = changePassword(res.locals.currentUser.id, password, confirmation);
  if (!result.success) {
    res.locals.csrfToken = createCsrfToken(req);
    return res.status(400).render('admin/change-password', {
      adminPath,
      currentUser: res.locals.currentUser,
      error: result.message
    });
  }

  req.session.user.must_change_password = 0;
  return req.session.save((error) => {
    if (error) return next(error);
    return res.redirect(`${adminPath}/dashboard`);
  });
});

router.post('/logout', requireAuth, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('connect.sid');
    return res.redirect(adminPath);
  });
});

router.use(requireAuth, requirePasswordChanged);

router.get('/dashboard', requireRole('owner', 'editor', 'penulis'), renderDashboard);

router.get('/berita', requireRole('owner', 'editor', 'penulis'), (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const selectedStatus = typeof req.query.status === 'string' ? req.query.status : '';
  const articles = listArticles({
    user: res.locals.currentUser,
    query,
    status: selectedStatus
  });

  return res.render('admin/articles', {
    adminPath,
    articles,
    query,
    selectedStatus,
    statuses: ARTICLE_STATUSES
  });
});

router.get('/berita/tulis', requireRole('owner', 'editor', 'penulis'), (req, res) => {
  return renderArticleForm(res, {});
});

router.post('/berita', requireRole('owner', 'editor', 'penulis'), uploadSingleImage, csrfProtection, (req, res, next) => {
  return finishArticleSave(req, res, next, null);
});

router.get('/berita/:id/edit', requireRole('owner', 'editor', 'penulis'), (req, res) => {
  const articleId = Number(req.params.id);
  const article = Number.isSafeInteger(articleId) && articleId > 0
    ? getArticleForEditor(articleId, res.locals.currentUser)
    : null;
  if (!article) {
    return res.status(404).render('public/not-found', {
      categories: getEditorData(),
      title: 'Berita Tidak Ditemukan'
    });
  }
  return renderArticleForm(res, { article });
});

router.post('/berita/:id', requireRole('owner', 'editor', 'penulis'), uploadSingleImage, csrfProtection, (req, res, next) => {
  const articleId = Number(req.params.id);
  if (!Number.isSafeInteger(articleId) || articleId < 1) {
    return res.status(404).send('Berita tidak ditemukan.');
  }
  return finishArticleSave(req, res, next, articleId);
});

router.post('/berita/:id/hapus', requireRole('owner', 'editor'), (req, res) => {
  const articleId = Number(req.params.id);
  const article = Number.isSafeInteger(articleId) && articleId > 0
    ? db.prepare('SELECT image_path FROM articles WHERE id = ?').get(articleId)
    : null;
  if (!article || !removeArticle(articleId, article.image_path)) {
    return res.status(404).send('Berita tidak ditemukan.');
  }
  return res.redirect(`${adminPath}/berita?dihapus=1`);
});

router.get('/kategori', requireRole('owner', 'editor'), (req, res) => {
  const categories = db.prepare(`
    SELECT c.id, c.name, c.slug, COUNT(a.id) AS article_count
    FROM categories c
    LEFT JOIN articles a ON a.category_id = c.id
    GROUP BY c.id
    ORDER BY c.name COLLATE NOCASE
  `).all();
  return res.render('admin/categories', {
    adminPath,
    categories,
    error: null,
    saved: req.query.tersimpan === '1'
  });
});

router.post('/kategori', requireRole('owner', 'editor'), (req, res) => {
  try {
    saveCategory({ name: req.body.name });
    return res.redirect(`${adminPath}/kategori?tersimpan=1`);
  } catch (error) {
    const categories = db.prepare(`
      SELECT c.id, c.name, c.slug, COUNT(a.id) AS article_count
      FROM categories c
      LEFT JOIN articles a ON a.category_id = c.id
      GROUP BY c.id ORDER BY c.name COLLATE NOCASE
    `).all();
    return res.status(400).render('admin/categories', {
      adminPath,
      categories,
      error: error.message,
      saved: false
    });
  }
});

router.post('/kategori/:id', requireRole('owner', 'editor'), (req, res) => {
  const categoryId = Number(req.params.id);
  if (!Number.isSafeInteger(categoryId) || categoryId < 1 || !getCategoryById(categoryId)) {
    return res.status(404).send('Kategori tidak ditemukan.');
  }

  try {
    saveCategory({ id: categoryId, name: req.body.name });
    return res.redirect(`${adminPath}/kategori?tersimpan=1`);
  } catch (error) {
    const categories = db.prepare(`
      SELECT c.id, c.name, c.slug, COUNT(a.id) AS article_count
      FROM categories c
      LEFT JOIN articles a ON a.category_id = c.id
      GROUP BY c.id ORDER BY c.name COLLATE NOCASE
    `).all();
    return res.status(400).render('admin/categories', {
      adminPath,
      categories,
      error: error.message,
      saved: false
    });
  }
});

router.post('/kategori/:id/hapus', requireRole('owner', 'editor'), (req, res) => {
  const categoryId = Number(req.params.id);
  if (!Number.isSafeInteger(categoryId) || categoryId < 1 || !removeCategory(categoryId)) {
    return res.status(404).send('Kategori tidak ditemukan.');
  }
  return res.redirect(`${adminPath}/kategori?dihapus=1`);
});

router.use((req, res) => {
  res.status(404).render('public/not-found', {
    categories: getEditorData(),
    title: 'Halaman Admin Tidak Ditemukan'
  });
});

module.exports = router;
