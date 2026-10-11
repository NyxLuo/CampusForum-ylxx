const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// 连接 Supabase PostgreSQL 数据库
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Supabase 必须开启 SSL
});

async function init() {
  // 创建表结构
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'pending',
      avatar_color TEXT DEFAULT '#a3182a',
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS boards (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS board_moderators (
      id SERIAL PRIMARY KEY,
      board_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      UNIQUE(board_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      board_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      is_pinned INTEGER DEFAULT 0,
      is_essential INTEGER DEFAULT 0,
      views INTEGER DEFAULT 0,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS replies (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS likes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE(user_id, target_type, target_id)
    );
    CREATE TABLE IF NOT EXISTS restrictions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      board_id INTEGER,
      reason TEXT DEFAULT '',
      until BIGINT,
      created_by INTEGER,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wall_messages (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bottles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      taken_by INTEGER,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bottle_replies (
      id SERIAL PRIMARY KEY,
      bottle_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      reporter_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      reason TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      link TEXT DEFAULT '',
      is_read INTEGER DEFAULT 0,
      created_at BIGINT NOT NULL
    );
  `);

  // 初始化默认管理员
  const adminCheck = await pool.query("SELECT * FROM users WHERE role = 'admin'");
  if (adminCheck.rows.length === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await pool.query(
      'INSERT INTO users (username, password, role, status, avatar_color, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      ['admin', hash, 'admin', 'active', '#7f1d1d', Math.floor(Date.now() / 1000)]
    );
    console.log('已创建默认管理员账号：admin / admin123');
  }

  // 初始化板块
  const boardCount = await pool.query('SELECT COUNT(*) AS c FROM boards');
  if (parseInt(boardCount.rows[0].c) === 0) {
    const boards = [
      ['学习区', 'study', '课程讨论、资料分享、学习互助'],
      ['灌水区', 'chat', '天南海北，随便聊聊'],
      ['吐槽区', 'rant', '生活吐槽，情绪发泄'],
      ['树洞', 'treehole', '倾诉你的心事'],
      ['社团活动', 'club', '社团招新、活动宣传'],
      ['公告', 'notice', '官方公告与通知'],
      ['建议', 'feedback', '对论坛的建议与反馈']
    ];
    for (let i = 0; i < boards.length; i++) {
      await pool.query(
        'INSERT INTO boards (name, slug, description, sort_order) VALUES ($1, $2, $3, $4)',
        [boards[i][0], boards[i][1], boards[i][2], i]
      );
    }
  }
}

module.exports = { pool, init };