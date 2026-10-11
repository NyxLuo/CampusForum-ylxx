const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { pool, init } = require('./db');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: 'campus-forum-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 3600 * 1000 }
  })
);

const now = () => Math.floor(Date.now() / 1000);

/* ---------------- 工具函数 ---------------- */
async function hasRestriction(userId, type, boardId = null) {
  const t = now();
  if (boardId === null) {
    const r = await pool.query(
      'SELECT 1 FROM restrictions WHERE user_id = $1 AND type = $2 AND board_id IS NULL AND (until IS NULL OR until > $3)',
      [userId, type, t]
    );
    return r.rows.length > 0;
  }
  const r = await pool.query(
    'SELECT 1 FROM restrictions WHERE user_id = $1 AND type = $2 AND board_id = $3 AND (until IS NULL OR until > $4)',
    [userId, type, boardId, t]
  );
  return r.rows.length > 0;
}

async function isModeratorOf(userId, boardId) {
  const r = await pool.query('SELECT 1 FROM board_moderators WHERE user_id = $1 AND board_id = $2', [userId, boardId]);
  return r.rows.length > 0;
}

async function canManageBoard(user, boardId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return await isModeratorOf(user.id, boardId);
}

async function canInteract(user, boardId = null) {
  if (!user) return { ok: false, reason: '请先登录' };
  if (user.status === 'pending') return { ok: false, reason: '账号待审核，暂无法操作' };
  if (user.status === 'rejected') return { ok: false, reason: '账号未通过审核' };
  if (user.status === 'banned') return { ok: false, reason: '账号已被封禁' };
  if (await hasRestriction(user.id, 'site_ban')) return { ok: false, reason: '账号已被全站封禁' };
  if (await hasRestriction(user.id, 'site_mute')) return { ok: false, reason: '你已被全站禁言' };
  if (boardId) {
    if (await hasRestriction(user.id, 'board_ban', boardId))
      return { ok: false, reason: '你已被本版封禁' };
    if (await hasRestriction(user.id, 'board_mute', boardId))
      return { ok: false, reason: '你已被本版禁言' };
  }
  return { ok: true };
}

async function notify(userId, content, link = '') {
  if (!userId) return;
  await pool.query(
    'INSERT INTO notifications (user_id, content, link, created_at) VALUES ($1, $2, $3, $4)',
    [userId, content, link, now()]
  );
}

async function likeCount(targetType, targetId) {
  const r = await pool.query('SELECT COUNT(*) AS c FROM likes WHERE target_type = $1 AND target_id = $2', [targetType, targetId]);
  return parseInt(r.rows[0].c);
}

async function hasLiked(userId, targetType, targetId) {
  if (!userId) return false;
  const r = await pool.query(
    'SELECT 1 FROM likes WHERE user_id = $1 AND target_type = $2 AND target_id = $3',
    [userId, targetType, targetId]
  );
  return r.rows.length > 0;
}

app.locals.timeAgo = (ts) => {
  const diff = now() - ts;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前';
  return new Date(ts * 1000).toLocaleDateString('zh-CN');
};
app.locals.formatTime = (ts) => new Date(ts * 1000).toLocaleString('zh-CN');
app.locals.nl2br = (str) =>
  String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

// 临时占位符，避免 EJS 模板报错（推荐改为直接在 SQL 里查 like_count）
app.locals.likeCount = () => 0;
app.locals.hasLiked = () => false;

/* ---------------- 当前用户中间件 ---------------- */
app.use(async (req, res, next) => {
  res.locals.user = null;
  res.locals.unreadCount = 0;
  res.locals.modBoards = [];
  req.user = null;
  req.modBoards = [];
  if (req.session.userId) {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    const user = userRes.rows[0];
    if (user) {
      const banned = user.status === 'banned' || (await hasRestriction(user.id, 'site_ban'));
      if (banned) {
        req.session.destroy(() => {});
      } else {
        res.locals.user = user;
        req.user = user;
        const unreadRes = await pool.query('SELECT COUNT(*) AS c FROM notifications WHERE user_id = $1 AND is_read = 0', [user.id]);
        res.locals.unreadCount = parseInt(unreadRes.rows[0].c);
        const modRes = await pool.query('SELECT board_id FROM board_moderators WHERE user_id = $1', [user.id]);
        req.modBoards = modRes.rows.map((r) => r.board_id);
        res.locals.modBoards = req.modBoards;
      }
    }
  }
  next();
});

