const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { db, dbPath, uploadsDir, backupDir } = require('../db');

const MAX_BACKUP_SIZE = 512 * 1024 * 1024;
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function runZip(args) {
  const result = spawnSync('python3', ['-c', `
import os
import sys
import zipfile

mode, archive_path, source_path, *extra = sys.argv[1:]
if mode == "create":
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.write(source_path, "berita.db")
        uploads_path = extra[0]
        for root, dirs, files in os.walk(uploads_path):
            dirs.sort()
            for filename in sorted(files):
                full_path = os.path.join(root, filename)
                relative = os.path.relpath(full_path, uploads_path).replace(os.sep, "/")
                archive.write(full_path, "uploads/" + relative)
elif mode == "validate":
    with zipfile.ZipFile(archive_path) as archive:
        infos = archive.infolist()
        if not infos or len(infos) > 10000:
            raise ValueError("Arsip kosong atau berisi terlalu banyak file.")
        if sum(info.file_size for info in infos) > ${MAX_BACKUP_SIZE}:
            raise ValueError("Ukuran hasil ekstraksi backup melebihi batas.")
        names = set()
        for info in infos:
            name = info.filename.replace("\\\\", "/")
            parts = name.split("/")
            if name.startswith("/") or any(part in ("", ".", "..") for part in parts if part):
                raise ValueError("Arsip memuat path yang tidak aman.")
            if len(parts) != len([part for part in parts if part]):
                raise ValueError("Arsip memuat path yang tidak aman.")
            if info.is_dir():
                continue
            if name in names:
                raise ValueError("Arsip memuat nama file duplikat.")
            names.add(name)
            if name != "berita.db" and not name.startswith("uploads/"):
                raise ValueError("Arsip memuat file yang tidak diizinkan.")
        if "berita.db" not in names:
            raise ValueError("Backup ZIP harus berisi berita.db di root arsip.")
        db_info = next(info for info in infos if info.filename == "berita.db")
        database_path = extra[0]
        with archive.open(db_info) as source, open(database_path, "wb") as target:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                target.write(chunk)
        uploads_path = extra[1]
        os.makedirs(uploads_path, exist_ok=True)
        for info in infos:
            if info.is_dir() or not info.filename.startswith("uploads/"):
                continue
            target_path = os.path.realpath(os.path.join(uploads_path, *info.filename.split("/")[1:]))
            if os.path.commonpath([os.path.realpath(uploads_path), target_path]) != os.path.realpath(uploads_path):
                raise ValueError("Arsip memuat path yang tidak aman.")
            os.makedirs(os.path.dirname(target_path), exist_ok=True)
            with archive.open(info) as source, open(target_path, "wb") as target:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    target.write(chunk)
else:
    raise ValueError("Operasi ZIP tidak dikenal.")
`, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'Operasi arsip ZIP gagal.');
  }
}

function createBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `namaberita-${timestamp}.zip`;
  const backupPath = path.join(backupDir, filename);
  const databaseCopy = `${backupPath}.db`;

  try {
    db.backup(databaseCopy);
    runZip(['create', backupPath, databaseCopy, uploadsDir]);
    return filename;
  } catch (error) {
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    throw error;
  } finally {
    if (fs.existsSync(databaseCopy)) fs.unlinkSync(databaseCopy);
  }
}

function listBackups() {
  return fs.readdirSync(backupDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^namaberita-[\dTZ-]+\.zip$/.test(entry.name))
    .map(entry => {
      const fullPath = path.join(backupDir, entry.name);
      const stats = fs.statSync(fullPath);
      return {
        filename: entry.name,
        size: stats.size,
        createdAt: stats.mtime
      };
    })
    .sort((left, right) => right.createdAt - left.createdAt);
}

function getBackupPath(filename) {
  if (typeof filename !== 'string' || !/^namaberita-[\dTZ-]+\.zip$/.test(filename)) {
    return null;
  }
  const fullPath = path.resolve(backupDir, filename);
  return path.dirname(fullPath) === path.resolve(backupDir) ? fullPath : null;
}

function deleteBackup(filename) {
  const backupPath = getBackupPath(filename);
  if (!backupPath || !fs.existsSync(backupPath)) return false;
  fs.unlinkSync(backupPath);
  return true;
}

function validateDatabaseFile(filename) {
  const Database = require('better-sqlite3');
  const candidate = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const integrity = candidate.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error('Database backup tidak lolos pemeriksaan integritas.');
    const tables = new Set(candidate.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all().map(row => row.name));
    for (const table of ['users', 'categories', 'articles', 'tags', 'article_tags']) {
      if (!tables.has(table)) throw new Error(`Tabel ${table} tidak ditemukan di backup.`);
    }
  } finally {
    candidate.close();
  }
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) fs.copyFileSync(sourcePath, destinationPath);
    else throw new Error('Folder uploads memuat tipe file yang tidak dapat dicadangkan.');
  }
}

function restoreBackup(uploadFile) {
  if (!uploadFile || !Buffer.isBuffer(uploadFile.buffer) || uploadFile.buffer.length < ZIP_SIGNATURE.length ||
      !uploadFile.buffer.subarray(0, ZIP_SIGNATURE.length).equals(ZIP_SIGNATURE)) {
    throw new Error('File yang diunggah bukan arsip ZIP yang valid.');
  }
  if (uploadFile.buffer.length > MAX_BACKUP_SIZE) {
    throw new Error('Ukuran file backup melebihi batas 512 MB.');
  }

  const tempDir = fs.mkdtempSync(path.join(backupDir, '.restore-'));
  const uploadedArchive = path.join(tempDir, 'uploaded.zip');
  const restoredDatabase = path.join(tempDir, 'berita.db');
  const restoredUploads = path.join(tempDir, 'uploads');

  try {
    fs.writeFileSync(uploadedArchive, uploadFile.buffer, { flag: 'wx' });
    runZip(['validate', uploadedArchive, restoredDatabase, restoredUploads]);
    validateDatabaseFile(restoredDatabase);

    const safetyBackup = createBackup();
    const rollbackDir = fs.mkdtempSync(path.join(backupDir, '.rollback-'));
    const rollbackDb = path.join(rollbackDir, 'berita.db');
    const rollbackUploads = path.join(rollbackDir, 'uploads');
    let restored = false;

    try {
      db.backup(rollbackDb);
      copyDirectory(uploadsDir, rollbackUploads);

      db.close();
      fs.copyFileSync(restoredDatabase, dbPath);
      fs.rmSync(uploadsDir, { recursive: true, force: true });
      fs.renameSync(restoredUploads, uploadsDir);
      restored = true;
    } catch (error) {
      if (!restored) {
        if (fs.existsSync(rollbackDb)) fs.copyFileSync(rollbackDb, dbPath);
        if (fs.existsSync(rollbackUploads)) {
          fs.rmSync(uploadsDir, { recursive: true, force: true });
          fs.renameSync(rollbackUploads, uploadsDir);
        }
      }
      throw error;
    } finally {
      fs.rmSync(rollbackDir, { recursive: true, force: true });
    }

    return { safetyBackup, restartRequired: true };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  createBackup,
  deleteBackup,
  getBackupPath,
  listBackups,
  restoreBackup
};
