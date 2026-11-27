require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { pool, initializeDatabase } = require('./database');

const PORT = Number(process.env.PORT || 3000);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEMO_AUTH_ENABLED = !GOOGLE_CLIENT_ID && !IS_PRODUCTION;
const JWT_SECRET = process.env.JWT_SECRET || (IS_PRODUCTION ? null : crypto.randomBytes(32).toString('hex'));
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const app = express();

if (IS_PRODUCTION && (!GOOGLE_CLIENT_ID || !JWT_SECRET)) {
  console.error('Set GOOGLE_CLIENT_ID and JWT_SECRET for production.');
  process.exit(1);
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

function userPublic(user) {
  return { id: user.id, email: user.email, name: user.name, picture: user.picture };
}

function parseJson(value, fallback) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

function tripPublic(trip) {
  return {
    id: trip.id,
    ownerId: trip.user_id,
    role: trip.member_role || 'owner',
    isOwner: (trip.member_role || 'owner') === 'owner',
    inviteToken: (trip.member_role || 'owner') === 'owner' ? trip.invite_token : null,
    name: trip.name,
    currency: trip.currency,
    date: trip.date,
    budget: Number(trip.budget),
    members: parseJson(trip.members, []),
    created_at: trip.created_at,
  };
}

function expensePublic(expense) {
  return {
    id: expense.id,
    desc: expense.description,
    amount: Number(expense.amount),
    payer: expense.payer,
    participants: parseJson(expense.participants, []),
    date: expense.date,
    icon: expense.icon,
  };
}

function placePublic(place) {
  return {
    id: place.id,
    name: place.name,
    cat: place.category,
    addr: place.address,
    desc: place.description,
    cost: Number(place.cost),
    fav: Boolean(place.favorite),
    lat: place.lat,
    lng: place.lng,
  };
}

async function getAccessibleTrip(tripId, userId) {
  const result = await pool.query(
    `SELECT trips.*, trip_members.role AS member_role
     FROM trips JOIN trip_members ON trip_members.trip_id = trips.id
     WHERE trips.id = $1 AND trip_members.user_id = $2`,
    [tripId, userId],
  );
  return result.rows[0] || null;
}

app.get('/api/config', (_req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null, demoAuth: DEMO_AUTH_ENABLED });
});

app.post('/api/auth/google', asyncRoute(async (req, res) => {
  if (!googleClient) return res.status(503).json({ error: 'google_auth_not_configured' });
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'missing_credential' });

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    return res.status(401).json({ error: 'invalid_google_token' });
  }

  if (!payload?.sub) return res.status(401).json({ error: 'invalid_google_token' });

  const result = await pool.query(
    `INSERT INTO users (google_id, email, name, picture)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (google_id) DO UPDATE
       SET email = EXCLUDED.email, name = EXCLUDED.name, picture = EXCLUDED.picture
     RETURNING *`,
    [payload.sub, payload.email || null, payload.name || null, payload.picture || null],
  );
  const user = result.rows[0];
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: userPublic(user) });
}));

app.post('/api/auth/demo', asyncRoute(async (_req, res) => {
  if (!DEMO_AUTH_ENABLED) return res.status(404).json({ error: 'demo_auth_disabled' });

  const result = await pool.query(
    `INSERT INTO users (google_id, email, name, picture)
     VALUES ('local-demo-user', 'demo@localhost', 'Демо пользователь', NULL)
     ON CONFLICT (google_id) DO UPDATE
       SET email = EXCLUDED.email, name = EXCLUDED.name
     RETURNING *`,
  );
  const user = result.rows[0];
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: userPublic(user) });
}));

