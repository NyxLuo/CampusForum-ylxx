const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { db, init } = require('./db');

init();

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
function hasRestriction(userId, type, boardId = null) {
  const t = now();
  if (boardId === null) {
    return !!db
      .prepare(
        'SELECT 1 FROM restrictions WHERE user_id = ? AND type = ? AND board_id IS NULL AND (until IS NULL OR until > ?)'
      )
      .get(userId, type, t);
  }
  return !!db
    .prepare(
      'SELECT 1 FROM restrictions WHERE user_id = ? AND type = ? AND board_id = ? AND (until IS NULL OR until > ?)'
    )
    .get(userId, type, boardId, t);
}

function isModeratorOf(userId, boardId) {
  return !!db
    .prepare('SELECT 1 FROM board_moderators WHERE user_id = ? AND board_id = ?')
    .get(userId, boardId);
}

function canManageBoard(user, boardId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return isModeratorOf(user.id, boardId);
}

function canInteract(user, boardId = null) {
  if (!user) return { ok: false, reason: '请先登录' };
  if (user.status === 'pending') return { ok: false, reason: '账号待审核，暂无法操作' };
  if (user.status === 'rejected') return { ok: false, reason: '账号未通过审核' };
  if (user.status === 'banned') return { ok: false, reason: '账号已被封禁' };
  if (hasRestriction(user.id, 'site_ban')) return { ok: false, reason: '账号已被全站封禁' };
  if (hasRestriction(user.id, 'site_mute')) return { ok: false, reason: '你已被全站禁言' };
  if (boardId) {
    if (hasRestriction(user.id, 'board_ban', boardId))
      return { ok: false, reason: '你已被本版封禁' };
    if (hasRestriction(user.id, 'board_mute', boardId))
      return { ok: false, reason: '你已被本版禁言' };
  }
  return { ok: true };
}

function notify(userId, content, link = '') {
  if (!userId) return;
  db.prepare(
    'INSERT INTO notifications (user_id, content, link, created_at) VALUES (?, ?, ?, ?)'
  ).run(userId, content, link, now());
}

function likeCount(targetType, targetId) {
  return db
    .prepare('SELECT COUNT(*) AS c FROM likes WHERE target_type = ? AND target_id = ?')
    .get(targetType, targetId).c;
}

function hasLiked(userId, targetType, targetId) {
  if (!userId) return false;
  return !!db
    .prepare(
      'SELECT 1 FROM likes WHERE user_id = ? AND target_type = ? AND target_id = ?'
    )
    .get(userId, targetType, targetId);
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
app.locals.likeCount = likeCount;
app.locals.hasLiked = hasLiked;

/* ---------------- 当前用户中间件 ---------------- */
app.use((req, res, next) => {
  res.locals.user = null;
  res.locals.unreadCount = 0;
  res.locals.modBoards = [];
  req.user = null;
  req.modBoards = [];
  if (req.session.userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (user) {
      if (user.status === 'banned' || hasRestriction(user.id, 'site_ban')) {
        req.session.destroy(() => {});
      } else {
        res.locals.user = user;
        req.user = user;
        res.locals.unreadCount = db
          .prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0')
          .get(user.id).c;
        req.modBoards = db
          .prepare('SELECT board_id FROM board_moderators WHERE user_id = ?')
          .all(user.id)
          .map((r) => r.board_id);
        res.locals.modBoards = req.modBoards;
      }
    }
  }
  next();
});

/* =====================================================
   认证
===================================================== */
app.get('/', (req, res) => {
  const boards = db.prepare('SELECT * FROM boards ORDER BY sort_order').all();
  const latestPosts = db
    .prepare(
      `SELECT p.*, u.username, u.avatar_color, b.name AS board_name, b.slug AS board_slug,
        (SELECT COUNT(*) FROM replies WHERE post_id = p.id) AS reply_count,
        (SELECT COUNT(*) FROM likes WHERE target_type='post' AND target_id=p.id) AS like_count
       FROM posts p JOIN users u ON p.user_id = u.id JOIN boards b ON p.board_id = b.id
       ORDER BY p.created_at DESC LIMIT 15`
    )
    .all();
  const hotPosts = db
    .prepare(
      `SELECT p.*, u.username, b.name AS board_name, b.slug AS board_slug,
        (SELECT COUNT(*) FROM replies WHERE post_id = p.id) AS reply_count,
        (SELECT COUNT(*) FROM likes WHERE target_type='post' AND target_id=p.id) AS like_count
       FROM posts p JOIN users u ON p.user_id = u.id JOIN boards b ON p.board_id = b.id
       ORDER BY (reply_count * 2 + like_count) DESC, p.created_at DESC LIMIT 10`
    )
    .all();
  res.render('index', { title: '首页', boards, latestPosts, hotPosts });
});

app.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('register', { title: '注册', error: null, success: null });
});

