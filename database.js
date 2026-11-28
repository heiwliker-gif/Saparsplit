const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL connection error:', error.message);
});

async function initializeDatabase() {
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
}

module.exports = { pool, initializeDatabase };
