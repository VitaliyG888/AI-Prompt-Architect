/**
 * Схема базы данных. SQLite через встроенный node:sqlite.
 *
 * Принципы:
 *  - все связи через внешние ключи с каскадным удалением;
 *  - JSON-поля хранятся как TEXT с валидацией на уровне приложения;
 *  - миграции по версии через PRAGMA user_version;
 *  - секреты никогда не хранятся в открытом виде (только *_enc).
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../env.ts';
import { log } from '../core/logger.ts';

export const SCHEMA_VERSION = 1;

export function openDatabase(path?: string): DatabaseSync {
  if (!path) mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(path ?? join(config.dataDir, 'app.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (current >= SCHEMA_VERSION) return;

  if (current < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        idea TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'professional',
        status TEXT NOT NULL DEFAULT 'draft',
        stage TEXT NOT NULL DEFAULT 'intake',
        audience TEXT NOT NULL DEFAULT '',
        target_model TEXT NOT NULL DEFAULT '',
        provider_snapshot TEXT NOT NULL DEFAULT '{}',
        settings TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sections (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        section_key TEXT NOT NULL,
        title TEXT NOT NULL,
        order_index INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'not_started',
        content TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        requirements TEXT NOT NULL DEFAULT '[]',
        open_questions TEXT NOT NULL DEFAULT '[]',
        research TEXT NOT NULL DEFAULT '{"status":"pending","sources":[]}',
        quality TEXT NOT NULL DEFAULT '{}',
        alternatives TEXT NOT NULL DEFAULT '[]',
        decisions TEXT NOT NULL DEFAULT '[]',
        flags TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, section_key)
      );
      CREATE INDEX IF NOT EXISTS idx_sections_project ON sections(project_id, order_index);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        section_key TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'chat',
        content TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, created_at);

      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        section_key TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        publisher TEXT NOT NULL DEFAULT '',
        published_at TEXT NOT NULL DEFAULT '',
        snippet TEXT NOT NULL DEFAULT '',
        query TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT '',
        relevance REAL,
        analysis TEXT NOT NULL DEFAULT '{}',
        fetched_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sources_project ON sources(project_id, section_key);

      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        protocol TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key_enc TEXT NOT NULL DEFAULT '',
        default_model TEXT NOT NULL DEFAULT '',
        custom_headers TEXT NOT NULL DEFAULT '{}',
        organization_id TEXT NOT NULL DEFAULT '',
        timeout_ms INTEGER NOT NULL DEFAULT 120000,
        max_retries INTEGER NOT NULL DEFAULT 2,
        enabled INTEGER NOT NULL DEFAULT 1,
        extra TEXT NOT NULL DEFAULT '{}',
        last_check TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS routes (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL UNIQUE,
        provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
        model TEXT NOT NULL DEFAULT '',
        params TEXT NOT NULL DEFAULT '{}',
        fallback_provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
        fallback_model TEXT NOT NULL DEFAULT '',
        use_fallback INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS search_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        base_url TEXT NOT NULL DEFAULT '',
        api_key_enc TEXT NOT NULL DEFAULT '',
        options TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL DEFAULT '',
        operation TEXT NOT NULL,
        provider_id TEXT NOT NULL DEFAULT '',
        provider_name TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ok',
        error_code TEXT NOT NULL DEFAULT '',
        retries INTEGER NOT NULL DEFAULT 0,
        fallback_used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at DESC);

      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        prompt TEXT NOT NULL,
        quality TEXT NOT NULL DEFAULT '{}',
        meta TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_versions_project ON versions(project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS test_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version_id TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL,
        provider_id TEXT NOT NULL DEFAULT '',
        provider_name TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        cases TEXT NOT NULL DEFAULT '[]',
        results TEXT NOT NULL DEFAULT '[]',
        verdict TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_tests_project ON test_runs(project_id, created_at DESC);
    `);
  }

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  log.info('database migrated', { version: SCHEMA_VERSION });
}