app.post('/register', (req, res) => {
  const { username, password, password2 } = req.body;
  const render = (error, success) =>
    res.render('register', { title: '注册', error, success });
  if (!username || username.length < 2 || username.length > 20)
    return render('用户名长度需在 2-20 字符之间', null);
  if (!password || password.length < 6) return render('密码至少 6 位', null);
  if (password !== password2) return render('两次密码不一致', null);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username))
    return render('用户名已被占用', null);

  const colors = ['#a3182a', '#7f1d1d', '#be123c', '#9f1239', '#831843', '#881337'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  db.prepare(
    'INSERT INTO users (username, password, role, status, avatar_color, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(username, bcrypt.hashSync(password, 10), 'user', 'pending', color, now());
  render(null, '注册成功！请等待管理员审核，审核通过后即可发帖回帖。');
});

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: '登录', error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.render('login', { title: '登录', error: '用户名或密码错误' });
  if (user.status === 'banned')
    return res.render('login', { title: '登录', error: '该账号已被封禁' });
  if (hasRestriction(user.id, 'site_ban'))
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
app.get('/b/:slug', (req, res) => {
  const board = db.prepare('SELECT * FROM boards WHERE slug = ?').get(req.params.slug);
  if (!board) return res.status(404).render('404', { title: '板块不存在' });

  // 板块封禁检查
  if (req.user && hasRestriction(req.user.id, 'board_ban', board.id)) {
    return res.status(403).render('403', { title: '无权访问', message: '你已被本版封禁' });
  }

  const sort = req.query.sort === 'hot' ? 'hot' : 'new';
  const order =
    sort === 'hot'
      ? '(p.is_pinned DESC, (reply_count * 2 + like_count) DESC, p.created_at DESC)'
      : '(p.is_pinned DESC, p.created_at DESC)';

  const posts = db
    .prepare(
      `SELECT p.*, u.username, u.avatar_color,
        (SELECT COUNT(*) FROM replies WHERE post_id = p.id) AS reply_count,
        (SELECT COUNT(*) FROM likes WHERE target_type='post' AND target_id=p.id) AS like_count
       FROM posts p JOIN users u ON p.user_id = u.id
       WHERE p.board_id = ?
       ORDER BY ${order}`
    )
    .all(board.id);

  const moderators = db
    .prepare(
      `SELECT u.id, u.username, u.avatar_color FROM board_moderators bm
       JOIN users u ON u.id = bm.user_id WHERE bm.board_id = ?`
    )
    .all(board.id);

  const canPost = canInteract(req.user, board.id);
  res.render('board', { title: board.name, board, posts, moderators, sort, canPost });
});

app.get('/b/:slug/new', (req, res) => {
  const board = db.prepare('SELECT * FROM boards WHERE slug = ?').get(req.params.slug);
  if (!board) return res.status(404).render('404', { title: '板块不存在' });
  const check = canInteract(req.user, board.id);
  if (!check.ok) return res.status(403).render('403', { title: '无法发帖', message: check.reason });
  res.render('new-post', { title: '发表帖子', board, error: null });
});

