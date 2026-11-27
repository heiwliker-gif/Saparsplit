const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const databasePath = path.resolve(process.env.SQLITE_PATH || path.join(__dirname, 'db', 'saparsplit.db'));
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

function query(sql, params = []) {
  const sqliteSql = sql
    .replace(/::jsonb/gi, '')
    .replace(/\s+FOR UPDATE\b/gi, '')
    .replace(/\$(\d+)/g, '?$1');
  const statement = db.prepare(sqliteSql);

  if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sqliteSql) || /\bRETURNING\b/i.test(sqliteSql)) {
    const rows = statement.all(...params);
    return { rows, rowCount: rows.length };
  }

  const result = statement.run(...params);
  return { rows: [], rowCount: Number(result.changes) };
}

function tableColumns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

function migrateLegacyColumns() {
  const expenseColumns = tableColumns('expenses');
  if (expenseColumns.includes('desc') && !expenseColumns.includes('description')) {
    db.exec('ALTER TABLE expenses RENAME COLUMN "desc" TO description');
  }

  for (const [oldName, newName] of [['cat', 'category'], ['addr', 'address'], ['desc', 'description'], ['fav', 'favorite']]) {
    const current = tableColumns('places');
    if (current.includes(oldName) && !current.includes(newName)) {
      db.exec(`ALTER TABLE places RENAME COLUMN "${oldName}" TO "${newName}"`);
    }
  }

  const tripColumns = tableColumns('trips');
  if (tripColumns.length && !tripColumns.includes('invite_token')) {
    db.exec('ALTER TABLE trips ADD COLUMN invite_token TEXT');
  }
}

async function initializeDatabase() {
  migrateLegacyColumns();
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  db.exec(schema);
}

const pool = {
  query: async (sql, params) => query(sql, params),
  connect: async () => ({ query, release() {} }),
  end: async () => { if (db.isOpen) db.close(); },
};

module.exports = { pool, initializeDatabase };