/* =====================================================
   认证
===================================================== */
app.get('/', async (req, res) => {
  const boardsRes = await pool.query('SELECT * FROM boards ORDER BY sort_order');
  const latestPostsRes = await pool.query(
    `SELECT p.*, u.username, u.avatar_color, b.name AS board_name, b.slug AS board_slug,
      (SELECT COUNT(*) FROM replies WHERE post_id = p.id) AS reply_count,
      (SELECT COUNT(*) FROM likes WHERE target_type='post' AND target_id=p.id) AS like_count
     FROM posts p JOIN users u ON p.user_id = u.id JOIN boards b ON p.board_id = b.id
     ORDER BY p.created_at DESC LIMIT 15`
  );
  const hotPostsRes = await pool.query(
    `SELECT * FROM (
      SELECT p.*, u.username, b.name AS board_name, b.slug AS board_slug,
        (SELECT COUNT(*) FROM replies WHERE post_id = p.id) AS reply_count,
        (SELECT COUNT(*) FROM likes WHERE target_type='post' AND target_id=p.id) AS like_count
       FROM posts p JOIN users u ON p.user_id = u.id JOIN boards b ON p.board_id = b.id
     ) AS sub ORDER BY (sub.reply_count * 2 + sub.like_count) DESC, sub.created_at DESC LIMIT 10`
  );
  res.render('index', { title: '首页', boards: boardsRes.rows, latestPosts: latestPostsRes.rows, hotPosts: hotPostsRes.rows });
});

app.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('register', { title: '注册', error: null, success: null });
});

