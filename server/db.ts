import { DatabaseSync } from 'node:sqlite'
import path from 'path'
import fs from 'fs'
import os from 'os'

// Persist DB outside OneDrive sync zone — survives folder cleanups and OneDrive resets.
// FARMASOFT_DATA_DIR overrides the location (used in production, e.g. a Render
// persistent disk mounted at /data) so the SQLite file survives redeploys.
const STABLE_DATA_DIR = process.env.FARMASOFT_DATA_DIR
  ? process.env.FARMASOFT_DATA_DIR
  : process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Farmasoft', 'data')
    : path.join(os.homedir(), '.farmasoft', 'data')

fs.mkdirSync(STABLE_DATA_DIR, { recursive: true })

// Exposed so the admin import endpoint can drop an uploaded DB here.
export const DATA_DIR = STABLE_DATA_DIR

const DB_PATH = path.join(STABLE_DATA_DIR, 'farmasoft.db')

// One-time migration: if DB exists in legacy in-project location, copy it to the stable path
const LEGACY_DB = path.join(process.cwd(), 'data', 'farmasoft.db')
if (fs.existsSync(LEGACY_DB) && !fs.existsSync(DB_PATH)) {
  try {
    fs.copyFileSync(LEGACY_DB, DB_PATH)
    console.log(`[db] Migrated legacy DB → ${DB_PATH}`)
  } catch (e) { console.error('[db] Migration failed:', (e as Error).message) }
}

// Import-on-boot: a DB uploaded via POST /api/admin/import-db lands as
// farmasoft.db.import — swap it in here, before any connection is opened, so a
// full local database (settings, sessions, candidates…) can be restored.
const IMPORT_DB = path.join(STABLE_DATA_DIR, 'farmasoft.db.import')
if (fs.existsSync(IMPORT_DB)) {
  try {
    for (const suffix of ['-wal', '-shm']) {
      const stale = DB_PATH + suffix
      if (fs.existsSync(stale)) fs.rmSync(stale)
    }
    fs.rmSync(DB_PATH, { force: true })
    fs.renameSync(IMPORT_DB, DB_PATH)
    console.log('[db] Restored database from uploaded farmasoft.db.import')
  } catch (e) { console.error('[db] Import failed:', (e as Error).message) }
}

console.log(`[db] Using ${DB_PATH}`)

let db: DatabaseSync

