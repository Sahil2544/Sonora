// One-time script: fills in audio_url for songs that don't have one yet.
// Run from the server folder:   npm run backfill     (or: node Backfill.js)
require('dotenv').config();
const pool = require('./db');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const normalize = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Try the configured store first, then the US store as a fallback
const COUNTRIES = [...new Set([process.env.ITUNES_COUNTRY || 'IN', 'US'])];

async function searchItunes(term, country) {
  const params = new URLSearchParams({ term, media: 'music', entity: 'song', limit: '10', country });
  const response = await fetch(`https://itunes.apple.com/search?${params}`, {
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`iTunes responded with status ${response.status}`);
  const data = await response.json();
  return (data.results || []).filter(track => track.previewUrl);
}

// Prefer a result with the same title AND artist, then the same title, then the first one
function pickBest(results, songName, artistName) {
  const title = normalize(songName);
  const artist = normalize(artistName);
  return (
    results.find(t => normalize(t.trackName) === title && normalize(t.artistName).includes(artist)) ||
    results.find(t => normalize(t.trackName) === title) ||
    null
  );
}

async function main() {
  const { rows } = await pool.query(`
    SELECT s.song_id, s.song_name, a.artist_name
    FROM song s
    LEFT JOIN artist a ON s.artist_id = a.artist_id
    WHERE s.audio_url IS NULL OR s.audio_url = ''
    ORDER BY s.song_id
  `);

  console.log(`${rows.length} song(s) missing audio_url\n`);

  for (const song of rows) {
    const term = `${song.song_name} ${song.artist_name || ''}`.trim();
    let saved = false;

    try {
      for (const country of COUNTRIES) {
        const hit = pickBest(await searchItunes(term, country), song.song_name, song.artist_name);
        if (hit) {
          await pool.query('UPDATE song SET audio_url = $1 WHERE song_id = $2', [hit.previewUrl, song.song_id]);
          console.log(`OK   #${song.song_id} "${term}"  ->  "${hit.trackName}" by ${hit.artistName} [${country}]`);
          saved = true;
          break;
        }
        await sleep(3000);
      }
      if (!saved) {
        console.log(`MISS #${song.song_id} "${term}"  (no exact match - add it from the Search tab instead)`);
      }
    } catch (err) {
      console.error(`FAIL #${song.song_id} "${term}":`, err.message);
    }

    await sleep(3000); // iTunes allows roughly 20 requests per minute
  }

  await pool.end();
  console.log('\nDone.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