app.post('/register', async (req, res) => {
  const { username, password, password2 } = req.body;
  const render = (error, success) =>
    res.render('register', { title: '注册', error, success });
  if (!username || username.length < 2 || username.length > 20)
    return render('用户名长度需在 2-20 字符之间', null);
  if (!password || password.length < 6) return render('密码至少 6 位', null);
  if (password !== password2) return render('两次密码不一致', null);
  
  const existRes = await pool.query('SELECT 1 FROM users WHERE username = $1', [username]);
  if (existRes.rows.length > 0) return render('用户名已被占用', null);

  const colors = ['#a3182a', '#7f1d1d', '#be123c', '#9f1239', '#831843', '#881337'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  await pool.query(
    'INSERT INTO users (username, password, role, status, avatar_color, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [username, bcrypt.hashSync(password, 10), 'user', 'pending', color, now()]
  );
  render(null, '注册成功！请等待管理员审核，审核通过后即可发帖回帖。');
});

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: '登录', error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const userRes = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = userRes.rows[0];
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.render('login', { title: '登录', error: '用户名或密码错误' });
  if (user.status === 'banned')
    return res.render('login', { title: '登录', error: '该账号已被封禁' });
  if (await hasRestriction(user.id, 'site_ban'))
    return res.render('login', { title: '登录', error: '该账号已被全站封禁' });
  if (user.status === 'rejected')
    return res.render('login', { title: '登录', error: '该账号注册未通过审核' });
  req.session.userId = user.id;
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

/* =====================================================
   板块 & 帖子
===================================================== */
app.get('/b/:slug', async (req, res) => {
  const boardRes = await pool.query('SELECT * FROM boards WHERE slug = $1', [req.params.slug]);
  const board = boardRes.rows[0];
  if (!board) return res.status(404).render('404', { title: '板块不存在' });

  if (req.user && await hasRestriction(req.user.id, 'board_ban', board.id)) {
    return res.status(403).render('403', { title: '无权访问', message: '你已被本版封禁' });
  }

  const sort = req.query.sort === 'hot' ? 'hot' : 'new';
  const order = sort === 'hot'
    ? '(sub.is_pinned DESC, (sub.reply_count * 2 + sub.like_count) DESC, sub.created_at DESC)'
    : '(sub.is_pinned DESC, sub.created_at DESC)';

  const postsRes = await pool.query(
    `SELECT * FROM (
      SELECT p.*, u.username, u.avatar_color,
        (SELECT COUNT(*) FROM replies WHERE post_id = p.id) AS reply_count,
        (SELECT COUNT(*) FROM likes WHERE target_type='post' AND target_id=p.id) AS like_count
       FROM posts p JOIN users u ON p.user_id = u.id
       WHERE p.board_id = $1
     ) AS sub ORDER BY ${order}`,
    [board.id]
  );

  const moderatorsRes = await pool.query(
    `SELECT u.id, u.username, u.avatar_color FROM board_moderators bm
     JOIN users u ON u.id = bm.user_id WHERE bm.board_id = $1`,
    [board.id]
  );

  const canPost = await canInteract(req.user, board.id);
  res.render('board', { title: board.name, board, posts: postsRes.rows, moderators: moderatorsRes.rows, sort, canPost });
});

app.get('/b/:slug/new', async (req, res) => {
  const boardRes = await pool.query('SELECT * FROM boards WHERE slug = $1', [req.params.slug]);
  const board = boardRes.rows[0];
  if (!board) return res.status(404).render('404', { title: '板块不存在' });
  const check = await canInteract(req.user, board.id);
  if (!check.ok) return res.status(403).render('403', { title: '无法发帖', message: check.reason });
  res.render('new-post', { title: '发表帖子', board, error: null });
});

app.post('/b/:slug/new', async (req, res) => {
  const boardRes = await pool.query('SELECT * FROM boards WHERE slug = $1', [req.params.slug]);
  const board = boardRes.rows[0];
  if (!board) return res.status(404).render('404', { title: '板块不存在' });
  const check = await canInteract(req.user, board.id);
  if (!check.ok) return res.status(403).render('403', { title: '无法发帖', message: check.reason });

  const { title, content } = req.body;
  if (!title || title.length < 2 || title.length > 100)
    return res.render('new-post', { title: '发表帖子', board, error: '标题长度需在 2-100 字之间' });
  if (!content || content.trim().length === 0)
    return res.render('new-post', { title: '发表帖子', board, error: '内容不能为空' });

  const result = await pool.query(
    'INSERT INTO posts (board_id, user_id, title, content, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [board.id, req.user.id, title.trim(), content.trim(), now()]
  );
  res.redirect('/p/' + result.rows[0].id);
});

app.get('/p/:id', async (req, res) => {
  const postRes = await pool.query(
    `SELECT p.*, u.username, u.avatar_color, b.name AS board_name, b.slug AS board_slug, b.id AS board_id
     FROM posts p JOIN users u ON p.user_id = u.id JOIN boards b ON p.board_id = b.id
     WHERE p.id = $1`,
    [req.params.id]
  );
  const post = postRes.rows[0];
  if (!post) return res.status(404).render('404', { title: '帖子不存在' });

  if (req.user && await hasRestriction(req.user.id, 'board_ban', post.board_id)) {
    return res.status(403).render('403', { title: '无权访问', message: '你已被本版封禁' });
  }

  await pool.query('UPDATE posts SET views = views + 1 WHERE id = $1', [post.id]);

  const repliesRes = await pool.query(
    `SELECT r.*, u.username, u.avatar_color FROM replies r JOIN users u ON r.user_id = u.id
     WHERE r.post_id = $1 ORDER BY r.created_at ASC`,
    [post.id]
  );
  const replies = repliesRes.rows;

  // 为模板直接提供点赞数据，避免模板调用异步函数
  const postLikeRes = await pool.query("SELECT COUNT(*) AS c FROM likes WHERE target_type='post' AND target_id=$1", [post.id]);
  post.like_count = parseInt(postLikeRes.rows[0].c);
  for (let r of replies) {
    const replyLikeRes = await pool.query("SELECT COUNT(*) AS c FROM likes WHERE target_type='reply' AND target_id=$1", [r.id]);
    r.like_count = parseInt(replyLikeRes.rows[0].c);
    r.has_liked = await hasLiked(req.user?.id, 'reply', r.id);
  }
  if (req.user) {
    post.has_liked = await hasLiked(req.user.id, 'post', post.id);
  } else {
    post.has_liked = false;
  }

  const canPost = await canInteract(req.user, post.board_id);
  const canManage = await canManageBoard(req.user, post.board_id);
  const isAuthor = req.user && req.user.id === post.user_id;

  res.render('post', { title: post.title, post, replies, canPost, canManage, isAuthor, error: req.query.error || null });
});

app.post('/p/:id/reply', async (req, res) => {
  const postRes = await pool.query('SELECT * FROM posts WHERE id = $1', [req.params.id]);
  const post = postRes.rows[0];
  if (!post) return res.status(404).render('404', { title: '帖子不存在' });
  const check = await canInteract(req.user, post.board_id);
  if (!check.ok) return res.redirect('/p/' + post.id + '?error=' + encodeURIComponent(check.reason));
  const { content } = req.body;
  if (!content || !content.trim())
    return res.redirect('/p/' + post.id + '?error=' + encodeURIComponent('回复不能为空'));

  await pool.query('INSERT INTO replies (post_id, user_id, content, created_at) VALUES ($1, $2, $3, $4)', [
    post.id, req.user.id, content.trim(), now()
  ]);

  if (post.user_id !== req.user.id) {
    await notify(post.user_id, `有人回复了你的帖子《${post.title}》`, '/p/' + post.id);
  }
  res.redirect('/p/' + post.id);
});

app.post('/p/:id/like', async (req, res) => {
  const postRes = await pool.query('SELECT * FROM posts WHERE id = $1', [req.params.id]);
  const post = postRes.rows[0];
  if (!post) return res.status(404).json({ ok: false });
  const check = await canInteract(req.user, post.board_id);
  if (!check.ok) return res.status(403).json({ ok: false, message: check.reason });

  const existing = await pool.query("SELECT 1 FROM likes WHERE user_id=$1 AND target_type='post' AND target_id=$2", [req.user.id, post.id]);
  if (existing.rows.length > 0) {
    await pool.query("DELETE FROM likes WHERE user_id=$1 AND target_type='post' AND target_id=$2", [req.user.id, post.id]);
  } else {
    await pool.query("INSERT INTO likes (user_id, target_type, target_id, created_at) VALUES ($1, 'post', $2, $3)", [req.user.id, post.id, now()]);
    if (post.user_id !== req.user.id)
      await notify(post.user_id, `有人点赞了你的帖子《${post.title}》`, '/p/' + post.id);
  }
  res.json({ ok: true, count: await likeCount('post', post.id) });
});

app.post('/r/:id/like', async (req, res) => {
  const replyRes = await pool.query('SELECT * FROM replies WHERE id = $1', [req.params.id]);
  const reply = replyRes.rows[0];
  if (!reply) return res.status(404).json({ ok: false });
  const postRes = await pool.query('SELECT * FROM posts WHERE id = $1', [reply.post_id]);
  const post = postRes.rows[0];
  const check = await canInteract(req.user, post.board_id);
  if (!check.ok) return res.status(403).json({ ok: false, message: check.reason });

  const existing = await pool.query("SELECT 1 FROM likes WHERE user_id=$1 AND target_type='reply' AND target_id=$2", [req.user.id, reply.id]);
  if (existing.rows.length > 0) {
    await pool.query("DELETE FROM likes WHERE user_id=$1 AND target_type='reply' AND target_id=$2", [req.user.id, reply.id]);
  } else {
    await pool.query("INSERT INTO likes (user_id, target_type, target_id, created_at) VALUES ($1, 'reply', $2, $3)", [req.user.id, reply.id, now()]);
  }
  res.json({ ok: true, count: await likeCount('reply', reply.id) });
});

app.post('/p/:id/delete', async (req, res) => {
  const postRes = await pool.query('SELECT * FROM posts WHERE id = $1', [req.params.id]);
  const post = postRes.rows[0];
  if (!post) return res.status(404).render('404', { title: '帖子不存在' });
  const canDelete = (req.user && req.user.id === post.user_id) || await canManageBoard(req.user, post.board_id);
  if (!canDelete) return res.status(403).render('403', { title: '无权操作', message: '没有权限' });
  await pool.query('DELETE FROM posts WHERE id = $1', [post.id]);
  const boardRes = await pool.query('SELECT slug FROM boards WHERE id=$1', [post.board_id]);
  res.redirect('/b/' + boardRes.rows[0].slug);
});

app.post('/r/:id/delete', async (req, res) => {
  const replyRes = await pool.query('SELECT * FROM replies WHERE id = $1', [req.params.id]);
  const reply = replyRes.rows[0];
  if (!reply) return res.status(404).render('404', { title: '回复不存在' });
  const postRes = await pool.query('SELECT * FROM posts WHERE id = $1', [reply.post_id]);
  const post = postRes.rows[0];
  const canDelete = (req.user && req.user.id === reply.user_id) || await canManageBoard(req.user, post.board_id);
  if (!canDelete) return res.status(403).render('403', { title: '无权操作', message: '没有权限' });
  await pool.query('DELETE FROM replies WHERE id = $1', [reply.id]);
  res.redirect('/p/' + post.id);
});

app.post('/p/:id/pin', async (req, res) => {
  const postRes = await pool.query('SELECT * FROM posts WHERE id = $1', [req.params.id]);
  const post = postRes.rows[0];
  if (!post || !await canManageBoard(req.user, post.board_id))
    return res.status(403).render('403', { title: '无权操作', message: '没有权限' });
  await pool.query('UPDATE posts SET is_pinned = $1 WHERE id = $2', [post.is_pinned ? 0 : 1, post.id]);
  res.redirect('/p/' + post.id);
});

app.post('/p/:id/essential', async (req, res) => {
  const postRes = await pool.query('SELECT * FROM posts WHERE id = $1', [req.params.id]);
  const post = postRes.rows[0];
  if (!post || !await canManageBoard(req.user, post.board_id))
    return res.status(403).render('403', { title: '无权操作', message: '没有权限' });
  await pool.query('UPDATE posts SET is_essential = $1 WHERE id = $2', [post.is_essential ? 0 : 1, post.id]);
  res.redirect('/p/' + post.id);
});

/* =====================================================
   举报
===================================================== */
app.post('/report', async (req, res) => {
  if (!req.user) return res.status(403).json({ ok: false, message: '请先登录' });
  const { target_type, target_id, reason } = req.body;
  if (!['post', 'reply', 'wall', 'bottle'].includes(target_type))
    return res.status(400).json({ ok: false, message: '类型错误' });
  await pool.query(
    'INSERT INTO reports (reporter_id, target_type, target_id, reason, created_at) VALUES ($1, $2, $3, $4, $5)',
    [req.user.id, target_type, parseInt(target_id, 10), (reason || '').slice(0, 500), now()]
  );
  res.json({ ok: true });
});

/* =====================================================
   用户主页 & 搜索
===================================================== */
app.get('/u/:id', async (req, res) => {
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const u = uRes.rows[0];
  if (!u) return res.status(404).render('404', { title: '用户不存在' });
  const postsRes = await pool.query(
    `SELECT p.*, b.name AS board_name, b.slug AS board_slug,
      (SELECT COUNT(*) FROM replies WHERE post_id=p.id) AS reply_count,
      (SELECT COUNT(*) FROM likes WHERE target_type='post' AND target_id=p.id) AS like_count
     FROM posts p JOIN boards b ON b.id=p.board_id
     WHERE p.user_id = $1 ORDER BY p.created_at DESC LIMIT 30`, [u.id]
  );
  const repliesRes = await pool.query(
    `SELECT r.*, p.title AS post_title FROM replies r JOIN posts p ON p.id=r.post_id
     WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 30`, [u.id]
  );
  const modRes = await pool.query('SELECT COUNT(*) AS c FROM board_moderators WHERE user_id=$1', [u.id]);
  const isMod = parseInt(modRes.rows[0].c) > 0;
  res.render('profile', { title: u.username + ' 的主页', profile: u, posts: postsRes.rows, replies: repliesRes.rows, isMod });
});

app.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  let results = [];
  if (q) {
    const like = `%${q}%`;
    const searchRes = await pool.query(
      `SELECT p.*, u.username, b.name AS board_name, b.slug AS board_slug,
        (SELECT COUNT(*) FROM replies WHERE post_id=p.id) AS reply_count,
        (SELECT COUNT(*) FROM likes WHERE target_type='post' AND target_id=p.id) AS like_count
       FROM posts p JOIN users u ON u.id=p.user_id JOIN boards b ON b.id=p.board_id
       WHERE p.title LIKE $1 OR p.content LIKE $2
       ORDER BY p.created_at DESC LIMIT 50`, [like, like]
    );
    results = searchRes.rows;
  }
  res.render('search', { title: '搜索', q, results });
});

