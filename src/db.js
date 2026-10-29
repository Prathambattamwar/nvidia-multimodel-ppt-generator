import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
dotenv.config();

const dataDir = path.resolve(process.env.DATA_DIR || "./data");
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.resolve(process.env.DATABASE_PATH || path.join(dataDir, "app.sqlite"));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  topic TEXT NOT NULL,
  request_json TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  pptx_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  slide_number INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  image_path TEXT,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  source_url TEXT,
  source_title TEXT,
  source_page_url TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
`);
// Backward-compatible migrations for databases created by earlier ZIP versions.
for (const column of ["source_url", "source_title", "source_page_url"]) {
  try { db.exec(`ALTER TABLE assets ADD COLUMN ${column} TEXT`); } catch (err) {
    if (!String(err.message).includes("duplicate column name")) throw err;
  }
}
export function nowIso() { return new Date().toISOString(); }
export function createJob(job) {
  const now = nowIso();
  db.prepare(`INSERT INTO jobs (id,status,topic,request_json,progress,stage,created_at,updated_at)
    VALUES (@id,'queued',@topic,@request_json,0,'queued',@now,@now)`).run({...job, now});
}
export function updateJob(id, fields) {
  const allowed = ["status", "progress", "stage", "error", "pptx_path"];
  const entries = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!entries.length) return;
  const sql = entries.map(([k]) => `${k}=@${k}`).join(", ");
  db.prepare(`UPDATE jobs SET ${sql}, updated_at=@updated_at WHERE id=@id`)
    .run({...Object.fromEntries(entries), updated_at: nowIso(), id});
}
export function addAsset(asset) {
  db.prepare(`INSERT INTO assets (job_id,slide_number,prompt,image_path,model,status,error,source_url,source_title,source_page_url,created_at)
  VALUES (@job_id,@slide_number,@prompt,@image_path,@model,@status,@error,@source_url,@source_title,@source_page_url,@created_at)`)
    .run({...asset, created_at: nowIso()});
}
export function getJob(id) {
  const job = db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
  if (!job) return null;
  return {
    ...job,
    request: JSON.parse(job.request_json),
    assets: db.prepare("SELECT slide_number, prompt, image_path, model, status, error, source_url, source_title, source_page_url FROM assets WHERE job_id=? ORDER BY slide_number").all(id)
  };
}
export function listJobs(limit=25) {
  return db.prepare("SELECT id,status,topic,progress,stage,error,created_at,updated_at FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit);
}

// Persisted round-robin allocator: one engine is reserved per presentation job.
export function nextRoundRobinIndex(key, count) {
  const total = Math.max(1, Number(count) || 1);
  const run = db.transaction(() => {
    const row = db.prepare("SELECT value FROM app_settings WHERE key=?").get(key);
    const current = Math.max(0, Number(row?.value || 0) || 0) % total;
    const next = (current + 1) % total;
    db.prepare(`INSERT INTO app_settings (key,value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(next));
    return current;
  });
  return run();
}

// Small persistent settings helpers for provider health/cooldown state.
export function getAppSetting(key, fallback = null) {
  const row = db.prepare("SELECT value FROM app_settings WHERE key=?").get(String(key));
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
export function setAppSetting(key, value) {
  db.prepare(`INSERT INTO app_settings (key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(key), JSON.stringify(value));
}