export function getDb(): DatabaseSync {
  if (db) return db
  db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      location TEXT,
      salary_min INTEGER,
      salary_max INTEGER,
      salary_currency TEXT DEFAULT 'UAH',
      experience_years INTEGER,
      skills TEXT,
      description TEXT,
      requirements TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER REFERENCES jobs(id),
      initials TEXT,
      role TEXT,
      location TEXT,
      experience_years INTEGER,
      salary_expectation INTEGER,
      source_platform TEXT,
      profile_url TEXT,
      tags TEXT,
      status TEXT DEFAULT 'new',
      viewed_at DATETIME,
      contacted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER REFERENCES jobs(id),
      location TEXT,
      radius_km INTEGER,
      salary_min INTEGER,
      platforms TEXT,
      candidates_found INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER REFERENCES jobs(id),
      name TEXT,
      subject TEXT,
      body TEXT,
      language TEXT DEFAULT 'uk',
      ai_generated INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      job_id INTEGER,
      candidate_id INTEGER,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  try { db.exec('ALTER TABLE candidates ADD COLUMN profile_data TEXT') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE candidates ADD COLUMN experience_text TEXT') } catch { /* already exists */ }
  try { db.exec("ALTER TABLE candidates ADD COLUMN source_type TEXT DEFAULT 'scraped'") } catch { /* already exists */ }
  try { db.exec("ALTER TABLE candidates ADD COLUMN stage TEXT DEFAULT 'new'") } catch { /* already exists */ }
  try { db.exec('ALTER TABLE candidates ADD COLUMN qualification_score INTEGER') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE candidates ADD COLUMN qualification_notes TEXT') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE candidates ADD COLUMN cv_filename TEXT') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE candidates ADD COLUMN cv_text TEXT') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE candidates ADD COLUMN rejection_reason TEXT') } catch { /* already exists */ }
  try { db.exec("ALTER TABLE candidates ADD COLUMN decision TEXT DEFAULT 'pending'") } catch { /* already exists */ }
  try { db.exec('ALTER TABLE candidates ADD COLUMN robota_apply_id TEXT') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE candidates ADD COLUMN email TEXT') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE candidates ADD COLUMN phone TEXT') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE candidates ADD COLUMN outreach_count INTEGER DEFAULT 0') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE candidates ADD COLUMN full_name TEXT') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE candidates ADD COLUMN photo_url TEXT') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE candidates ADD COLUMN birth_date TEXT') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE candidates ADD COLUMN updated_at DATETIME') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE jobs ADD COLUMN robota_vacancy_id INTEGER') } catch { /* already exists */ }
  // Robota.ua-aligned fields (used at publication time)
  try { db.exec('ALTER TABLE jobs ADD COLUMN city_id INTEGER') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE jobs ADD COLUMN experience_id INTEGER DEFAULT 0') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE jobs ADD COLUMN education_id INTEGER DEFAULT 0') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE jobs ADD COLUMN schedule_id INTEGER DEFAULT 1') } catch { /* already exists */ }
  try { db.exec("ALTER TABLE jobs ADD COLUMN employment_types TEXT DEFAULT '[\"FullTime\"]'") } catch { /* already exists */ }
  try { db.exec("ALTER TABLE jobs ADD COLUMN work_types TEXT DEFAULT '[\"Office\"]'") } catch { /* already exists */ }
  try { db.exec("ALTER TABLE jobs ADD COLUMN branch_ids TEXT DEFAULT '[]'") } catch { /* already exists */ }
  try { db.exec("ALTER TABLE jobs ADD COLUMN publish_type TEXT DEFAULT 'Anonym'") } catch { /* already exists */ }
  try { db.exec('ALTER TABLE jobs ADD COLUMN contact_person TEXT') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE jobs ADD COLUMN contact_email TEXT') } catch { /* already exists */ }
  try { db.exec("ALTER TABLE jobs ADD COLUMN languages TEXT DEFAULT '[]'") } catch { /* already exists */ }
  try { db.exec('ALTER TABLE jobs ADD COLUMN robota_state TEXT') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE jobs ADD COLUMN robota_error TEXT') } catch { /* already exists */ }
  // Calendly event URI — links a Farmasoft interview to its Calendly booking.
  try { db.exec('ALTER TABLE interviews ADD COLUMN calendly_event_uri TEXT') } catch { /* already exists */ }
  // Hard-delete flag — a job the user removed via the trash icon. Distinct from
  // is_active=0 (a paused job that still shows in the list). deleted=1 jobs are
  // excluded from every list query and are never resurrected by the robota sync.
  try { db.exec('ALTER TABLE jobs ADD COLUMN deleted INTEGER DEFAULT 0') } catch { /* already exists */ }

  // Prevent importing the same robota application twice for the same job
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_robota_apply
             ON candidates(robota_apply_id, job_id)
             WHERE robota_apply_id IS NOT NULL`)
  } catch { /* already exists */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS interviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER REFERENCES candidates(id) ON DELETE CASCADE,
      job_id INTEGER REFERENCES jobs(id),
      scheduled_at DATETIME NOT NULL,
      type TEXT DEFAULT 'phone',
      interviewer TEXT,
      notes TEXT,
      decision TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS salary_analyses (
      job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      keywords_used TEXT NOT NULL,
      sample_size INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Telegram recruiting-bot conversations (one per candidate outreach thread)
    CREATE TABLE IF NOT EXISTS tg_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER REFERENCES candidates(id) ON DELETE CASCADE,
      job_id INTEGER REFERENCES jobs(id),
      peer_id TEXT,                 -- Telegram user id (stored as string)
      peer_username TEXT,
      peer_phone TEXT,
      status TEXT DEFAULT 'awaiting_reply',  -- awaiting_reply|bot_active|human|booked|closed
      bot_enabled INTEGER DEFAULT 1,
      last_seen_message_id INTEGER DEFAULT 0,
      turn_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Individual messages within a Telegram conversation
    CREATE TABLE IF NOT EXISTS tg_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER REFERENCES tg_conversations(id) ON DELETE CASCADE,
      direction TEXT NOT NULL,      -- in|out
      sender TEXT NOT NULL,         -- candidate|bot|alena
      text TEXT,
      tg_message_id INTEGER,        -- Telegram's message id (null for unsent drafts)
      status TEXT DEFAULT 'sent',   -- sent|pending_review|discarded
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      read_at DATETIME
    );
  `)

  // Anti-duplicate: never store the same inbound Telegram message twice.
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_messages_unique
             ON tg_messages(conversation_id, tg_message_id)
             WHERE tg_message_id IS NOT NULL`)
  } catch { /* already exists */ }

  // Telegram display name of the peer — used when the conversation is not
  // (yet) linked to a candidate, e.g. dialogs imported from Alena's account.
  try { db.exec('ALTER TABLE tg_conversations ADD COLUMN peer_name TEXT') } catch { /* already exists */ }
  // Peer access hash — required to message a user. GramJS keeps it only in
  // memory and loses it on every restart, so we persist it to keep sending
  // working after a redeploy.
  try { db.exec('ALTER TABLE tg_conversations ADD COLUMN peer_access_hash TEXT') } catch { /* already exists */ }
  // Unread flag — set when a candidate message arrives, cleared when Alena
  // opens the thread.
  try { db.exec('ALTER TABLE tg_conversations ADD COLUMN unread INTEGER DEFAULT 0') } catch { /* already exists */ }

  return db
}