/* =====================================================
   匿名留言墙
===================================================== */
app.get('/wall', async (req, res) => {
  const messagesRes = await pool.query(
    `SELECT w.*, u.avatar_color, 
      (SELECT COUNT(*) FROM likes WHERE target_type='wall' AND target_id=w.id) AS like_count
     FROM wall_messages w JOIN users u ON u.id=w.user_id
     WHERE w.status = 'approved' ORDER BY w.created_at DESC LIMIT 200`
  );
  const messages = messagesRes.rows;
  for (let m of messages) {
    m.has_liked = await hasLiked(req.user?.id, 'wall', m.id);
  }
  const myPendingRes = req.user
    ? await pool.query("SELECT * FROM wall_messages WHERE user_id=$1 AND status='pending' ORDER BY created_at DESC", [req.user.id])
    : { rows: [] };
  res.render('wall', { title: '匿名留言墙', messages, myPending: myPendingRes.rows });
});

app.post('/wall', async (req, res) => {
  const check = await canInteract(req.user);
  if (!check.ok) return res.redirect('/wall');
  const { content } = req.body;
  if (!content || !content.trim()) return res.redirect('/wall');
  await pool.query(
    "INSERT INTO wall_messages (user_id, content, status, created_at) VALUES ($1, $2, 'pending', $3)",
    [req.user.id, content.trim().slice(0, 1000), now()]
  );
  res.redirect('/wall');
});

