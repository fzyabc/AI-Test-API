-- =========================================================
-- 球伴记 MVP - MySQL 8.0 DDL
-- =========================================================
SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE DATABASE IF NOT EXISTS qiu_ban_ji
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;
USE qiu_ban_ji;

CREATE TABLE IF NOT EXISTS users (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  openid          VARCHAR(64) NOT NULL COMMENT '微信 openid',
  nickname        VARCHAR(64) NOT NULL DEFAULT '',
  avatar          VARCHAR(512) NULL,
  status          TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '1=正常,0=禁用',
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_openid (openid),
  KEY idx_users_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户表';

CREATE TABLE IF NOT EXISTS budgets (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id           BIGINT UNSIGNED NOT NULL,
  cycle_type        ENUM('week','month') NOT NULL,
  cycle_key         VARCHAR(16) NOT NULL,
  amount_total      DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  amount_used       DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  over_limit_mode   ENUM('warn','block') NOT NULL DEFAULT 'warn',
  version           INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '乐观锁版本号',
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_budgets_user_cycle (user_id, cycle_type, cycle_key),
  KEY idx_budgets_user_updated (user_id, updated_at),
  CONSTRAINT fk_budgets_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT chk_budgets_amount_total CHECK (amount_total >= 0),
  CONSTRAINT chk_budgets_amount_used CHECK (amount_used >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户预算表';

CREATE TABLE IF NOT EXISTS matches (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sport_type          ENUM('football','basketball') NOT NULL,
  provider            VARCHAR(32) NOT NULL DEFAULT 'manual',
  provider_match_id   VARCHAR(64) NULL,
  league              VARCHAR(128) NOT NULL DEFAULT '',
  home_team           VARCHAR(128) NOT NULL,
  away_team           VARCHAR(128) NOT NULL,
  start_time          DATETIME(3) NOT NULL,
  lock_time           DATETIME(3) NOT NULL,
  status              ENUM('not_started','in_progress','finished','cancelled') NOT NULL DEFAULT 'not_started',
  result_summary      VARCHAR(255) NULL,
  ext                 JSON NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_matches_provider_mid (provider, provider_match_id),
  KEY idx_matches_sport_start (sport_type, start_time),
  KEY idx_matches_status_start (status, start_time),
  KEY idx_matches_lock_time (lock_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='赛事表';

CREATE TABLE IF NOT EXISTS match_follows (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NOT NULL,
  match_id      BIGINT UNSIGNED NOT NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_follows_user_match (user_id, match_id),
  KEY idx_follows_match (match_id),
  CONSTRAINT fk_follows_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_follows_match
    FOREIGN KEY (match_id) REFERENCES matches(id)
    ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户关注赛事';

CREATE TABLE IF NOT EXISTS records (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  match_id        BIGINT UNSIGNED NOT NULL,
  week_key        VARCHAR(16) NOT NULL COMMENT '如 2026-W16',
  pick_content    VARCHAR(255) NOT NULL,
  amount          DECIMAL(12,2) NOT NULL,
  status          ENUM('draft','submitted','settled') NOT NULL DEFAULT 'draft',
  result          ENUM('pending','win','lose','void') NOT NULL DEFAULT 'pending',
  return_amount   DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  profit_loss     DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  note            VARCHAR(500) NULL,
  submitted_at    DATETIME(3) NULL,
  settled_at      DATETIME(3) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_records_user_week_status (user_id, week_key, status, created_at),
  KEY idx_records_match_status (match_id, status),
  KEY idx_records_user_created (user_id, created_at),
  CONSTRAINT fk_records_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_records_match
    FOREIGN KEY (match_id) REFERENCES matches(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_records_amount CHECK (amount > 0),
  CONSTRAINT chk_records_return_amount CHECK (return_amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户记录表';

CREATE TABLE IF NOT EXISTS weekly_reviews (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  week_key        VARCHAR(16) NOT NULL,
  total_records   INT UNSIGNED NOT NULL DEFAULT 0,
  win_count       INT UNSIGNED NOT NULL DEFAULT 0,
  lose_count      INT UNSIGNED NOT NULL DEFAULT 0,
  void_count      INT UNSIGNED NOT NULL DEFAULT 0,
  hit_rate        DECIMAL(8,4) NOT NULL DEFAULT 0.0000,
  net_value       DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  mistake_tags    JSON NULL,
  suggestions     JSON NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_reviews_user_week (user_id, week_key),
  KEY idx_reviews_week (week_key),
  CONSTRAINT fk_reviews_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='周复盘表';

CREATE TABLE IF NOT EXISTS posters (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  week_key        VARCHAR(16) NOT NULL,
  theme           VARCHAR(32) NOT NULL DEFAULT 'dark',
  poster_url      VARCHAR(512) NOT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_posters_user_week (user_id, week_key, created_at),
  CONSTRAINT fk_posters_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='海报记录';