app.post('/b/:slug/new', (req, res) => {
  const board = db.prepare('SELECT * FROM boards WHERE slug = ?').get(req.params.slug);
  if (!board) return res.status(404).render('404', { title: '板块不存在' });
  const check = canInteract(req.user, board.id);
  if (!check.ok) return res.status(403).render('403', { title: '无法发帖', message: check.reason });

  const { title, content } = req.body;
  if (!title || title.length < 2 || title.length > 100)
    return res.render('new-post', { title: '发表帖子', board, error: '标题长度需在 2-100 字之间' });
  if (!content || content.trim().length === 0)
    return res.render('new-post', { title: '发表帖子', board, error: '内容不能为空' });

  const r = db
    .prepare(
      'INSERT INTO posts (board_id, user_id, title, content, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(board.id, req.user.id, title.trim(), content.trim(), now());
  res.redirect('/p/' + r.lastInsertRowid);
});

app.get('/p/:id', (req, res) => {
  const post = db
    .prepare(
      `SELECT p.*, u.username, u.avatar_color, b.name AS board_name, b.slug AS board_slug, b.id AS board_id
       FROM posts p JOIN users u ON p.user_id = u.id JOIN boards b ON p.board_id = b.id
       WHERE p.id = ?`
    )
    .get(req.params.id);
  if (!post) return res.status(404).render('404', { title: '帖子不存在' });

  if (req.user && hasRestriction(req.user.id, 'board_ban', post.board_id)) {
    return res.status(403).render('403', { title: '无权访问', message: '你已被本版封禁' });
  }

  db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').run(post.id);

  const replies = db
    .prepare(
      `SELECT r.*, u.username, u.avatar_color FROM replies r JOIN users u ON r.user_id = u.id
       WHERE r.post_id = ? ORDER BY r.created_at ASC`
    )
    .all(post.id);

  const canPost = canInteract(req.user, post.board_id);
  const canManage = canManageBoard(req.user, post.board_id);
  const isAuthor = req.user && req.user.id === post.user_id;

  res.render('post', {
    title: post.title,
    post,
    replies,
    canPost,
    canManage,
    isAuthor,
    error: req.query.error || null
  });
});

app.post('/p/:id/reply', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).render('404', { title: '帖子不存在' });
  const check = canInteract(req.user, post.board_id);
  if (!check.ok) return res.redirect('/p/' + post.id + '?error=' + encodeURIComponent(check.reason));
  const { content } = req.body;
  if (!content || !content.trim())
    return res.redirect('/p/' + post.id + '?error=' + encodeURIComponent('回复不能为空'));

  db.prepare('INSERT INTO replies (post_id, user_id, content, created_at) VALUES (?, ?, ?, ?)').run(
    post.id,
    req.user.id,
    content.trim(),
    now()
  );

  if (post.user_id !== req.user.id) {
    notify(post.user_id, `有人回复了你的帖子《${post.title}》`, '/p/' + post.id);
  }
  res.redirect('/p/' + post.id);
});

app.post('/p/:id/like', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ ok: false });
  const check = canInteract(req.user, post.board_id);
  if (!check.ok) return res.status(403).json({ ok: false, message: check.reason });

  const existing = db
    .prepare("SELECT 1 FROM likes WHERE user_id=? AND target_type='post' AND target_id=?")
    .get(req.user.id, post.id);
  if (existing) {
    db.prepare("DELETE FROM likes WHERE user_id=? AND target_type='post' AND target_id=?").run(
      req.user.id,
      post.id
    );
  } else {
    db.prepare(
      "INSERT INTO likes (user_id, target_type, target_id, created_at) VALUES (?, 'post', ?, ?)"
    ).run(req.user.id, post.id, now());
    if (post.user_id !== req.user.id)
      notify(post.user_id, `有人点赞了你的帖子《${post.title}》`, '/p/' + post.id);
  }
  res.json({ ok: true, count: likeCount('post', post.id) });
});

app.post('/r/:id/like', (req, res) => {
  const reply = db.prepare('SELECT * FROM replies WHERE id = ?').get(req.params.id);
  if (!reply) return res.status(404).json({ ok: false });
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(reply.post_id);
  const check = canInteract(req.user, post.board_id);
  if (!check.ok) return res.status(403).json({ ok: false, message: check.reason });

  const existing = db
    .prepare("SELECT 1 FROM likes WHERE user_id=? AND target_type='reply' AND target_id=?")
    .get(req.user.id, reply.id);
  if (existing) {
    db.prepare("DELETE FROM likes WHERE user_id=? AND target_type='reply' AND target_id=?").run(
      req.user.id,
      reply.id
    );
  } else {
    db.prepare(
      "INSERT INTO likes (user_id, target_type, target_id, created_at) VALUES (?, 'reply', ?, ?)"
    ).run(req.user.id, reply.id, now());
  }
  res.json({ ok: true, count: likeCount('reply', reply.id) });
});

app.post('/p/:id/delete', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).render('404', { title: '帖子不存在' });
  const canDelete = (req.user && req.user.id === post.user_id) || canManageBoard(req.user, post.board_id);
  if (!canDelete) return res.status(403).render('403', { title: '无权操作', message: '没有权限' });
  db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
  res.redirect('/b/' + db.prepare('SELECT slug FROM boards WHERE id=?').get(post.board_id).slug);
});