app.post('/wall/:id/like', async (req, res) => {
  const msgRes = await pool.query('SELECT * FROM wall_messages WHERE id=$1', [req.params.id]);
  const msg = msgRes.rows[0];
  if (!msg || msg.status !== 'approved') return res.status(404).json({ ok: false });
  if (!req.user) return res.status(403).json({ ok: false, message: '请先登录' });
  const existing = await pool.query("SELECT 1 FROM likes WHERE user_id=$1 AND target_type='wall' AND target_id=$2", [req.user.id, msg.id]);
  if (existing.rows.length > 0) {
    await pool.query("DELETE FROM likes WHERE user_id=$1 AND target_type='wall' AND target_id=$2", [req.user.id, msg.id]);
  } else {
    await pool.query("INSERT INTO likes (user_id, target_type, target_id, created_at) VALUES ($1, 'wall', $2, $3)", [req.user.id, msg.id, now()]);
  }
  res.json({ ok: true, count: await likeCount('wall', msg.id) });
});

/* =====================================================
   漂流瓶
===================================================== */
app.get('/bottle', async (req, res) => {
  const myThrownRes = req.user
    ? await pool.query("SELECT b.*, (SELECT COUNT(*) FROM bottle_replies WHERE bottle_id=b.id AND status='approved') AS reply_count FROM bottles b WHERE b.user_id=$1 ORDER BY b.created_at DESC", [req.user.id])
    : { rows: [] };
  const myTakenRes = req.user
    ? await pool.query("SELECT b.* FROM bottles b WHERE b.taken_by=$1 ORDER BY b.created_at DESC", [req.user.id])
    : { rows: [] };
  const poolCountRes = await pool.query("SELECT COUNT(*) AS c FROM bottles WHERE status='in_pool'");
  const poolCount = parseInt(poolCountRes.rows[0].c);
  res.render('bottle', { title: '漂流瓶', myThrown: myThrownRes.rows, myTaken: myTakenRes.rows, poolCount });
});

app.post('/bottle/throw', async (req, res) => {
  const check = await canInteract(req.user);
  if (!check.ok) return res.redirect('/bottle');
  const { content } = req.body;
  if (!content || !content.trim()) return res.redirect('/bottle');
  await pool.query("INSERT INTO bottles (user_id, content, status, created_at) VALUES ($1, $2, 'pending', $3)", [req.user.id, content.trim().slice(0, 1000), now()]);
  res.redirect('/bottle');
});

app.post('/bottle/fish', async (req, res) => {
  const check = await canInteract(req.user);
  if (!check.ok) return res.redirect('/bottle');
  const bottleRes = await pool.query("SELECT * FROM bottles WHERE status='in_pool' AND user_id != $1 ORDER BY RANDOM() LIMIT 1", [req.user.id]);
  const bottle = bottleRes.rows[0];
  if (!bottle) return res.redirect('/bottle?msg=' + encodeURIComponent('海里暂时没有漂流瓶了'));
  await pool.query("UPDATE bottles SET status='taken', taken_by=$1 WHERE id=$2", [req.user.id, bottle.id]);
  res.redirect('/bottle/' + bottle.id);
});

