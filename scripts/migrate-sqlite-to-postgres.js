require('dotenv').config();

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { pool, initializeDatabase } = require('../database');

const sqlitePath = path.resolve(process.env.SQLITE_PATH || path.join(__dirname, '..', 'db', 'saparsplit.db'));

function parseJson(value, fallback) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

async function migrate() {
  let sqlite;
  try {
    sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  } catch (error) {
    throw new Error(`Could not open SQLite database at ${sqlitePath}: ${error.message}`);
  }

  try {
    await initializeDatabase();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: counts } = await client.query(`
        SELECT
          (SELECT COUNT(*) FROM users) AS users,
          (SELECT COUNT(*) FROM trips) AS trips,
          (SELECT COUNT(*) FROM expenses) AS expenses,
          (SELECT COUNT(*) FROM places) AS places
      `);
      if (Object.values(counts[0]).some((value) => Number(value) > 0)) {
        throw new Error('PostgreSQL destination is not empty. Use a new database to avoid mixing or overwriting records.');
      }

      const users = sqlite.prepare('SELECT * FROM users ORDER BY id').all();
      const trips = sqlite.prepare('SELECT * FROM trips ORDER BY id').all();
      const expenses = sqlite.prepare('SELECT * FROM expenses ORDER BY rowid').all();
      const places = sqlite.prepare('SELECT * FROM places ORDER BY rowid').all();

      for (const user of users) {
        await client.query(
          `INSERT INTO users (id, google_id, email, name, picture, created_at)
           VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()))`,
          [user.id, user.google_id, user.email, user.name, user.picture, user.created_at || null],
        );
      }
      for (const trip of trips) {
        await client.query(
          `INSERT INTO trips (id, user_id, name, currency, date, budget, members, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, COALESCE($8::timestamptz, NOW()))`,
          [trip.id, trip.user_id, trip.name, trip.currency || '₸', trip.date || '', trip.budget || 600000,
            JSON.stringify(parseJson(trip.members, [])), trip.created_at || null],
        );
        await client.query(
          `INSERT INTO trip_members (trip_id, user_id, role) VALUES ($1, $2, 'owner')
           ON CONFLICT (trip_id, user_id) DO NOTHING`,
          [trip.id, trip.user_id],
        );
      }
      for (const expense of expenses) {
        await client.query(
          `INSERT INTO expenses (id, trip_id, description, amount, payer, participants, date, icon, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, COALESCE($9::timestamptz, NOW()))`,
          [expense.id, expense.trip_id, expense.desc || '', expense.amount || 0, expense.payer || '',
            JSON.stringify(parseJson(expense.participants, [])), expense.date || '', expense.icon || '💳', expense.created_at || null],
        );
      }
      for (const place of places) {
        await client.query(
          `INSERT INTO places (id, trip_id, name, category, address, description, cost, favorite, lat, lng, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamptz, NOW()))`,
          [place.id, place.trip_id, place.name || '', place.cat || '', place.addr || '', place.desc || '', place.cost || 0,
            Boolean(place.fav), place.lat, place.lng, place.created_at || null],
        );
      }

      for (const table of ['users', 'trips']) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence('${table}', 'id'),
            COALESCE((SELECT MAX(id) FROM ${table}), 1), EXISTS(SELECT 1 FROM ${table}))`,
        );
      }
      await client.query('COMMIT');
      console.log(`Migrated ${users.length} users, ${trips.length} trips, ${expenses.length} expenses, and ${places.length} places.`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    sqlite.close();
  }
}

migrate().catch(async (error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