app.get('/api/trips', requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT trips.*, trip_members.role AS member_role
     FROM trips JOIN trip_members ON trip_members.trip_id = trips.id
     WHERE trip_members.user_id = $1 ORDER BY trips.id DESC`,
    [req.userId],
  );
  res.json(result.rows.map(tripPublic));
}));

app.post('/api/trips', requireAuth, asyncRoute(async (req, res) => {
  const { name, currency, date, members, budget } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'missing_name' });
  if (!Array.isArray(members || [])) return res.status(400).json({ error: 'invalid_members' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO trips (user_id, name, currency, date, budget, members, invite_token)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING id`,
      [req.userId, name.trim(), currency || '₸', date || '', Number(budget) || 600000,
        JSON.stringify(members || []), crypto.randomBytes(32).toString('base64url')],
    );
    await client.query('INSERT INTO trip_members (trip_id, user_id, role) VALUES ($1, $2, \'owner\')', [result.rows[0].id, req.userId]);
    await client.query('COMMIT');
    res.status(201).json({ id: result.rows[0].id });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/trips/:id', requireAuth, asyncRoute(async (req, res) => {
  const trip = await getAccessibleTrip(req.params.id, req.userId);
  if (!trip) return res.status(404).json({ error: 'not_found' });

  const [expenses, places, collaborators] = await Promise.all([
    pool.query('SELECT * FROM expenses WHERE trip_id = $1 ORDER BY created_at, id', [trip.id]),
    pool.query('SELECT * FROM places WHERE trip_id = $1 ORDER BY created_at, id', [trip.id]),
    pool.query(
      `SELECT users.id, users.name, users.email, users.picture, trip_members.role, trip_members.joined_at
       FROM trip_members JOIN users ON users.id = trip_members.user_id
       WHERE trip_members.trip_id = $1 ORDER BY trip_members.joined_at, users.id`,
      [trip.id],
    ),
  ]);
  res.json({
    ...tripPublic(trip),
    expenses: expenses.rows.map(expensePublic),
    places: places.rows.map(placePublic),
    collaborators: collaborators.rows,
  });
}));

app.post('/api/trips/join', requireAuth, asyncRoute(async (req, res) => {
  const { inviteToken } = req.body || {};
  if (typeof inviteToken !== 'string' || inviteToken.length < 32 || inviteToken.length > 128) {
    return res.status(400).json({ error: 'invalid_invite' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tripResult = await client.query('SELECT id, members FROM trips WHERE invite_token = $1 FOR UPDATE', [inviteToken]);
    const trip = tripResult.rows[0];
    if (!trip) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'invite_not_found' });
    }
    await client.query(
      `INSERT INTO trip_members (trip_id, user_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT (trip_id, user_id) DO NOTHING`,
      [trip.id, req.userId],
    );
    const userResult = await client.query('SELECT name, email FROM users WHERE id = $1', [req.userId]);
    const user = userResult.rows[0];
    const participantName = user?.name?.trim() || user?.email?.split('@')[0] || '';
    const members = parseJson(trip.members, []);
    if (participantName && !members.some((name) => String(name).toLocaleLowerCase() === participantName.toLocaleLowerCase())) {
      await client.query('UPDATE trips SET members = $1 WHERE id = $2', [JSON.stringify([...members, participantName]), trip.id]);
    }
    await client.query('COMMIT');
    res.json({ tripId: trip.id });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/trips/:id/invite', requireAuth, asyncRoute(async (req, res) => {
  const trip = await getAccessibleTrip(req.params.id, req.userId);
  if (!trip) return res.status(404).json({ error: 'not_found' });
  if (String(trip.user_id) !== String(req.userId)) return res.status(403).json({ error: 'owner_required' });
  const inviteToken = crypto.randomBytes(32).toString('base64url');
  await pool.query('UPDATE trips SET invite_token = $1 WHERE id = $2', [inviteToken, trip.id]);
  res.json({ inviteToken });
}));

app.delete('/api/trips/:id/members/:userId', requireAuth, asyncRoute(async (req, res) => {
  const trip = await getAccessibleTrip(req.params.id, req.userId);
  if (!trip) return res.status(404).json({ error: 'not_found' });
  if (String(trip.user_id) !== String(req.userId)) return res.status(403).json({ error: 'owner_required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `DELETE FROM trip_members WHERE trip_id = $1 AND user_id = $2 AND role = 'member'`,
      [trip.id, req.params.userId],
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'member_not_found' });
    }
    const inviteToken = crypto.randomBytes(32).toString('base64url');
    await client.query('UPDATE trips SET invite_token = $1 WHERE id = $2', [inviteToken, trip.id]);
    await client.query('COMMIT');
    res.json({ ok: true, inviteToken });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.put('/api/trips/:id', requireAuth, asyncRoute(async (req, res) => {
  const trip = await getAccessibleTrip(req.params.id, req.userId);
  if (!trip) return res.status(404).json({ error: 'not_found' });
  const { name, currency, date, members, budget } = req.body || {};
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ error: 'invalid_name' });
  }
  if (members !== undefined && !Array.isArray(members)) return res.status(400).json({ error: 'invalid_members' });
  if (budget !== undefined && (!Number.isFinite(Number(budget)) || Number(budget) < 0)) {
    return res.status(400).json({ error: 'invalid_budget' });
  }

  const updated = await pool.query(
    `UPDATE trips SET
       name = COALESCE($1, name), currency = COALESCE($2, currency), date = COALESCE($3, date),
       members = COALESCE($4::jsonb, members), budget = COALESCE($5, budget)
     WHERE id = $6 RETURNING *`,
    [
      name === undefined ? null : name.trim(), currency ?? null, date ?? null,
      members === undefined ? null : JSON.stringify(members),
      budget === undefined ? null : Number(budget), req.params.id,
    ],
  );
  res.json(tripPublic({ ...updated.rows[0], member_role: trip.member_role }));
}));