app.get('/bottle/:id', async (req, res) => {
  const bottleRes = await pool.query('SELECT * FROM bottles WHERE id=$1', [req.params.id]);
  const bottle = bottleRes.rows[0];
  if (!bottle) return res.status(404).render('404', { title: '漂流瓶不存在' });
  if (!req.user || (bottle.user_id !== req.user.id && bottle.taken_by !== req.user.id && req.user.role !== 'admin')) {
    return res.status(403).render('403', { title: '无权查看', message: '这不是你的漂流瓶' });
  }
  const repliesRes = await pool.query("SELECT * FROM bottle_replies WHERE bottle_id=$1 AND (status='approved' OR user_id=$2) ORDER BY created_at ASC", [bottle.id, req.user.id]);
  res.render('bottle-view', { title: '漂流瓶对话', bottle, replies: repliesRes.rows });
});

app.post('/bottle/:id/reply', async (req, res) => {
  const bottleRes = await pool.query('SELECT * FROM bottles WHERE id=$1', [req.params.id]);
  const bottle = bottleRes.rows[0];
  if (!bottle) return res.status(404).render('404', { title: '漂流瓶不存在' });
  if (!req.user || (bottle.user_id !== req.user.id && bottle.taken_by !== req.user.id))
    return res.status(403).render('403', { title: '无权回复', message: '没有权限' });
  const check = await canInteract(req.user);
  if (!check.ok) return res.redirect('/bottle/' + bottle.id);
  const { content } = req.body;
  if (!content || !content.trim()) return res.redirect('/bottle/' + bottle.id);
  await pool.query("INSERT INTO bottle_replies (bottle_id, user_id, content, status, created_at) VALUES ($1, $2, $3, 'pending', $4)", [bottle.id, req.user.id, content.trim().slice(0, 1000), now()]);
  res.redirect('/bottle/' + bottle.id);
});

/* =====================================================
   通知
===================================================== */
app.get('/notifications', async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const listRes = await pool.query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.id]);
  await pool.query('UPDATE notifications SET is_read=1 WHERE user_id=$1', [req.user.id]);
  res.render('notifications', { title: '通知', list: listRes.rows });
});

/* =====================================================
   权限操作（禁言 / 封禁）
===================================================== */
app.post('/restrict', async (req, res) => {
  if (!req.user) return res.status(403).render('403', { title: '无权操作', message: '请先登录' });
  const { user_id, type, board_id, days, reason } = req.body;
  const targetId = parseInt(user_id, 10);
  const targetRes = await pool.query('SELECT * FROM users WHERE id=$1', [targetId]);
  const target = targetRes.rows[0];
  if (!target) return res.status(404).render('404', { title: '用户不存在' });
  if (target.role === 'admin' && req.user.role !== 'admin')
    return res.status(403).render('403', { title: '无权操作', message: '不能对管理员操作' });

  let bid = board_id ? parseInt(board_id, 10) : null;
  const isAdmin = req.user.role === 'admin';
  if (!isAdmin) {
    if (!bid || !await isModeratorOf(req.user.id, bid))
      return res.status(403).render('403', { title: '无权操作', message: '无权限' });
    if (type !== 'board_mute' && type !== 'board_ban')
      return res.status(403).render('403', { title: '无权操作', message: '版主只能执行板块级操作' });
  }

  if (!['site_ban', 'site_mute', 'board_ban', 'board_mute'].includes(type))
    return res.status(400).render('400', { title: '参数错误' });

  const until = days && parseInt(days, 10) > 0 ? now() + parseInt(days, 10) * 86400 : null;
  await pool.query(
    'INSERT INTO restrictions (user_id, type, board_id, reason, until, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [targetId, type, bid, (reason || '').slice(0, 200), until, req.user.id, now()]
  );
  await notify(targetId, `你被${typeLabel(type)}：${reason || '未说明'}`, '/');
  res.redirect(req.get('referer') || '/admin/users');
});

app.post('/unrestrict', async (req, res) => {
  if (!req.user || req.user.role !== 'admin')
    return res.status(403).render('403', { title: '无权操作', message: '仅管理员' });
  const { id } = req.body;
  await pool.query('DELETE FROM restrictions WHERE id=$1', [parseInt(id, 10)]);
  res.redirect(req.get('referer') || '/admin/users');
});

function typeLabel(t) {
  return ({ site_ban: '全站封禁', site_mute: '全站禁言', board_ban: '板块封禁', board_mute: '板块禁言' }[t] || t);
}
app.locals.typeLabel = typeLabel;

/* =====================================================
   管理后台
===================================================== */
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin')
    return res.status(403).render('403', { title: '无权访问', message: '仅管理员可访问' });
  next();
}

