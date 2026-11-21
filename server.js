require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const multer = require('multer');
const UAParser = require('ua-parser-js');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = process.env.PORT || 3002;
const ALBUM_USER = process.env.ALBUM_USER || 'lijil';
const ALBUM_PASS = process.env.ALBUM_PASS || '1234';
const isProd = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INT PRIMARY KEY DEFAULT 1,
      title TEXT NOT NULL DEFAULT 'Little Stars Collage',
      music_url TEXT,
      music_public_id TEXT
    );
    INSERT INTO settings (id, title)
    VALUES (1, 'Little Stars Collage')
    ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY,
      url TEXT NOT NULL,
      public_id TEXT NOT NULL,
      caption TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS visits (
      id SERIAL PRIMARY KEY,
      ip TEXT,
      location TEXT,
      isp TEXT,
      device TEXT,
      os TEXT,
      browser TEXT,
      event_type TEXT DEFAULT 'Page Open',
      visited_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function uploadBufferToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    stream.end(buffer);
  });
}

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'change-this-long-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);
app.use(express.static('public'));

function getClientIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return (req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || 'Unknown';
}

async function logVisit(req, eventType) {
  try {
    const ip = getClientIP(req);
    const ua = new UAParser(req.headers['user-agent'] || '').getResult();

    const deviceParts = [ua.device.vendor, ua.device.model].filter(Boolean);
    const device = deviceParts.length
      ? `${deviceParts.join(' ')} (${ua.device.type || 'mobile'})`
      : `${ua.os.name || 'Desktop'} Computer`;
    const os = [ua.os.name, ua.os.version].filter(Boolean).join(' ') || 'Unknown OS';
    const browser = [ua.browser.name, ua.browser.version].filter(Boolean).join(' ') || 'Unknown Browser';

    let location = 'Local / Private Network';
    let isp = '';

    if (ip && !ip.startsWith('127.') && !ip.startsWith('192.168.') && !ip.startsWith('10.') && ip !== '::1') {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      try {
        const geoRes = await fetch(
          `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,regionName,country,isp`,
          { signal: controller.signal }
        );
        const geo = await geoRes.json();
        if (geo.status === 'success') {
          location = [geo.city, geo.regionName, geo.country].filter(Boolean).join(', ');
          isp = geo.isp || '';
        } else {
          location = 'Unknown Location';
        }
      } catch (_) {
        location = 'Lookup Timed Out';
      } finally {
        clearTimeout(timeout);
      }
    }

    await pool.query(
      'INSERT INTO visits (ip, location, isp, device, os, browser, event_type) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [ip, location, isp, device, os, browser, eventType]
    );
  } catch (err) {
    console.error('Visit log error:', err.message);
  }
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/me', async (req, res) => {
  const authenticated = Boolean(req.session && req.session.authenticated);
  const now = Date.now();
  if (!req.session.lastPageLog || now - req.session.lastPageLog > 30 * 60 * 1000) {
    req.session.lastPageLog = now;
    logVisit(req, authenticated ? 'Opened Album' : 'Visited Login');
  }
  res.json({ authenticated });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (username === ALBUM_USER && password === ALBUM_PASS) {
    req.session.authenticated = true;
    req.session.lastPageLog = Date.now();
    await logVisit(req, 'Signed In');
    return res.json({ ok: true });
  }
  await logVisit(req, 'Failed Login');
  res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/visits', requireAuth, async (req, res) => {
  try {
    const countRes = await pool.query('SELECT COUNT(*)::int AS total FROM visits');
    const uniqueRes = await pool.query('SELECT COUNT(DISTINCT ip)::int AS unique_ips FROM visits');
    const rowsRes = await pool.query(
      'SELECT id, ip, location, isp, device, os, browser, event_type, visited_at FROM visits ORDER BY visited_at DESC LIMIT 100'
    );
    res.json({
      total: countRes.rows[0].total,
      uniqueIps: uniqueRes.rows[0].unique_ips,
      visits: rowsRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load visits' });
  }
});

app.delete('/api/visits', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM visits');
  res.json({ ok: true });
});

app.get('/api/album', requireAuth, async (req, res) => {
  try {
    const s = await pool.query('SELECT title, music_url FROM settings WHERE id = 1');
    const p = await pool.query('SELECT id, url, caption FROM photos ORDER BY created_at DESC, id DESC');
    res.json({
      title: s.rows[0]?.title || 'Little Stars Collage',
      music: s.rows[0]?.music_url || null,
      photos: p.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/settings', requireAuth, async (req, res) => {
  if (req.body.title) {
    await pool.query('UPDATE settings SET title = $1 WHERE id = 1', [req.body.title]);
  }
  res.json({ ok: true });
});

app.post('/api/photos', requireAuth, upload.array('photos', 30), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No photos selected' });
    }
    const caption = req.body.caption || '';
    for (const file of req.files) {
      const uploaded = await uploadBufferToCloudinary(file.buffer, {
        folder: 'nephew-album/photos',
        resource_type: 'image',
        transformation: [{ width: 1600, crop: 'limit', quality: 'auto' }],
      });
      await pool.query(
        'INSERT INTO photos (url, public_id, caption) VALUES ($1, $2, $3)',
        [uploaded.secure_url, uploaded.public_id, caption]
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
    const existing = await pool.query('SELECT public_id FROM photos WHERE id = $1', [req.params.id]);
    if (existing.rows[0]) {
      await cloudinary.uploader.destroy(existing.rows[0].public_id);
      await pool.query('DELETE FROM photos WHERE id = $1', [req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

app.post('/api/music', requireAuth, upload.single('track'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio selected' });
    const old = await pool.query('SELECT music_public_id FROM settings WHERE id = 1');
    if (old.rows[0]?.music_public_id) {
      await cloudinary.uploader.destroy(old.rows[0].music_public_id, { resource_type: 'video' });
    }
    const uploaded = await uploadBufferToCloudinary(req.file.buffer, {
      folder: 'nephew-album/music',
      resource_type: 'video',
    });
    await pool.query(
      'UPDATE settings SET music_url = $1, music_public_id = $2 WHERE id = 1',
      [uploaded.secure_url, uploaded.public_id]
    );
    res.json({ music: uploaded.secure_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Music upload failed' });
  }
});

initDB()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => console.log(`Cloud album listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Database init error:', err);
    process.exit(1);
  });
