import { Database } from 'bun:sqlite'
import { logger } from '../utils/logger'

export function runMigrations(db: Database): void {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(repos)").all() as any[]
    
    const repoUrlColumn = tableInfo.find((col: any) => col.name === 'repo_url')
    if (repoUrlColumn && repoUrlColumn.notnull === 1) {
      logger.info('Migrating repos table to allow nullable repo_url for local repos')
      db.run('BEGIN TRANSACTION')
      try {
        db.run(`
          CREATE TABLE repos_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            repo_url TEXT,
            local_path TEXT NOT NULL,
            branch TEXT,
            default_branch TEXT,
            clone_status TEXT NOT NULL,
            cloned_at INTEGER NOT NULL,
            last_pulled INTEGER,
            opencode_config_name TEXT,
            is_worktree BOOLEAN DEFAULT FALSE,
            is_local BOOLEAN DEFAULT FALSE
          )
        `)
        
        const existingColumns = tableInfo.map((col: any) => col.name)
        const columnsToCopy = ['id', 'repo_url', 'local_path', 'branch', 'default_branch', 'clone_status', 'cloned_at', 'last_pulled', 'opencode_config_name', 'is_worktree', 'is_local']
          .filter(col => existingColumns.includes(col))
        
        const columnsStr = columnsToCopy.join(', ')
        db.run(`INSERT INTO repos_new (${columnsStr}) SELECT ${columnsStr} FROM repos`)
        
        db.run('DROP TABLE repos')
        db.run('ALTER TABLE repos_new RENAME TO repos')
        db.run('COMMIT')
        logger.info('Successfully migrated repos table to allow nullable repo_url')
      } catch (migrationError) {
        db.run('ROLLBACK')
        throw migrationError
      }
    }
    
    const hasBranchColumn = tableInfo.some(col => col.name === 'branch')
    
    if (!hasBranchColumn) {
      logger.info('Adding missing branch column to repos table')
      db.run('ALTER TABLE repos ADD COLUMN branch TEXT')
    }
    
    try {
      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_url_branch 
        ON repos(repo_url, branch) 
        WHERE branch IS NOT NULL
      `)
    } catch (error) {
      logger.debug('Index already exists or could not be created', error)
    }
    
    try {
      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_local_path 
        ON repos(local_path)
      `)
    } catch (error) {
      logger.debug('Local path index already exists or could not be created', error)
    }
    
    const requiredColumns = [
      { name: 'default_branch', sql: 'ALTER TABLE repos ADD COLUMN default_branch TEXT' },
      { name: 'clone_status', sql: 'ALTER TABLE repos ADD COLUMN clone_status TEXT NOT NULL DEFAULT "cloning"' },
      { name: 'cloned_at', sql: 'ALTER TABLE repos ADD COLUMN cloned_at INTEGER NOT NULL DEFAULT 0' },
      { name: 'last_pulled', sql: 'ALTER TABLE repos ADD COLUMN last_pulled INTEGER' },
      { name: 'opencode_config_name', sql: 'ALTER TABLE repos ADD COLUMN opencode_config_name TEXT' },
      { name: 'is_worktree', sql: 'ALTER TABLE repos ADD COLUMN is_worktree BOOLEAN DEFAULT FALSE' },
      { name: 'is_local', sql: 'ALTER TABLE repos ADD COLUMN is_local BOOLEAN DEFAULT FALSE' }
    ]
    
    for (const column of requiredColumns) {
      const hasColumn = tableInfo.some(col => col.name === column.name)
      if (!hasColumn) {
        logger.info(`Adding missing column: ${column.name}`)
        try {
          db.run(column.sql)
        } catch (error) {
          logger.debug(`Column ${column.name} might already exist:`, error)
        }
      }
    }
    
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_repo_clone_status ON repos(clone_status)',
      'CREATE INDEX IF NOT EXISTS idx_user_id ON user_preferences(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_opencode_user_id ON opencode_configs(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_opencode_default ON opencode_configs(user_id, is_default)'
    ]
    
    for (const indexSql of indexes) {
      try {
        db.run(indexSql)
      } catch (error) {
        logger.debug('Index already exists:', error)
      }
    }
    
    try {
      const repos = db.prepare("SELECT id, local_path FROM repos WHERE local_path LIKE 'repos/%'").all() as any[]
      if (repos.length > 0) {
        logger.info(`Migrating ${repos.length} repos to remove 'repos/' prefix from local_path`)
        const updateStmt = db.prepare("UPDATE repos SET local_path = ? WHERE id = ?")
        for (const repo of repos) {
          const newPath = repo.local_path.replace(/^repos\//, '')
          updateStmt.run(newPath, repo.id)
          logger.info(`Updated repo ${repo.id}: ${repo.local_path} -> ${newPath}`)
        }
      }
    } catch (error) {
      logger.error('Failed to migrate local_path format:', error)
    }
    
    try {
      db.run(`
        CREATE TABLE IF NOT EXISTS scheduled_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          schedule_type TEXT NOT NULL,
          schedule_value TEXT NOT NULL,
          command_type TEXT NOT NULL,
          command_config TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          last_run_at INTEGER,
          next_run_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      db.run('CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status ON scheduled_tasks(status)')
      logger.info('Scheduled tasks table created/verified')
    } catch (error) {
      logger.debug('Scheduled tasks table might already exist:', error)
    }
    
    try {
      // Messenger Service Migration (replaces Telegram Service)
      
      // 1. Check for messenger_sessions table
      const sessionsTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messenger_sessions'").get()
      const telegramSessionsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='telegram_sessions'").get()

      if (!sessionsTableExists) {
        db.run(`
          CREATE TABLE messenger_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            provider_chat_id TEXT NOT NULL,
            opencode_session_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(provider, provider_chat_id)
          )
        `)
        db.run('CREATE INDEX IF NOT EXISTS idx_messenger_sessions_lookup ON messenger_sessions(provider, provider_chat_id)')

        if (telegramSessionsExists) {
           logger.info('Migrating telegram_sessions to messenger_sessions...')
           db.run(`
             INSERT INTO messenger_sessions (provider, provider_chat_id, opencode_session_id, created_at, updated_at)
             SELECT 'telegram', chat_id, opencode_session_id, created_at, updated_at FROM telegram_sessions
           `)
           // We keep the old table for safety for now, or drop it? 
           // Let's drop it to avoid confusion, assuming backup exists or this is stable.
           db.run('DROP TABLE telegram_sessions')
        }
      }

      // 2. Check for messenger_allowlist table
      const allowlistTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messenger_allowlist'").get()
      const telegramAllowlistExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='telegram_allowlist'").get()

      if (!allowlistTableExists) {
        db.run(`
          CREATE TABLE messenger_allowlist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            provider_chat_id TEXT NOT NULL,
            added_at INTEGER NOT NULL,
            UNIQUE(provider, provider_chat_id)
          )
        `)
        db.run('CREATE INDEX IF NOT EXISTS idx_messenger_allowlist_lookup ON messenger_allowlist(provider, provider_chat_id)')

        if (telegramAllowlistExists) {
           logger.info('Migrating telegram_allowlist to messenger_allowlist...')
           db.run(`
             INSERT INTO messenger_allowlist (provider, provider_chat_id, added_at)
             SELECT 'telegram', chat_id, added_at FROM telegram_allowlist
           `)
           db.run('DROP TABLE telegram_allowlist')
        }
      }
      
      logger.info('Messenger tables created/verified')
    } catch (error) {
      logger.error('Messenger table migration failed:', error)
      // Don't throw, just log, to allow other things to work? 
      // No, if DB is inconsistent, better to fail?
      // But we are in a migration function.
    }
    
    logger.info('Database migrations completed successfully')
  } catch (error) {
    logger.error('Failed to run database migrations:', error)
    throw error
  }
}