app.get('/admin', adminOnly, async (req, res) => {
  const stats = {
    users: parseInt((await pool.query('SELECT COUNT(*) AS c FROM users')).rows[0].c),
    pendingUsers: parseInt((await pool.query("SELECT COUNT(*) AS c FROM users WHERE status='pending'")).rows[0].c),
    posts: parseInt((await pool.query('SELECT COUNT(*) AS c FROM posts')).rows[0].c),
    replies: parseInt((await pool.query('SELECT COUNT(*) AS c FROM replies')).rows[0].c),
    pendingWall: parseInt((await pool.query("SELECT COUNT(*) AS c FROM wall_messages WHERE status='pending'")).rows[0].c),
    pendingBottle: parseInt((await pool.query("SELECT COUNT(*) AS c FROM bottles WHERE status='pending'")).rows[0].c),
    pendingBottleReply: parseInt((await pool.query("SELECT COUNT(*) AS c FROM bottle_replies WHERE status='pending'")).rows[0].c),
    pendingReports: parseInt((await pool.query("SELECT COUNT(*) AS c FROM reports WHERE status='pending'")).rows[0].c)
  };
  res.render('admin/dashboard', { title: '管理后台', stats });
});

app.get('/admin/users', adminOnly, async (req, res) => {
  const usersRes = await pool.query(
    `SELECT u.*, 
      (SELECT COUNT(*) FROM posts WHERE user_id=u.id) AS post_count,
      (SELECT STRING_AGG(b.name, '、') FROM board_moderators bm JOIN boards b ON b.id=bm.board_id WHERE bm.user_id=u.id) AS mod_boards
     FROM users u ORDER BY u.created_at DESC`
  );
  const boardsRes = await pool.query('SELECT * FROM boards ORDER BY sort_order');
  const restrictionsRes = await pool.query(
    `SELECT r.*, u.username, b.name AS board_name FROM restrictions r
     JOIN users u ON u.id=r.user_id LEFT JOIN boards b ON b.id=r.board_id
     WHERE r.until IS NULL OR r.until > $1 ORDER BY r.created_at DESC`, [now()]
  );
  res.render('admin/users', { title: '用户管理', users: usersRes.rows, boards: boardsRes.rows, restrictions: restrictionsRes.rows });
});

app.post('/admin/users/:id/approve', adminOnly, async (req, res) => {
  await pool.query("UPDATE users SET status='active' WHERE id=$1", [req.params.id]);
  await notify(parseInt(req.params.id, 10), '你的账号已通过审核，现在可以发帖回帖了！', '/');
  res.redirect('/admin/users');
});

app.post('/admin/users/:id/reject', adminOnly, async (req, res) => {
  await pool.query("UPDATE users SET status='rejected' WHERE id=$1", [req.params.id]);
  res.redirect('/admin/users');
});

app.post('/admin/users/:id/promote', adminOnly, async (req, res) => {
  const { board_id } = req.body;
  const uid = parseInt(req.params.id, 10);
  const bid = parseInt(board_id, 10);
  try {
    await pool.query('INSERT INTO board_moderators (board_id, user_id) VALUES ($1, $2) ON CONFLICT (board_id, user_id) DO NOTHING', [bid, uid]);
    await notify(uid, '你已被任命为版主', '/');
  } catch (e) {}
  res.redirect('/admin/users');
});

app.post('/admin/users/:id/demote', adminOnly, async (req, res) => {
  const { board_id } = req.body;
  await pool.query('DELETE FROM board_moderators WHERE board_id=$1 AND user_id=$2', [parseInt(board_id, 10), parseInt(req.params.id, 10)]);
  res.redirect('/admin/users');
});

app.get('/admin/audit', adminOnly, async (req, res) => {
  const wallRes = await pool.query(`SELECT w.*, u.username FROM wall_messages w JOIN users u ON u.id=w.user_id WHERE w.status='pending' ORDER BY w.created_at ASC`);
  const bottlesRes = await pool.query(`SELECT b.*, u.username FROM bottles b JOIN users u ON u.id=b.user_id WHERE b.status='pending' ORDER BY b.created_at ASC`);
  const bottleRepliesRes = await pool.query(`SELECT br.*, u.username, b.content AS bottle_content FROM bottle_replies br JOIN users u ON u.id=br.user_id JOIN bottles b ON b.id=br.bottle_id WHERE br.status='pending' ORDER BY br.created_at ASC`);
  res.render('admin/audit', { title: '内容审核', wall: wallRes.rows, bottles: bottlesRes.rows, bottleReplies: bottleRepliesRes.rows });
});

app.post('/admin/audit/wall/:id/:action', adminOnly, async (req, res) => {
  const { action, id } = req.params;
  const msgRes = await pool.query('SELECT * FROM wall_messages WHERE id=$1', [id]);
  const msg = msgRes.rows[0];
  if (!msg) return res.redirect('/admin/audit');
  if (action === 'approve') {
    await pool.query("UPDATE wall_messages SET status='approved' WHERE id=$1", [id]);
    await notify(msg.user_id, '你的留言墙留言已通过审核', '/wall');
  } else if (action === 'reject') {
    await pool.query("DELETE FROM wall_messages WHERE id=$1", [id]);
    await notify(msg.user_id, '你的留言墙留言未通过审核', '/wall');
  }
  res.redirect('/admin/audit');
});