app.post('/r/:id/delete', (req, res) => {
  const reply = db.prepare('SELECT * FROM replies WHERE id = ?').get(req.params.id);
  if (!reply) return res.status(404).render('404', { title: '回复不存在' });
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(reply.post_id);
  const canDelete = (req.user && req.user.id === reply.user_id) || canManageBoard(req.user, post.board_id);
  if (!canDelete) return res.status(403).render('403', { title: '无权操作', message: '没有权限' });
  db.prepare('DELETE FROM replies WHERE id = ?').run(reply.id);
  res.redirect('/p/' + post.id);
});

app.post('/p/:id/pin', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post || !canManageBoard(req.user, post.board_id))
    return res.status(403).render('403', { title: '无权操作', message: '没有权限' });
  db.prepare('UPDATE posts SET is_pinned = ? WHERE id = ?').run(post.is_pinned ? 0 : 1, post.id);
  res.redirect('/p/' + post.id);
});

app.post('/p/:id/essential', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post || !canManageBoard(req.user, post.board_id))
    return res.status(403).render('403', { title: '无权操作', message: '没有权限' });
  db.prepare('UPDATE posts SET is_essential = ? WHERE id = ?').run(post.is_essential ? 0 : 1, post.id);
  res.redirect('/p/' + post.id);
});

/* =====================================================
   举报
===================================================== */
app.post('/report', (req, res) => {
  if (!req.user) return res.status(403).json({ ok: false, message: '请先登录' });
  const { target_type, target_id, reason } = req.body;
  if (!['post', 'reply', 'wall', 'bottle'].includes(target_type))
    return res.status(400).json({ ok: false, message: '类型错误' });
  db.prepare(
    'INSERT INTO reports (reporter_id, target_type, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.id, target_type, parseInt(target_id, 10), (reason || '').slice(0, 500), now());
  res.json({ ok: true });
});

/* =====================================================
   用户主页 & 搜索
===================================================== */
app.get('/u/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).render('404', { title: '用户不存在' });
  const posts = db
    .prepare(
      `SELECT p.*, b.name AS board_name, b.slug AS board_slug,
        (SELECT COUNT(*) FROM replies WHERE post_id=p.id) AS reply_count,
        (SELECT COUNT(*) FROM likes WHERE target_type='post' AND target_id=p.id) AS like_count
       FROM posts p JOIN boards b ON b.id=p.board_id
       WHERE p.user_id = ? ORDER BY p.created_at DESC LIMIT 30`
    )
    .all(u.id);
  const replies = db
    .prepare(
      `SELECT r.*, p.title AS post_title FROM replies r JOIN posts p ON p.id=r.post_id
       WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 30`
    )
    .all(u.id);
  const isMod = db.prepare('SELECT COUNT(*) AS c FROM board_moderators WHERE user_id=?').get(u.id).c > 0;
  res.render('profile', { title: u.username + ' 的主页', profile: u, posts, replies, isMod });
});

app.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  let results = [];
  if (q) {
    const like = `%${q}%`;
    results = db
      .prepare(
        `SELECT p.*, u.username, b.name AS board_name, b.slug AS board_slug,
          (SELECT COUNT(*) FROM replies WHERE post_id=p.id) AS reply_count,
          (SELECT COUNT(*) FROM likes WHERE target_type='post' AND target_id=p.id) AS like_count
         FROM posts p JOIN users u ON u.id=p.user_id JOIN boards b ON b.id=p.board_id
         WHERE p.title LIKE ? OR p.content LIKE ?
         ORDER BY p.created_at DESC LIMIT 50`
      )
      .all(like, like);
  }
  res.render('search', { title: '搜索', q, results });
});

/* =====================================================
   匿名留言墙
===================================================== */
app.get('/wall', (req, res) => {
  const messages = db
    .prepare(
      `SELECT w.*, u.avatar_color FROM wall_messages w JOIN users u ON u.id=w.user_id
       WHERE w.status = 'approved' ORDER BY w.created_at DESC LIMIT 200`
    )
    .all();
  const myPending = req.user
    ? db
        .prepare(
          "SELECT * FROM wall_messages WHERE user_id=? AND status='pending' ORDER BY created_at DESC"
        )
        .all(req.user.id)
    : [];
  res.render('wall', { title: '匿名留言墙', messages, myPending });
});

