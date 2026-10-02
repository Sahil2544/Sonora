const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const pool = require('./db');

const app = express();

app.use(cors());
app.use(express.json());

// iTunes store used for online search. IN gives better Hindi/Bollywood results.
const ITUNES_COUNTRY = process.env.ITUNES_COUNTRY || 'IN';

// ---------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------
const toId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const serverError = (res, label, err) => {
  console.error(`${label}:`, err);
  res.status(500).json({ success: false, message: 'Server error' });
};

// Same SELECT for every route that returns songs, so the shape never differs
const SONG_COLUMNS = `
  s.song_id,
  s.song_name AS title,
  s.duration,
  s.audio_url,
  a.artist_name AS artist,
  al.album_name AS album,
  g.genre_name AS genre`;

const SONG_JOINS = `
  LEFT JOIN artist a ON s.artist_id = a.artist_id
  LEFT JOIN album al ON s.album_id = al.album_id
  LEFT JOIN genre g ON s.genre_id = g.genre_id`;

// =======================
// AUTHENTICATION ROUTES
// =======================

// Sign Up (new users start on the free plan)
app.post('/api/signup', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!name || name.length > 100) {
    return res.status(400).json({ success: false, message: 'Please enter your name' });
  }
  if (!isValidEmail(email) || email.length > 100) {
    return res.status(400).json({ success: false, message: 'Please enter a valid email address' });
  }
  if (password.length < 6 || password.length > 72) {
    return res.status(400).json({ success: false, message: 'Password must be 6-72 characters' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT user_id FROM users WHERE LOWER(email) = $1', [email]);
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }

    const hash = await bcrypt.hash(password, 10);
    const newUser = await client.query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING user_id, name, email',
      [name, email, hash]
    );
    const user = newUser.rows[0];

    // Every user is either free or premium - register the new one as free
    await client.query('INSERT INTO free_user (user_id, ad_limit) VALUES ($1, 5)', [user.user_id]);

    await client.query('COMMIT');
    res.json({ success: true, user: { ...user, plan: 'free' } });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }
    serverError(res, 'Signup Error', err);
  } finally {
    client.release();
  }
});

// Login
// Passwords are stored hashed. Older accounts that still have a plain-text
// password can log in once and are upgraded to a hash automatically.
app.post('/api/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }

  try {
    const result = await pool.query(
      `SELECT u.user_id, u.name, u.email, u.password,
              (p.user_id IS NOT NULL) AS is_premium
       FROM users u
       LEFT JOIN premium_user p ON p.user_id = u.user_id
       WHERE LOWER(u.email) = $1`,
      [email]
    );

    const row = result.rows[0];
    let passwordOk = false;

    if (row) {
      if (row.password.startsWith('$2')) {
        passwordOk = await bcrypt.compare(password, row.password);
      } else if (row.password === password) {
        passwordOk = true;
        const hash = await bcrypt.hash(password, 10);
        await pool.query('UPDATE users SET password = $1 WHERE user_id = $2', [hash, row.user_id]);
      }
    }

    if (!passwordOk) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    res.json({
      success: true,
      user: {
        user_id: row.user_id,
        name: row.name,
        email: row.email,
        plan: row.is_premium ? 'premium' : 'free'
      }
    });
  } catch (err) {
    serverError(res, 'Login Error', err);
  }
});

// =======================
// SONGS ROUTES
// =======================

// Fetch all songs (joined with artist, album and genre)
app.get('/api/songs', async (req, res) => {
  try {
    const songs = await pool.query(`
      SELECT ${SONG_COLUMNS}
      FROM song s
      ${SONG_JOINS}
      ORDER BY s.song_id ASC
    `);
    res.json(songs.rows);
  } catch (err) {
    serverError(res, 'Fetch Songs Error', err);
  }
});