app.post('/admin/audit/bottle/:id/:action', adminOnly, async (req, res) => {
  const { action, id } = req.params;
  const bRes = await pool.query('SELECT * FROM bottles WHERE id=$1', [id]);
  const b = bRes.rows[0];
  if (!b) return res.redirect('/admin/audit');
  if (action === 'approve') {
    await pool.query("UPDATE bottles SET status='in_pool' WHERE id=$1", [id]);
    await notify(b.user_id, '你的漂流瓶已通过审核，已投入大海', '/bottle');
  } else if (action === 'reject') {
    await pool.query('DELETE FROM bottles WHERE id=$1', [id]);
    await notify(b.user_id, '你的漂流瓶未通过审核', '/bottle');
  }
  res.redirect('/admin/audit');
});

app.post('/admin/audit/bottle-reply/:id/:action', adminOnly, async (req, res) => {
  const { action, id } = req.params;
  const rRes = await pool.query('SELECT * FROM bottle_replies WHERE id=$1', [id]);
  const r = rRes.rows[0];
  if (!r) return res.redirect('/admin/audit');
  if (action === 'approve') {
    await pool.query("UPDATE bottle_replies SET status='approved' WHERE id=$1", [id]);
    const bottleRes = await pool.query('SELECT * FROM bottles WHERE id=$1', [r.bottle_id]);
    const bottle = bottleRes.rows[0];
    const other = bottle.user_id === r.user_id ? bottle.taken_by : bottle.user_id;
    await notify(other, '你的漂流瓶收到了新回复', '/bottle/' + r.bottle_id);
  } else if (action === 'reject') {
    await pool.query('DELETE FROM bottle_replies WHERE id=$1', [id]);
  }
  res.redirect('/admin/audit');
});

app.get('/admin/reports', adminOnly, async (req, res) => {
  const reportsRes = await pool.query(`SELECT rp.*, u.username AS reporter_name FROM reports rp JOIN users u ON u.id=rp.reporter_id ORDER BY rp.created_at DESC LIMIT 200`);
  const reports = reportsRes.rows;
  const enriched = [];
  for (let r of reports) {
    let target = null;
    if (r.target_type === 'post') target = (await pool.query('SELECT title AS t, content AS c, id FROM posts WHERE id=$1', [r.target_id])).rows[0];
    if (r.target_type === 'reply') target = (await pool.query('SELECT content AS c, id FROM replies WHERE id=$1', [r.target_id])).rows[0];
    if (r.target_type === 'wall') target = (await pool.query('SELECT content AS c, id FROM wall_messages WHERE id=$1', [r.target_id])).rows[0];
    if (r.target_type === 'bottle') target = (await pool.query('SELECT content AS c, id FROM bottles WHERE id=$1', [r.target_id])).rows[0];
    enriched.push({ ...r, target });
  }
  res.render('admin/reports', { title: '举报处理', reports: enriched });
});

app.post('/admin/reports/:id/handle', adminOnly, async (req, res) => {
  await pool.query("UPDATE reports SET status='handled' WHERE id=$1", [parseInt(req.params.id, 10)]);
  res.redirect('/admin/reports');
});

app.get('/admin/boards', adminOnly, async (req, res) => {
  const boardsRes = await pool.query('SELECT * FROM boards ORDER BY sort_order');
  const modsRes = await pool.query(`SELECT bm.board_id, u.id, u.username, u.avatar_color FROM board_moderators bm JOIN users u ON u.id=bm.user_id`);
  const modMap = {};
  modsRes.rows.forEach((m) => {
    if (!modMap[m.board_id]) modMap[m.board_id] = [];
    modMap[m.board_id].push(m);
  });
  const activeUsersRes = await pool.query("SELECT id, username FROM users WHERE status='active' AND role!='admin' ORDER BY username");
  res.render('admin/boards', { title: '板块与版主', boards: boardsRes.rows, modMap, activeUsers: activeUsersRes.rows });
});

app.post('/admin/boards/:id/promote', adminOnly, async (req, res) => {
  const bid = parseInt(req.params.id, 10);
  const uid = parseInt(req.body.user_id, 10);
  try {
    await pool.query('INSERT INTO board_moderators (board_id, user_id) VALUES ($1, $2) ON CONFLICT (board_id, user_id) DO NOTHING', [bid, uid]);
    await notify(uid, '你已被任命为版主', '/');
  } catch (e) {}
  res.redirect('/admin/boards');
});

app.post('/admin/boards/:id/demote', adminOnly, async (req, res) => {
  const bid = parseInt(req.params.id, 10);
  const uid = parseInt(req.body.user_id, 10);
  await pool.query('DELETE FROM board_moderators WHERE board_id=$1 AND user_id=$2', [bid, uid]);
  res.redirect('/admin/boards');
});

/* =====================================================
   错误页 & 启动
===================================================== */
app.use((req, res) => {
  res.status(404).render('404', { title: '页面不存在' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('服务器错误：' + err.message);
});

// 因为 init() 现在是异步的，必须等待它执行完毕后再启动服务器
(async () => {
  try {
    await init();
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`校园论坛已启动： http://localhost:${PORT}`);
      console.log('默认管理员：admin / admin123');
    });
  } catch (err) {
    console.error('数据库初始化失败：', err);
  }
})();