app.post('/wall', (req, res) => {
  const check = canInteract(req.user);
  if (!check.ok) return res.redirect('/wall');
  const { content } = req.body;
  if (!content || !content.trim()) return res.redirect('/wall');
  db.prepare(
    "INSERT INTO wall_messages (user_id, content, status, created_at) VALUES (?, ?, 'pending', ?)"
  ).run(req.user.id, content.trim().slice(0, 1000), now());
  res.redirect('/wall');
});

app.post('/wall/:id/like', (req, res) => {
  const msg = db.prepare('SELECT * FROM wall_messages WHERE id=?').get(req.params.id);
  if (!msg || msg.status !== 'approved') return res.status(404).json({ ok: false });
  if (!req.user) return res.status(403).json({ ok: false, message: '请先登录' });
  const existing = db
    .prepare("SELECT 1 FROM likes WHERE user_id=? AND target_type='wall' AND target_id=?")
    .get(req.user.id, msg.id);
  if (existing) {
    db.prepare("DELETE FROM likes WHERE user_id=? AND target_type='wall' AND target_id=?").run(
      req.user.id,
      msg.id
    );
  } else {
    db.prepare(
      "INSERT INTO likes (user_id, target_type, target_id, created_at) VALUES (?, 'wall', ?, ?)"
    ).run(req.user.id, msg.id, now());
  }
  res.json({ ok: true, count: likeCount('wall', msg.id) });
});

/* =====================================================
   漂流瓶
===================================================== */
app.get('/bottle', (req, res) => {
  const myThrown = req.user
    ? db
        .prepare(
          "SELECT b.*, (SELECT COUNT(*) FROM bottle_replies WHERE bottle_id=b.id AND status='approved') AS reply_count FROM bottles b WHERE b.user_id=? ORDER BY b.created_at DESC"
        )
        .all(req.user.id)
    : [];
  const myTaken = req.user
    ? db
        .prepare(
          "SELECT b.* FROM bottles b WHERE b.taken_by=? ORDER BY b.created_at DESC"
        )
        .all(req.user.id)
    : [];
  const poolCount = db
    .prepare("SELECT COUNT(*) AS c FROM bottles WHERE status='in_pool'")
    .get().c;
  res.render('bottle', { title: '漂流瓶', myThrown, myTaken, poolCount });
});

app.post('/bottle/throw', (req, res) => {
  const check = canInteract(req.user);
  if (!check.ok) return res.redirect('/bottle');
  const { content } = req.body;
  if (!content || !content.trim()) return res.redirect('/bottle');
  db.prepare(
    "INSERT INTO bottles (user_id, content, status, created_at) VALUES (?, ?, 'pending', ?)"
  ).run(req.user.id, content.trim().slice(0, 1000), now());
  res.redirect('/bottle');
});

app.post('/bottle/fish', (req, res) => {
  const check = canInteract(req.user);
  if (!check.ok) return res.redirect('/bottle');
  const bottle = db
    .prepare(
      "SELECT * FROM bottles WHERE status='in_pool' AND user_id != ? ORDER BY RANDOM() LIMIT 1"
    )
    .get(req.user.id);
  if (!bottle) return res.redirect('/bottle?msg=' + encodeURIComponent('海里暂时没有漂流瓶了'));
  db.prepare("UPDATE bottles SET status='taken', taken_by=? WHERE id=?").run(
    req.user.id,
    bottle.id
  );
  res.redirect('/bottle/' + bottle.id);
});

app.get('/bottle/:id', (req, res) => {
  const bottle = db.prepare('SELECT * FROM bottles WHERE id=?').get(req.params.id);
  if (!bottle) return res.status(404).render('404', { title: '漂流瓶不存在' });
  if (
    !req.user ||
    (bottle.user_id !== req.user.id && bottle.taken_by !== req.user.id && req.user.role !== 'admin')
  ) {
    return res.status(403).render('403', { title: '无权查看', message: '这不是你的漂流瓶' });
  }
  const replies = db
    .prepare(
      "SELECT * FROM bottle_replies WHERE bottle_id=? AND (status='approved' OR user_id=?) ORDER BY created_at ASC"
    )
    .all(bottle.id, req.user.id);
  res.render('bottle-view', { title: '漂流瓶对话', bottle, replies });
});