// ---------------------------------------------------------------
// Search songs in an online catalog (iTunes Search API - free, no key).
// Every result has a 30 second preview URL. Called from the server so the
// browser never runs into CORS problems. Needs Node 18+ (built-in fetch).
// ---------------------------------------------------------------
app.get('/api/external-search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  try {
    const params = new URLSearchParams({
      term: q,
      media: 'music',
      entity: 'song',
      limit: '25',
      country: ITUNES_COUNTRY
    });
    const response = await fetch(`https://itunes.apple.com/search?${params}`, {
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      throw new Error(`iTunes API responded with status ${response.status}`);
    }
    const data = await response.json();

    // iTunes often lists the same song on a single AND an album - keep one
    const seen = new Set();
    const results = [];

    for (const track of data.results || []) {
      if (!track.previewUrl) continue; // we can only play tracks with a preview

      const key = `${track.trackName}|${track.artistName}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        song_id: `ext-${track.trackId}`, // temporary id, NOT a database id
        title: track.trackName,
        artist: track.artistName,
        album: track.collectionName || 'Single',
        genre: track.primaryGenreName || null,
        release_date: track.releaseDate || null,
        duration: Math.round((track.trackTimeMillis || 0) / 1000), // seconds
        audio_url: track.previewUrl,
        cover: track.artworkUrl100 || null
      });
    }

    res.json(results);
  } catch (err) {
    console.error('External Search Error:', err.message);
    res.status(502).json({ success: false, message: 'Online search is not available right now' });
  }
});

// Map iTunes genre names onto the genres already in our genre table
const GENRE_ALIASES = {
  'bollywood': 'Bollywood',
  'indian pop': 'Bollywood',
  'hindi': 'Bollywood',
  'indian': 'Bollywood',
  'pop': 'Pop',
  'k-pop': 'Pop',
  'rock': 'Rock',
  'hard rock': 'Rock',
  'alternative': 'Indie',
  'indie rock': 'Indie',
  'indie pop': 'Indie',
  'classical': 'Classical',
  'r&b/soul': 'R&B',
  'hip-hop/rap': 'Hip Hop',
  'dance': 'Electronic',
  'electronic': 'Electronic',
  'jazz': 'Jazz',
  'metal': 'Metal',
  'heavy metal': 'Metal'
};

async function findOrCreateGenre(client, itunesGenre) {
  const raw = (itunesGenre || '').trim();
  const genreName = GENRE_ALIASES[raw.toLowerCase()] || raw || 'Other';

  const found = await client.query(
    'SELECT genre_id FROM genre WHERE LOWER(genre_name) = LOWER($1)',
    [genreName]
  );
  if (found.rows.length > 0) return found.rows[0].genre_id;

  const created = await client.query(
    'INSERT INTO genre (genre_name, description) VALUES ($1, $2) RETURNING genre_id',
    [genreName, 'Added from online search']
  );
  return created.rows[0].genre_id;
}

async function findOrCreateArtist(client, artistName) {
  const found = await client.query(
    'SELECT artist_id FROM artist WHERE LOWER(artist_name) = LOWER($1)',
    [artistName]
  );
  if (found.rows.length > 0) return found.rows[0].artist_id;

  const created = await client.query(
    'INSERT INTO artist (artist_name) VALUES ($1) RETURNING artist_id',
    [artistName]
  );
  return created.rows[0].artist_id;
}

// The album table has no artist column, so two artists can both have an album
// called e.g. "Greatest Hits". Only reuse an album that already has a song by
// this artist, otherwise create a separate album row.
async function findOrCreateAlbum(client, albumName, artistId, releaseDate) {
  const found = await client.query(
    `SELECT al.album_id
     FROM album al
     WHERE LOWER(al.album_name) = LOWER($1)
       AND EXISTS (SELECT 1 FROM song s WHERE s.album_id = al.album_id AND s.artist_id = $2)
     LIMIT 1`,
    [albumName, artistId]
  );
  if (found.rows.length > 0) return found.rows[0].album_id;

  const date = releaseDate ? new Date(releaseDate) : null;
  const validDate = date && !Number.isNaN(date.getTime()) ? date : null;
  const albumAge = validDate ? new Date().getFullYear() - validDate.getFullYear() : null;

  const created = await client.query(
    'INSERT INTO album (album_name, release_date, album_age) VALUES ($1, $2, $3) RETURNING album_id',
    [albumName, validDate ? validDate.toISOString().slice(0, 10) : null, albumAge]
  );
  return created.rows[0].album_id;
}

// ---------------------------------------------------------------
// Save a song (picked from the online search) into our database.
// Creates the artist / album / genre rows if they don't exist yet.
// ---------------------------------------------------------------
app.post('/api/songs', async (req, res) => {
  const title = String(req.body.title || '').trim();
  const artist = String(req.body.artist || '').trim();
  const album = String(req.body.album || '').trim() || 'Single';
  const audioUrl = String(req.body.audio_url || '').trim();
  const duration = Math.max(0, Math.round(Number(req.body.duration) || 0));

  if (!title || !artist || !audioUrl) {
    return res.status(400).json({ success: false, message: 'title, artist and audio_url are required' });
  }
  if (title.length > 100 || artist.length > 100 || album.length > 100) {
    return res.status(400).json({ success: false, message: 'Title, artist or album name is too long' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const artistId = await findOrCreateArtist(client, artist);

    // Don't save the same song twice
    const dup = await client.query(
      'SELECT song_id FROM song WHERE LOWER(song_name) = LOWER($1) AND artist_id = $2',
      [title, artistId]
    );
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Song already exists in your library' });
    }

    const albumId = await findOrCreateAlbum(client, album, artistId, req.body.release_date);
    const genreId = await findOrCreateGenre(client, req.body.genre);

    const newSong = await client.query(
      `INSERT INTO song (song_name, duration, artist_id, album_id, genre_id, audio_url)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING song_id`,
      [title, duration, artistId, albumId, genreId, audioUrl]
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, song_id: newSong.rows[0].song_id });
  } catch (err) {
    await client.query('ROLLBACK');
    serverError(res, 'Add Song Error', err);
  } finally {
    client.release();
  }
});

// Delete a song from the whole library (and out of every playlist it's in)
app.delete('/api/songs/:id', async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid song id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM playlist_song WHERE song_id = $1', [id]);
    const result = await client.query('DELETE FROM song WHERE song_id = $1', [id]);
    await client.query('COMMIT');

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Song not found' });
    }
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    serverError(res, 'Delete Song Error', err);
  } finally {
    client.release();
  }
});

// =======================
// PLAYLIST ROUTES
// =======================

// Fetch playlists for a specific user
app.get('/api/playlists/:userId', async (req, res) => {
  const userId = toId(req.params.userId);
  if (!userId) return res.status(400).json({ success: false, message: 'Invalid user id' });

  try {
    const playlists = await pool.query(
      'SELECT playlist_id, playlist_name FROM playlist WHERE user_id = $1 ORDER BY playlist_id DESC',
      [userId]
    );
    res.json(playlists.rows);
  } catch (err) {
    serverError(res, 'Fetch Playlists Error', err);
  }
});

// Create new playlist
app.post('/api/playlists', async (req, res) => {
  const name = String(req.body.playlist_name || '').trim();
  const userId = toId(req.body.user_id);

  if (!name || name.length > 100) {
    return res.status(400).json({ success: false, message: 'Playlist name must be 1-100 characters' });
  }
  if (!userId) return res.status(400).json({ success: false, message: 'Invalid user id' });

  try {
    const newPlaylist = await pool.query(
      'INSERT INTO playlist (playlist_name, user_id) VALUES ($1, $2) RETURNING *',
      [name, userId]
    );
    res.status(201).json({ success: true, playlist: newPlaylist.rows[0] });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).json({ success: false, message: 'User does not exist' });
    }
    serverError(res, 'Create Playlist Error', err);
  }
});

// Rename playlist
app.put('/api/playlists/:id', async (req, res) => {
  const id = toId(req.params.id);
  const name = String(req.body.playlist_name || '').trim();

  if (!id) return res.status(400).json({ success: false, message: 'Invalid playlist id' });
  if (!name || name.length > 100) {
    return res.status(400).json({ success: false, message: 'Playlist name must be 1-100 characters' });
  }

  try {
    const result = await pool.query(
      'UPDATE playlist SET playlist_name = $1 WHERE playlist_id = $2',
      [name, id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Playlist not found' });
    }
    res.json({ success: true });
  } catch (err) {
    serverError(res, 'Update Playlist Error', err);
  }
});

// Delete playlist (its song links first, both in one transaction)
app.delete('/api/playlists/:id', async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid playlist id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM playlist_song WHERE playlist_id = $1', [id]);
    const result = await client.query('DELETE FROM playlist WHERE playlist_id = $1', [id]);
    await client.query('COMMIT');

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Playlist not found' });
    }
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    serverError(res, 'Delete Playlist Error', err);
  } finally {
    client.release();
  }
});

// =======================
// PLAYLIST SONGS ROUTES
// =======================

// Get tracks inside a specific playlist
app.get('/api/playlists/:id/songs', async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid playlist id' });

  try {
    const playlistSongs = await pool.query(`
      SELECT ${SONG_COLUMNS}
      FROM song s
      JOIN playlist_song ps ON s.song_id = ps.song_id
      ${SONG_JOINS}
      WHERE ps.playlist_id = $1
      ORDER BY s.song_id ASC
    `, [id]);
    res.json(playlistSongs.rows);
  } catch (err) {
    serverError(res, 'Fetch Playlist Songs Error', err);
  }
});

// Add song to playlist
app.post('/api/playlists/:id/songs', async (req, res) => {
  const id = toId(req.params.id);
  const songId = toId(req.body.song_id);
  if (!id || !songId) {
    return res.status(400).json({ success: false, message: 'Invalid playlist or song id' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO playlist_song (playlist_id, song_id) VALUES ($1, $2)
       ON CONFLICT (playlist_id, song_id) DO NOTHING`,
      [id, songId]
    );
    if (result.rowCount === 0) {
      return res.status(409).json({ success: false, message: 'Song already exists in playlist' });
    }
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(404).json({ success: false, message: 'Playlist or song not found' });
    }
    serverError(res, 'Add Song to Playlist Error', err);
  }
});

