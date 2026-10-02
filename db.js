const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

// Without this, a dropped idle connection would crash the whole server
pool.on('error', (err) => {
  console.error('Unexpected database error:', err.message);
});

module.exports = pool;