app.delete('/api/trips/:id', requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM trips WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  if (!result.rowCount) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
}));

app.post('/api/trips/:id/expenses', requireAuth, asyncRoute(async (req, res) => {
  const trip = await getAccessibleTrip(req.params.id, req.userId);
  if (!trip) return res.status(404).json({ error: 'not_found' });
  const { id, desc, amount, payer, participants, date, icon } = req.body || {};
  if (typeof desc !== 'string' || !desc.trim() || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'invalid_expense' });
  }
  if (!Array.isArray(participants) || participants.length === 0) return res.status(400).json({ error: 'invalid_participants' });

  const expenseId = id || `e${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(
    `INSERT INTO expenses (id, trip_id, description, amount, payer, participants, date, icon)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [expenseId, trip.id, desc.trim(), Number(amount), payer || '', JSON.stringify(participants), date || '', icon || '💳'],
  );
  res.status(201).json({ id: expenseId });
}));

app.put('/api/trips/:id/expenses/:expenseId', requireAuth, asyncRoute(async (req, res) => {
  const trip = await getAccessibleTrip(req.params.id, req.userId);
  if (!trip) return res.status(404).json({ error: 'not_found' });
  const { desc, amount, payer, participants, date, icon } = req.body || {};
  if (typeof desc !== 'string' || !desc.trim() || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'invalid_expense' });
  }
  if (!Array.isArray(participants) || participants.length === 0) return res.status(400).json({ error: 'invalid_participants' });
  const result = await pool.query(
    `UPDATE expenses SET description=$1, amount=$2, payer=$3, participants=$4::jsonb, date=$5, icon=$6
     WHERE id=$7 AND trip_id=$8 RETURNING id`,
    [desc.trim(), Number(amount), payer || '', JSON.stringify(participants), date || '', icon || '💳', req.params.expenseId, trip.id],
  );
  if (!result.rowCount) return res.status(404).json({ error: 'not_found' });
  res.json({ id: result.rows[0].id });
}));

app.delete('/api/trips/:id/expenses/:expenseId', requireAuth, asyncRoute(async (req, res) => {
  const trip = await getAccessibleTrip(req.params.id, req.userId);
  if (!trip) return res.status(404).json({ error: 'not_found' });
  await pool.query('DELETE FROM expenses WHERE id = $1 AND trip_id = $2', [req.params.expenseId, trip.id]);
  res.json({ ok: true });
}));

app.post('/api/trips/:id/places', requireAuth, asyncRoute(async (req, res) => {
  const trip = await getAccessibleTrip(req.params.id, req.userId);
  if (!trip) return res.status(404).json({ error: 'not_found' });
  const { id, name, cat, addr, desc, cost, fav, lat, lng } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'missing_name' });
  const placeId = id || `p${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(
    `INSERT INTO places (id, trip_id, name, category, address, description, cost, favorite, lat, lng)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [placeId, trip.id, name.trim(), cat || '', addr || '', desc || '', Number(cost) || 0, Boolean(fav), lat ?? null, lng ?? null],
  );
  res.status(201).json({ id: placeId });
}));

app.delete('/api/trips/:id/places/:placeId', requireAuth, asyncRoute(async (req, res) => {
  const trip = await getAccessibleTrip(req.params.id, req.userId);
  if (!trip) return res.status(404).json({ error: 'not_found' });
  await pool.query('DELETE FROM places WHERE id = $1 AND trip_id = $2', [req.params.placeId, trip.id]);
  res.json({ ok: true });
}));

const clientDist = path.join(__dirname, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
} else {
  app.get('/', (_req, res) => res.status(503).send('React client is not built yet. Run npm run build.'));
}

app.use((error, _req, res, _next) => {
  console.error('Request failed:', error.message);
  res.status(500).json({ error: 'server_error' });
});

async function start() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => console.log(`SaparSplit API listening on http://localhost:${PORT}`));
  } catch (error) {
    console.error('Could not open SQLite database. Check SQLITE_PATH and file permissions.', error.message);
    process.exitCode = 1;
    await pool.end();
  }
}

start();