// Remove song from playlist
app.delete('/api/playlists/:id/songs/:songId', async (req, res) => {
  const id = toId(req.params.id);
  const songId = toId(req.params.songId);
  if (!id || !songId) {
    return res.status(400).json({ success: false, message: 'Invalid playlist or song id' });
  }

  try {
    await pool.query(
      'DELETE FROM playlist_song WHERE playlist_id = $1 AND song_id = $2',
      [id, songId]
    );
    res.json({ success: true });
  } catch (err) {
    serverError(res, 'Remove Song from Playlist Error', err);
  }
});

// =======================
// FALLBACKS
// =======================

// Unknown route
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Bad JSON body or any other error that slipped through
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Invalid JSON body' });
  }
  console.error('Unhandled Error:', err);
  res.status(500).json({ success: false, message: 'Server error' });
});

// =======================
// START
// =======================
const PORT = process.env.PORT || 5000;

async function start() {
  try {
    // Fail early with a clear message if the database is not reachable
    await pool.query('SELECT 1');
    console.log('Database connected');

    // Songs need a link to their audio. Safe to run on every start.
    await pool.query('ALTER TABLE song ADD COLUMN IF NOT EXISTS audio_url TEXT');
  } catch (err) {
    console.error('Database problem:', err.message);
    console.error('Check the PG* values in your .env file and that PostgreSQL is running.');
  }

  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

start();