app.post('/bottle/:id/reply', (req, res) => {
  const bottle = db.prepare('SELECT * FROM bottles WHERE id=?').get(req.params.id);
  if (!bottle) return res.status(404).render('404', { title: '漂流瓶不存在' });
  if (
    !req.user ||
    (bottle.user_id !== req.user.id && bottle.taken_by !== req.user.id)
  )
    return res.status(403).render('403', { title: '无权回复', message: '没有权限' });
  const check = canInteract(req.user);
  if (!check.ok) return res.redirect('/bottle/' + bottle.id);
  const { content } = req.body;
  if (!content || !content.trim()) return res.redirect('/bottle/' + bottle.id);
  db.prepare(
    "INSERT INTO bottle_replies (bottle_id, user_id, content, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
  ).run(bottle.id, req.user.id, content.trim().slice(0, 1000), now());
  res.redirect('/bottle/' + bottle.id);
});

/* =====================================================
   通知
===================================================== */
app.get('/notifications', (req, res) => {
  if (!req.user) return res.redirect('/login');
  const list = db
    .prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100')
    .all(req.user.id);
  db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(req.user.id);
  res.render('notifications', { title: '通知', list });
});

/* =====================================================
   权限操作（禁言 / 封禁）
===================================================== */
app.post('/restrict', (req, res) => {
  if (!req.user) return res.status(403).render('403', { title: '无权操作', message: '请先登录' });
  const { user_id, type, board_id, days, reason } = req.body;
  const targetId = parseInt(user_id, 10);
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(targetId);
  if (!target) return res.status(404).render('404', { title: '用户不存在' });
  if (target.role === 'admin' && req.user.role !== 'admin')
    return res.status(403).render('403', { title: '无权操作', message: '不能对管理员操作' });

  let bid = board_id ? parseInt(board_id, 10) : null;

  // 权限：管理员可全站和板块；版主只能在自己板块执行 board_* 类型
  const isAdmin = req.user.role === 'admin';
  if (!isAdmin) {
    if (!bid || !isModeratorOf(req.user.id, bid))
      return res.status(403).render('403', { title: '无权操作', message: '无权限' });
    if (type !== 'board_mute' && type !== 'board_ban')
      return res.status(403).render('403', { title: '无权操作', message: '版主只能执行板块级操作' });
  }

  if (!['site_ban', 'site_mute', 'board_ban', 'board_mute'].includes(type))
    return res.status(400).render('400', { title: '参数错误' });

  const until = days && parseInt(days, 10) > 0 ? now() + parseInt(days, 10) * 86400 : null;

  db.prepare(
    'INSERT INTO restrictions (user_id, type, board_id, reason, until, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(targetId, type, bid, (reason || '').slice(0, 200), until, req.user.id, now());

  notify(targetId, `你被${typeLabel(type)}：${reason || '未说明'}`, '/');

  // 如果是全站封禁，且该用户已有 session，则无法通过中间件
  res.redirect(req.get('referer') || '/admin/users');
});

app.post('/unrestrict', (req, res) => {
  if (!req.user || req.user.role !== 'admin')
    return res.status(403).render('403', { title: '无权操作', message: '仅管理员' });
  const { id } = req.body;
  db.prepare('DELETE FROM restrictions WHERE id=?').run(parseInt(id, 10));
  res.redirect(req.get('referer') || '/admin/users');
});

function typeLabel(t) {
  return (
    {
      site_ban: '全站封禁',
      site_mute: '全站禁言',
      board_ban: '板块封禁',
      board_mute: '板块禁言'
    }[t] || t
  );
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

app.get('/admin', adminOnly, (req, res) => {
  const stats = {
    users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    pendingUsers: db.prepare("SELECT COUNT(*) AS c FROM users WHERE status='pending'").get().c,
    posts: db.prepare('SELECT COUNT(*) AS c FROM posts').get().c,
    replies: db.prepare('SELECT COUNT(*) AS c FROM replies').get().c,
    pendingWall: db.prepare("SELECT COUNT(*) AS c FROM wall_messages WHERE status='pending'").get().c,
    pendingBottle: db.prepare("SELECT COUNT(*) AS c FROM bottles WHERE status='pending'").get().c,
    pendingBottleReply: db.prepare("SELECT COUNT(*) AS c FROM bottle_replies WHERE status='pending'").get().c,
    pendingReports: db.prepare("SELECT COUNT(*) AS c FROM reports WHERE status='pending'").get().c
  };
  res.render('admin/dashboard', { title: '管理后台', stats });
});

app.get('/admin/users', adminOnly, (req, res) => {
  const users = db
    .prepare(
      `SELECT u.*, 
        (SELECT COUNT(*) FROM posts WHERE user_id=u.id) AS post_count,
        (SELECT GROUP_CONCAT(b.name, '、') FROM board_moderators bm JOIN boards b ON b.id=bm.board_id WHERE bm.user_id=u.id) AS mod_boards
       FROM users u ORDER BY u.created_at DESC`
    )
    .all();
  const boards = db.prepare('SELECT * FROM boards ORDER BY sort_order').all();
  const restrictions = db
    .prepare(
      `SELECT r.*, u.username, b.name AS board_name FROM restrictions r
       JOIN users u ON u.id=r.user_id LEFT JOIN boards b ON b.id=r.board_id
       WHERE r.until IS NULL OR r.until > ? ORDER BY r.created_at DESC`
    )
    .all(now());
  res.render('admin/users', { title: '用户管理', users, boards, restrictions });
});

app.post('/admin/users/:id/approve', adminOnly, (req, res) => {
  db.prepare("UPDATE users SET status='active' WHERE id=?").run(req.params.id);
  notify(parseInt(req.params.id, 10), '你的账号已通过审核，现在可以发帖回帖了！', '/');
  res.redirect('/admin/users');
});

app.post('/admin/users/:id/reject', adminOnly, (req, res) => {
  db.prepare("UPDATE users SET status='rejected' WHERE id=?").run(req.params.id);
  res.redirect('/admin/users');
});

app.post('/admin/users/:id/promote', adminOnly, (req, res) => {
  const { board_id } = req.body;
  const uid = parseInt(req.params.id, 10);
  const bid = parseInt(board_id, 10);
  try {
    db.prepare('INSERT OR IGNORE INTO board_moderators (board_id, user_id) VALUES (?, ?)').run(bid, uid);
    notify(uid, '你已被任命为版主', '/');
  } catch (e) {}
  res.redirect('/admin/users');
});

app.post('/admin/users/:id/demote', adminOnly, (req, res) => {
  const { board_id } = req.body;
  db.prepare('DELETE FROM board_moderators WHERE board_id=? AND user_id=?').run(
    parseInt(board_id, 10),
    parseInt(req.params.id, 10)
  );
  res.redirect('/admin/users');
});

app.get('/admin/audit', adminOnly, (req, res) => {
  const wall = db
    .prepare(
      `SELECT w.*, u.username FROM wall_messages w JOIN users u ON u.id=w.user_id
       WHERE w.status='pending' ORDER BY w.created_at ASC`
    )
    .all();
  const bottles = db
    .prepare(
      `SELECT b.*, u.username FROM bottles b JOIN users u ON u.id=b.user_id
       WHERE b.status='pending' ORDER BY b.created_at ASC`
    )
    .all();
  const bottleReplies = db
    .prepare(
      `SELECT br.*, u.username, b.content AS bottle_content FROM bottle_replies br
       JOIN users u ON u.id=br.user_id JOIN bottles b ON b.id=br.bottle_id
       WHERE br.status='pending' ORDER BY br.created_at ASC`
    )
    .all();
  res.render('admin/audit', { title: '内容审核', wall, bottles, bottleReplies });
});

app.post('/admin/audit/wall/:id/:action', adminOnly, (req, res) => {
  const action = req.params.action;
  const id = parseInt(req.params.id, 10);
  const msg = db.prepare('SELECT * FROM wall_messages WHERE id=?').get(id);
  if (!msg) return res.redirect('/admin/audit');
  if (action === 'approve') {
    db.prepare("UPDATE wall_messages SET status='approved' WHERE id=?").run(id);
    notify(msg.user_id, '你的留言墙留言已通过审核', '/wall');
  } else if (action === 'reject') {
    db.prepare("DELETE FROM wall_messages WHERE id=?").run(id);
    notify(msg.user_id, '你的留言墙留言未通过审核', '/wall');
  }
  res.redirect('/admin/audit');
});

app.post('/admin/audit/bottle/:id/:action', adminOnly, (req, res) => {
  const action = req.params.action;
  const id = parseInt(req.params.id, 10);
  const b = db.prepare('SELECT * FROM bottles WHERE id=?').get(id);
  if (!b) return res.redirect('/admin/audit');
  if (action === 'approve') {
    db.prepare("UPDATE bottles SET status='in_pool' WHERE id=?").run(id);
    notify(b.user_id, '你的漂流瓶已通过审核，已投入大海', '/bottle');
  } else if (action === 'reject') {
    db.prepare('DELETE FROM bottles WHERE id=?').run(id);
    notify(b.user_id, '你的漂流瓶未通过审核', '/bottle');
  }
  res.redirect('/admin/audit');
});

app.post('/admin/audit/bottle-reply/:id/:action', adminOnly, (req, res) => {
  const action = req.params.action;
  const id = parseInt(req.params.id, 10);
  const r = db.prepare('SELECT * FROM bottle_replies WHERE id=?').get(id);
  if (!r) return res.redirect('/admin/audit');
  if (action === 'approve') {
    db.prepare("UPDATE bottle_replies SET status='approved' WHERE id=?").run(id);
    const bottle = db.prepare('SELECT * FROM bottles WHERE id=?').get(r.bottle_id);
    const other = bottle.user_id === r.user_id ? bottle.taken_by : bottle.user_id;
    notify(other, '你的漂流瓶收到了新回复', '/bottle/' + r.bottle_id);
  } else if (action === 'reject') {
    db.prepare('DELETE FROM bottle_replies WHERE id=?').run(id);
  }
  res.redirect('/admin/audit');
});

app.get('/admin/reports', adminOnly, (req, res) => {
  const reports = db
    .prepare(
      `SELECT rp.*, u.username AS reporter_name FROM reports rp
       JOIN users u ON u.id=rp.reporter_id ORDER BY rp.created_at DESC LIMIT 200`
    )
    .all();
  // 加载被举报对象内容
  const enriched = reports.map((r) => {
    let target = null;
    if (r.target_type === 'post') target = db.prepare('SELECT title AS t, content AS c, id FROM posts WHERE id=?').get(r.target_id);
    if (r.target_type === 'reply') target = db.prepare('SELECT content AS c, id FROM replies WHERE id=?').get(r.target_id);
    if (r.target_type === 'wall') target = db.prepare('SELECT content AS c, id FROM wall_messages WHERE id=?').get(r.target_id);
    if (r.target_type === 'bottle') target = db.prepare('SELECT content AS c, id FROM bottles WHERE id=?').get(r.target_id);
    return { ...r, target };
  });
  res.render('admin/reports', { title: '举报处理', reports: enriched });
});

app.post('/admin/reports/:id/handle', adminOnly, (req, res) => {
  db.prepare("UPDATE reports SET status='handled' WHERE id=?").run(parseInt(req.params.id, 10));
  res.redirect('/admin/reports');
});

app.get('/admin/boards', adminOnly, (req, res) => {
  const boards = db.prepare('SELECT * FROM boards ORDER BY sort_order').all();
  const mods = db
    .prepare(
      `SELECT bm.board_id, u.id, u.username, u.avatar_color FROM board_moderators bm
       JOIN users u ON u.id=bm.user_id`
    )
    .all();
  const modMap = {};
  mods.forEach((m) => {
    if (!modMap[m.board_id]) modMap[m.board_id] = [];
    modMap[m.board_id].push(m);
  });
  const activeUsers = db
    .prepare("SELECT id, username FROM users WHERE status='active' AND role!='admin' ORDER BY username")
    .all();
  res.render('admin/boards', { title: '板块与版主', boards, modMap, activeUsers });
});

app.post('/admin/boards/:id/promote', adminOnly, (req, res) => {
  const bid = parseInt(req.params.id, 10);
  const uid = parseInt(req.body.user_id, 10);
  try {
    db.prepare('INSERT OR IGNORE INTO board_moderators (board_id, user_id) VALUES (?, ?)').run(bid, uid);
    notify(uid, '你已被任命为版主', '/');
  } catch (e) {}
  res.redirect('/admin/boards');
});

app.post('/admin/boards/:id/demote', adminOnly, (req, res) => {
  const bid = parseInt(req.params.id, 10);
  const uid = parseInt(req.body.user_id, 10);
  db.prepare('DELETE FROM board_moderators WHERE board_id=? AND user_id=?').run(bid, uid);
  res.redirect('/admin/boards');
});

/* =====================================================
   错误页
===================================================== */
app.use((req, res) => {
  res.status(404).render('404', { title: '页面不存在' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('服务器错误：' + err.message);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`校园论坛已启动： http://localhost:${PORT}`);
  console.log('默认管理员：admin / admin123');
});