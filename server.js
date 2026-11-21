require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const PORT = process.env.PORT || 3002;

const ALBUM_USER = process.env.ALBUM_USER || 'admin';
const ALBUM_PASS = process.env.ALBUM_PASS || '1234';

// 1. PostgreSQL (Neon) Setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS album_settings (
      id INT PRIMARY KEY DEFAULT 1,
      title TEXT NOT NULL DEFAULT 'Our Little Adventures',
      music_url TEXT,
      music_public_id TEXT
    );
    INSERT INTO album_settings (id, title)
    VALUES (1, 'Our Little Adventures')
    ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS album_photos (
      id SERIAL PRIMARY KEY,
      url TEXT NOT NULL,
      public_id TEXT NOT NULL,
      caption TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// 2. Cloudinary Setup
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const photoStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'nephews-album/photos',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'heic'],
    transformation: [{ width: 1600, crop: 'limit', quality: 'auto' }],
  },
});

const musicStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'nephews-album/music',
    resource_type: 'video',
  },
});

const uploadPhotos = multer({ storage: photoStorage });
const uploadMusic = multer({ storage: musicStorage });

app.set('trust proxy', 1);
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'nephew-album-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);
app.use(express.static('public'));

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Auth Endpoints
app.get('/api/me', (req, res) => {
  res.json({ authenticated: Boolean(req.session && req.session.authenticated) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ALBUM_USER && password === ALBUM_PASS) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid username or password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Protected Album Endpoints
app.get('/api/album', requireAuth, async (req, res) => {
  try {
    const settingsRes = await pool.query('SELECT title, music_url FROM album_settings WHERE id = 1');
    const photosRes = await pool.query('SELECT id, url, caption, created_at FROM album_photos ORDER BY id DESC');
    res.json({
      title: settingsRes.rows[0]?.title || 'Our Little Adventures',
      music: settingsRes.rows[0]?.music_url || null,
      photos: photosRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load album' });
  }
});

app.put('/api/settings', requireAuth, async (req, res) => {
  try {
    const { title } = req.body;
    if (title) {
      await pool.query('UPDATE album_settings SET title = \$1 WHERE id = 1', [title]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update title' });
  }
});

app.post('/api/photos', requireAuth, uploadPhotos.array('photos', 30), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No photos selected' });
    }
    const caption = req.body.caption || '';
    for (const file of req.files) {
      await pool.query(
        'INSERT INTO album_photos (url, public_id, caption) VALUES (\$1, \$2, \$3)',
        [file.path, file.filename, caption]
      );
    }
    res.json({ ok: true, count: req.files.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.delete('/api/photos/:id', requireAuth, async (req, res) => {
  try {
    const found = await pool.query('SELECT public_id FROM album_photos WHERE id = \$1', [req.params.id]);
    if (found.rows[0]) {
      await cloudinary.uploader.destroy(found.rows[0].public_id);
      await pool.query('DELETE FROM album_photos WHERE id = \$1', [req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

app.post('/api/music', requireAuth, uploadMusic.single('track'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio selected' });
    const prev = await pool.query('SELECT music_public_id FROM album_settings WHERE id = 1');
    if (prev.rows[0]?.music_public_id) {
      await cloudinary.uploader.destroy(prev.rows[0].music_public_id, { resource_type: 'video' });
    }
    await pool.query(
      'UPDATE album_settings SET music_url = \$1, music_public_id = \$2 WHERE id = 1',
      [req.file.path, req.file.filename]
    );
    res.json({ music: req.file.path });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Music upload failed' });
  }
});

initDB()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => console.log(`Album running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Database init error:', err);
    process.exit(1);
  });
