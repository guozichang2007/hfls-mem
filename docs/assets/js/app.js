/* =========================================================
   海弗拉斯26届回忆录 · 前端应用
   纯静态：种子数据来自 data/posts.json，
   发帖/评论默认存本地；配置 GitHub 仓库后走 Issues API。
   ========================================================= */
(function () {
  'use strict';

  var SEED_URL = 'data/posts.json';
  var CONFIG_URL = 'data/config.json';
  // GitHub Action 烘焙出来的公共帖：同源静态文件，墙内也能读
  var GH_BAKED_URL = 'data/gh-posts.json';

  var GH_RETRIES = 2;          // 直连 API 失败重试次数
  var GH_RETRY_DELAY = 1200;   // 重试间隔（ms）
  var GH_CACHE_LIMIT = 500000; // localStorage 缓存上限（字符）

  var KEYS = {
    posts: 'hfls.posts.v1',
    comments: 'hfls.comments.v1',
    likes: 'hfls.likes.v1',
    profile: 'hfls.profile.v1',
    token: 'hfls.token.v1',
    repo: 'hfls.repo.v1',
    theme: 'hfls.theme.v1',
    seen: 'hfls.seen.v1',
    lastVisit: 'hfls.lastvisit.v1',
    pending: 'hfls.pending.v1',
    ghCache: 'hfls.ghcache.v1'
  };

  var DEFAULT_CONFIG = {
    repo: '',
    branch: 'main',
    postsLabel: 'post',
    sectionLabelPrefix: 'sec-',
    siteUrl: '',
    notice: ''
  };

  var state = {
    config: Object.assign({}, DEFAULT_CONFIG),
    seed: null,
    sections: [],
    posts: [],
    byId: {},
    localPosts: [],
    ghPosts: [],
    pendingPosts: [],
    localComments: {},
    likes: {},
    profile: { name: '' },
    token: '',
    repoOverride: '',
    configFileRepo: '',
    gh: { enabled: false, loading: false, error: '', loaded: false, broken: false, source: '', syncedAt: '' },
    route: { name: 'home', section: '', id: '', q: '' },
    seen: {},
    lastVisit: 0,
    limit: 20,
    silent: false
  };

  var pendingImages = [];
  var lastPendingId = '';

  /* ------------------------------------------------------- 小工具 */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function linkify(escaped) {
    return escaped.replace(/(https?:\/\/[^\s<）)】。，]+)/g, function (url) {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
    });
  }

  function richText(text) {
    return linkify(esc(text)).replace(/\n/g, '<br>');
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function timeAgo(iso) {
    var t = new Date(iso).getTime();
    if (!t) return '';
    var diff = Date.now() - t;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 2592000000) return Math.floor(diff / 86400000) + ' 天前';
    return fmtDate(iso).slice(0, 10);
  }

  var PALETTE = ['#c2445b', '#5b7f95', '#7d6b9e', '#b9803c', '#4f8a72', '#9a5b6b'];

  function avatarOf(name, origin) {
    var n = String(name || '?').trim();
    var chars = Array.from(n);
    var ch = chars.length ? chars[0] : '?';
    var sum = 0;
    for (var i = 0; i < n.length; i++) sum += n.charCodeAt(i);
    var color = PALETTE[sum % PALETTE.length];
    return '<span class="avatar' + (origin === 'docx' ? ' ghost' : '') +
      '" style="background:' + (origin === 'docx' ? 'transparent' : color) + '">' + esc(ch) + '</span>';
  }

  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('show'); }, 3000);
  }

  /* ------------------------------------------------------- 存储 */
  function lsGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { toast('本地存储写入失败（可能空间不足）'); return false; }
  }

  function loadLocal() {
    state.localPosts = lsGet(KEYS.posts, []) || [];
    state.pendingPosts = lsGet(KEYS.pending, []) || [];
    state.localComments = lsGet(KEYS.comments, {}) || {};
    state.likes = lsGet(KEYS.likes, {}) || {};
    state.profile = lsGet(KEYS.profile, { name: '' }) || { name: '' };
    state.seen = lsGet(KEYS.seen, {}) || {};
    var last = lsGet(KEYS.lastVisit, 0);
    state.lastVisit = typeof last === 'number' ? last : 0;
    try {
      state.token = localStorage.getItem(KEYS.token) || '';
      state.repoOverride = localStorage.getItem(KEYS.repo) || '';
    } catch (e) { state.token = ''; state.repoOverride = ''; }
  }

  function saveLocalPosts() { return lsSet(KEYS.posts, state.localPosts.slice(0, 400)); }
  function savePending() { return lsSet(KEYS.pending, state.pendingPosts.slice(0, 40)); }
  function saveLocalComments() { return lsSet(KEYS.comments, state.localComments); }
  function saveLikes() { return lsSet(KEYS.likes, state.likes); }

  // 极简 markdown：够用于 GitHub issue 正文（加粗/斜体/代码/链接/图片/引用/列表）
  function markdown(src) {
    var lines = String(src || '').split(/\r?\n/);
    var out = [];
    var inList = false;
    var inCode = false;

    function closeList() { if (inList) { out.push('</ul>'); inList = false; } }
    function inline(text) {
      var s = esc(text);
      s = s.replace(/`([^`]+)`/g, '<span class="md-code">$1</span>');
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
      return linkify(s);
    }

    lines.forEach(function (line) {
      if (/^```/.test(line)) {
        if (inCode) { out.push('</code></pre>'); inCode = false; }
        else { closeList(); out.push('<pre><code>'); inCode = true; }
        return;
      }
      if (inCode) { out.push(esc(line)); return; }
      if (!line.trim()) { closeList(); return; }

      var img = line.match(/^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)\s*$/);
      if (img) {
        closeList();
        out.push('<a href="' + esc(img[2]) + '" target="_blank" rel="noopener noreferrer">' +
          '<img src="' + esc(img[2]) + '" alt="' + esc(img[1]) + '" loading="lazy"></a>');
        return;
      }
      if (/^>\s?/.test(line)) {
        closeList();
        out.push('<blockquote>' + inline(line.replace(/^>\s?/, '')) + '</blockquote>');
        return;
      }
      if (/^[-*+]\s+/.test(line)) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + inline(line.replace(/^[-*+]\s+/, '')) + '</li>');
        return;
      }
      if (/^#{1,4}\s+/.test(line)) {
        closeList();
        out.push('<h3>' + inline(line.replace(/^#{1,4}\s+/, '')) + '</h3>');
        return;
      }
      closeList();
      out.push('<p>' + inline(line) + '</p>');
    });
    closeList();
    if (inCode) out.push('</code></pre>');
    return out.join('');
  }

  /* ------------------------------------------------------- GitHub */
  function hasRepo() {
    return !!(state.config.repo && /^[\w.-]+\/[\w.-]+$/.test(state.config.repo));
  }

  function ghEnabled() {
    if (state.gh.broken) return false;
    return hasRepo();
  }

  function ghHeaders() {
    var h = { 'Accept': 'application/vnd.github+json' };
    if (state.token) h.Authorization = 'Bearer ' + state.token;
    return h;
  }

  function ghGet(url) {
    return fetch(url, { headers: ghHeaders() }).then(function (res) {
      if (res.ok) return res.json();
      return res.json().catch(function () { return {}; }).then(function (body) {
        var msg = (body && body.message) || ('HTTP ' + res.status);
        if (res.status === 401) msg = 'GitHub 令牌无效或已过期';
        if (res.status === 403 || res.status === 429) msg = 'GitHub 接口限流或权限不足：' + msg;
        if (res.status === 404) msg = '找不到仓库（请检查 data/config.json 里的 repo）';
        throw new Error(msg);
      });
    });
  }

  function ghSend(method, url, payload) {
    return fetch(url, {
      method: method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (res.ok) return body;
        var msg = (body && body.message) || ('HTTP ' + res.status);
        if (res.status === 401) msg = 'GitHub 令牌无效或已过期';
        if (res.status === 404) msg = '找不到仓库或无权限（检查仓库名与令牌权限）';
        if (res.status === 403) msg = '没有写入权限（令牌需要 Issues: Read and write）';
        throw new Error(msg);
      });
    });
  }

  var META_RE = /<!--\s*hfls:(\{[\s\S]*?\})\s*-->/;

  function splitMeta(body) {
    var text = String(body || '');
    var meta = {};
    var m = text.match(META_RE);
    if (m) {
      try { meta = JSON.parse(m[1]) || {}; } catch (e) { meta = {}; }
      text = text.replace(META_RE, '');
    }
    return { meta: meta, text: text.trim() };
  }

  function sectionFromLabels(labels) {
    var prefix = state.config.sectionLabelPrefix || 'sec-';
    var found = '';
    (labels || []).forEach(function (l) {
      var name = typeof l === 'string' ? l : l.name;
      if (name && name.indexOf(prefix) === 0) found = name.slice(prefix.length);
    });
    return found;
  }

  // markdown 图片 + GitHub 拖图时插入的 <img width="…" src="…">，一次遍历保证顺序
  var IMG_ANY_RE = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)|<img\b[^>]*\bsrc=["'](https?:\/\/[^"']+)["']/gi;
  // base64 图（data:）在公共帖里既传不上去也没法显示，丢掉，别把正文撑爆
  var DATA_IMG_RE = /!\[[^\]]*\]\(\s*data:[^)\s]*\)|<img\b[^>]*\bsrc=["']data:[^"']*["'][^>]*>/gi;

  function extractImages(text) {
    var images = [];
    var clean = String(text || '').replace(DATA_IMG_RE, '').replace(IMG_ANY_RE, function (all, md, html) {
      var src = md || html || '';
      if (src && !images.some(function (im) { return im.src === src; })) {
        images.push({ src: src, thumb: src, w: 0, h: 0, remote: true });
      }
      return '';
    });
    return { text: clean.replace(/\n{3,}/g, '\n\n').trim(), images: images };
  }

  function mapIssue(issue) {
    var parts = splitMeta(issue.body || '');
    var picked = extractImages(parts.text);
    var sec = parts.meta.section && state.sections.some(function (s) { return s.id === parts.meta.section; })
      ? parts.meta.section
      : sectionFromLabels(issue.labels || []);
    if (!state.sections.some(function (s) { return s.id === sec; })) sec = 'classmate';
    return {
      id: 'gh-' + issue.number,
      origin: 'github',
      section: sec,
      author: parts.meta.name || (issue.user && issue.user.login) || '同学',
      login: issue.user && issue.user.login,
      createdAt: issue.created_at,
      text: picked.text,
      title: issue.title || '',
      images: picked.images,
      audio: [],
      comments: [],
      commentCount: issue.comments || 0,
      likeCount: (issue.reactions && issue.reactions.total_count) || 0,
      url: issue.html_url,
      number: issue.number
    };
  }

  /* -------- 公共帖读取：烘焙文件 → 直连 API → localStorage 缓存 -------- */

  function ghApiBase() {
    return 'https://api.github.com/repos/' + state.config.repo;
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // 网络抖动时重试，仍然失败才抛出（墙内直连 GitHub 失败是常态）
  function ghGetRetry(url, tries) {
    var left = typeof tries === 'number' ? tries : GH_RETRIES;
    return ghGet(url).catch(function (err) {
      if (left <= 1) throw err;
      return delay(GH_RETRY_DELAY).then(function () { return ghGetRetry(url, left - 1); });
    });
  }

  function ghIssuePages(page, acc) {
    var p = page || 1;
    var all = acc || [];
    return ghGetRetry(ghApiBase() + '/issues?state=all&per_page=100&page=' + p)
      .then(function (list) {
        var raw = list || [];
        raw.forEach(function (issue) { if (!issue.pull_request) all.push(issue); });
        if (raw.length >= 100 && p < 5) return ghIssuePages(p + 1, all);
        return all;
      });
  }

  function normalizeSection(id) {
    if (id && state.sections.some(function (s) { return s.id === id; })) return id;
    if (state.sections.some(function (s) { return s.id === 'classmate'; })) return 'classmate';
    return (state.sections[0] && state.sections[0].id) || 'classmate';
  }

  // 把烘焙 JSON / 直连 API 的结果统一成站点内部结构
  function normalizeGhPost(raw) {
    var bakedComments = (raw && raw.comments) || [];
    var post = {
      id: 'gh-' + (raw.number || String(raw.id || '').replace(/^gh-/, '')),
      origin: 'github',
      section: normalizeSection(raw.section),
      author: raw.author || raw.login || '同学',
      login: raw.login || '',
      createdAt: raw.createdAt,
      title: raw.title || '',
      text: raw.text || '',
      images: raw.images || [],
      audio: [],
      comments: [],
      commentCount: raw.commentCount || 0,
      likeCount: raw.likeCount || 0,
      url: raw.url || '',
      number: raw.number
    };
    if (raw.id) post.id = String(raw.id).indexOf('gh-') === 0 ? String(raw.id) : post.id;
    if (!post.number) post.number = Number(String(post.id).replace(/^gh-/, '')) || 0;
    if (raw.ghComments) post.ghComments = raw.ghComments;
    // 烘焙的评论为空时别占位：留空才会去直连 API 补最新评论
    else if (bakedComments.length) post.ghComments = bakedComments.slice();
    return post;
  }

  function applyGhPosts(list, source, syncedAt) {
    var prev = {};
    state.ghPosts.forEach(function (p) { prev[p.id] = p; });
    var posts = (list || []).map(normalizeGhPost).filter(function (p) { return p.number > 0; });
    posts.forEach(function (p) {
      var old = prev[p.id];
      // 直连拿到的评论比烘焙的新，别被覆盖
      if (old && old.ghComments && old.ghComments.length &&
        (!p.ghComments || p.ghComments.length < old.ghComments.length)) {
        p.ghComments = old.ghComments;
        p.commentCount = Math.max(p.commentCount || 0, old.ghComments.length);
      }
    });
    state.ghPosts = posts;
    state.gh.source = source;
    state.gh.syncedAt = syncedAt || '';
    state.gh.loaded = true;
    if (posts.length) { state.gh.broken = false; state.gh.error = ''; }
    dropSyncedPending();
  }

  function readGhCache() {
    try {
      var raw = localStorage.getItem(KEYS.ghCache);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.posts) || !data.posts.length) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  function writeGhCache() {
    try {
      var slim = state.ghPosts.slice(0, 200).map(function (p) {
        return {
          id: p.id, number: p.number, section: p.section, author: p.author, login: p.login,
          createdAt: p.createdAt, title: p.title, text: String(p.text || '').slice(0, 4000),
          images: (p.images || []).slice(0, 9), likeCount: p.likeCount,
          commentCount: p.commentCount, url: p.url,
          comments: (p.ghComments || []).slice(0, 30)
        };
      });
      var payload = JSON.stringify({ syncedAt: state.gh.syncedAt, posts: slim });
      if (payload.length > GH_CACHE_LIMIT) return;
      localStorage.setItem(KEYS.ghCache, payload);
    } catch (e) { /* 配额满了就算了 */ }
  }

  function loadBakedPosts() {
    return fetch(GH_BAKED_URL, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (!data || !Array.isArray(data.posts)) throw new Error('格式不对');
      return data;
    }).catch(function () {
      return null;  // 还没部署烘焙文件 / 文件坏了：不算错误
    });
  }

  function loadGitHub() {
    if (!ghEnabled()) { state.gh.enabled = false; return Promise.resolve(); }
    state.gh.enabled = true;
    state.gh.loading = true;
    state.gh.error = '';
    renderStatus();

    return loadBakedPosts().then(function (data) {
      if (data) {
        applyGhPosts(data.posts, 'baked', data.generatedAt || '');
      } else if (!state.ghPosts.length) {
        var cached = readGhCache();
        if (cached) applyGhPosts(cached.posts, 'cache', cached.syncedAt || '');
      }
      rebuildIndex();
      if (state.ghPosts.length) render();

      // 再试一次直连（有令牌时能立刻看到自己刚发的帖；网络不通就算了）
      return ghIssuePages().then(function (list) {
        applyGhPosts(list.map(mapIssue), 'live', new Date().toISOString());
        writeGhCache();
      }).catch(function (err) {
        if (!state.ghPosts.length) {
          state.gh.error = err.message || String(err);
          if (!state.token) state.gh.broken = true;
        }
      });
    }).then(function () {
      state.gh.loading = false;
      rebuildIndex();
      return state.ghPosts;
    });
  }

  function refreshGitHub() {
    state.gh.broken = false;
    state.gh.error = '';
    toast('正在重新读取公共帖…');
    return loadGitHub().then(function () {
      render();
      toast(state.ghPosts.length
        ? '公共帖已更新：' + state.ghPosts.length + ' 条'
        : '还是读不到公共帖，先看原文和本地内容吧');
    });
  }


  /* -------- 等同步的帖子（没令牌时先本地显示，同步完成后自动转正） -------- */

  function postSig(author, text) {
    return String(author || '').trim().toLowerCase() + '|' +
      String(text || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 200);
  }

  function addPendingPost(payload, title) {
    var post = {
      id: 'pend-' + Date.now().toString(36),
      origin: 'pending',
      section: normalizeSection(payload.section),
      author: payload.name || '匿名同学',
      createdAt: new Date().toISOString(),
      title: title || '',
      text: payload.text || '',
      images: payload.images || [],
      audio: [],
      comments: [],
      commentCount: 0,
      likeCount: 0
    };
    state.pendingPosts.unshift(post);
    savePending();
    return post;
  }

  // 烘焙/直连数据里出现了同一条帖子，就把「等同步」的那份撤掉，评论迁过去
  function dropSyncedPending() {
    if (!state.pendingPosts.length) return;
    var known = {};
    state.ghPosts.forEach(function (p) { known[postSig(p.author, p.text)] = p; });
    var keep = [];
    state.pendingPosts.forEach(function (pend) {
      var matched = known[postSig(pend.author, pend.text)];
      if (!matched) { keep.push(pend); return; }
      var mine = state.localComments[pend.id];
      if (mine && mine.length) {
        state.localComments[matched.id] = (state.localComments[matched.id] || []).concat(mine);
        delete state.localComments[pend.id];
        saveLocalComments();
      }
    });
    if (keep.length !== state.pendingPosts.length) {
      state.pendingPosts = keep;
      savePending();
    }
  }

  function ghComments(postId) {
    var num = String(postId).replace(/^gh-/, '');
    var url = ghApiBase() + '/issues/' + num + '/comments?per_page=100';
    return ghGetRetry(url).then(function (list) {
      return (list || []).map(function (c) {
        var parts = splitMeta(c.body || '');
        return {
          id: 'ghc-' + c.id,
          author: parts.meta.name || (c.user && c.user.login) || '同学',
          text: parts.text,
          createdAt: c.created_at,
          origin: 'github',
          url: c.html_url || '',
          replyTo: String(parts.meta.reply || '')
        };
      });
    });
  }

  /* ------------------------------------------------------- 索引 / 数据装配 */
  function rebuildIndex() {
    var seedPosts = (state.seed && state.seed.posts) || [];
    state.posts = state.ghPosts.concat(state.pendingPosts, state.localPosts, seedPosts);
    state.byId = {};
    state.posts.forEach(function (p) { state.byId[p.id] = p; });
    renderNav();
    renderStatus();
  }

  function sectionDef(id) {
    for (var i = 0; i < state.sections.length; i++) if (state.sections[i].id === id) return state.sections[i];
    return { id: 'classmate', name: '同学们', short: '同学', emoji: '🤝', desc: '' };
  }

  function countIn(sectionId) {
    var n = 0;
    state.posts.forEach(function (p) { if (p.section === sectionId) n++; });
    return n;
  }

  function freshIn(sectionId) {
    return state.posts.filter(function (p) {
      return p.origin !== 'docx' && (!sectionId || p.section === sectionId);
    }).sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
  }

  function archiveIn(sectionId) {
    return ((state.seed && state.seed.posts) || []).filter(function (p) {
      return !sectionId || p.section === sectionId;
    }).sort(function (a, b) { return (a.floor || 0) - (b.floor || 0); });
  }

  function myPosts() {
    // 「我的发帖」= 本机保存的 + 已提交 GitHub 还在等同步的
    return state.pendingPosts.concat(state.localPosts).sort(function (a, b) {
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
  }

  function localCommentsOf(post) {
    return (state.localComments[post.id] || []);
  }

  function allCommentsOf(post) {
    var seed = (post.origin === 'docx' && post.comments) ? post.comments : [];
    return seed.concat(localCommentsOf(post)).concat(post.ghComments || []);
  }

  function commentCountOf(post) {
    var seed = (post.origin === 'docx' && post.comments) ? post.comments.length : 0;
    var local = localCommentsOf(post).length;
    var gh = post.ghComments ? post.ghComments.length : 0;
    if (post.origin === 'github') return Math.max(post.commentCount || 0, gh);
    return seed + local + gh;
  }

  function likeCountOf(post) {
    return (post.origin === 'github' ? (post.likeCount || 0) : 0) + (state.likes[post.id] || 0);
  }

  function likedByMe(post) { return !!state.likes[post.id]; }

  function isSeen(post) {
    if (post.origin === 'docx') return true;
    return new Date(post.createdAt).getTime() <= (state.lastVisit || 0);
  }

  /* ------------------------------------------------------- 统计 */
  function stats() {
    var total = state.posts.length;
    var comments = 0;
    var images = 0;
    var audio = 0;
    state.posts.forEach(function (p) {
      comments += commentCountOf(p);
      images += (p.images || []).length;
      audio += (p.audio || []).length;
    });
    return { posts: total, comments: comments, images: images, audio: audio };
  }

  /* ------------------------------------------------------- 路由 */
  function parseRoute() {
    var raw = location.hash.replace(/^#\/?/, '');
    var qIdx = raw.indexOf('?');
    if (qIdx >= 0) raw = raw.slice(0, qIdx);
    var parts = raw.split('/').filter(Boolean).map(function (s) {
      try { return decodeURIComponent(s); } catch (e) { return s; }
    });
    if (!parts.length) return { name: 'home', section: '', id: '' };
    if (parts[0] === 's') return { name: 'section', section: parts[1] || '', id: '' };
    if (parts[0] === 'p') return { name: 'post', section: '', id: parts[1] || '' };
    if (parts[0] === 'search') return { name: 'search', section: '', id: '', q: parts.slice(1).join('/') };
    if (parts[0] === 'mine') return { name: 'mine', section: '', id: '' };
    if (parts[0] === 'about') return { name: 'about', section: '', id: '' };
    return { name: 'home', section: '', id: '' };
  }

  function navigate(hash, opts) {
    state.silent = !!(opts && opts.silent);
    if (location.hash === hash) { render(); return; }
    location.hash = hash;
  }

  /* ------------------------------------------------------- 导航 / 状态卡 */
  function renderNav() {
    var nav = $('#sectionNav');
    if (!nav) return;
    var active = state.route.name === 'section' ? state.route.section : '';
    var html = state.sections.map(function (s) {
      return '<a href="#/s/' + s.id + '" data-nav="' + s.id + '"' + (active === s.id ? ' class="active"' : '') + '>' +
        '<span class="emoji">' + s.emoji + '</span>' + esc(s.short || s.name) +
        '<span class="count">' + countIn(s.id) + '</span></a>';
    }).join('');
    nav.innerHTML = html;
    $$('.section-nav.small a').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-nav') === state.route.name);
    });
  }

  function renderStatus() {
    var box = $('#sidebarStatus');
    if (!box) return;
    var configured = hasRepo();
    var enabled = ghEnabled();
    var total = state.ghPosts.length;
    var mode = !configured
      ? '本地模式（只在这台设备可见）'
      : (state.gh.broken
        ? '公共墙暂时连不上（先按本地模式浏览）'
        : (state.token ? 'GitHub 共享模式（已连接令牌）' : 'GitHub 共享模式（未连接令牌）'));

    // 数据来自哪里：烘焙文件是常态（墙内也能读），直连成功时更新
    var srcLine = '';
    if (configured && total) {
      if (state.gh.source === 'live') {
        srcLine = '已直连 GitHub，共 ' + total + ' 条公共帖。';
      } else if (state.gh.source === 'cache') {
        srcLine = '暂时读不到公共帖，显示本机缓存（' + total + ' 条）。';
      } else {
        srcLine = '公共帖已同步，共 ' + total + ' 条' +
          (state.gh.syncedAt ? '（数据更新于 ' + timeAgo(state.gh.syncedAt) + '）' : '') + '。';
      }
    } else if (configured) {
      srcLine = state.gh.loading ? '正在读取公共帖…' : '还没读到公共帖。';
    }

    var extra = '';
    if (state.gh.error) {
      extra = '<br><span style="color:#b4692f">' +
        (state.token ? '接口提示：' + esc(state.gh.error)
          : '公共帖暂时读不到，先显示原文与本地内容，稍后刷新再试。') + '</span>';
    }
    var dotCls = enabled && !state.gh.error ? '' : ' warn';
    var retry = configured && (state.gh.error || !total)
      ? '<button class="btn sm" data-act="retry-gh">🔄 重试</button>' : '';

    box.innerHTML =
      '<p style="margin:0"><span class="dot' + dotCls + '"></span><b>' + esc(mode) + '</b></p>' +
      '<p style="margin:6px 0 0">' + (configured
        ? esc(srcLine) + ' 帖子与评论会写进 <b>' + esc(state.config.repo) + '</b> 的 Issues，所有人可见。'
        : '发帖和评论保存在本机浏览器里；想让所有人看见，请在“设置”里填 GitHub 仓库。') + extra + '</p>' +
      '<button class="btn sm" data-act="settings">⚙️ 设置 / 昵称</button>' + retry;
  }

  /* ------------------------------------------------------- 组件渲染 */
  function mediaBlock(post) {
    var imgs = post.images || [];
    if (!imgs.length) return '';
    var n = Math.min(imgs.length, 9);
    var cls = 'n' + (n === 1 ? 1 : (n === 2 || n === 4 ? n : 3));
    var items = imgs.slice(0, n).map(function (im, i) {
      var more = (i === n - 1 && imgs.length > n) ? '<span class="more-count">+' + (imgs.length - n) + '</span>' : '';
      return '<button class="media-item" data-act="lightbox" data-post="' + post.id + '" data-index="' + i + '" ' +
        'aria-label="查看第 ' + (i + 1) + ' 张图片">' +
        '<img src="' + esc(im.thumb || im.src) + '" data-full="' + esc(im.src) + '" alt="" loading="lazy" ' +
        (im.w && im.h ? 'width="' + im.w + '" height="' + im.h + '"' : '') + '>' + more + '</button>';
    }).join('');
    return '<div class="media"><div class="media-grid ' + cls + '">' + items + '</div></div>';
  }

  function audioBlock(post) {
    var audios = post.audio || [];
    if (!audios.length) return '';
    return audios.map(function (a) {
      return '<div class="audio-card"><span class="audio-icon">🎧</span>' +
        '<div class="audio-meta"><b>' + esc(a.title || '现场录音') + '</b><span>来自回忆录原文</span></div>' +
        '<audio controls preload="none" src="' + esc(a.src) + '"></audio></div>';
    }).join('');
  }

  function badgeOf(post) {
    if (post.origin === 'github') return '<span class="badge gh">GitHub</span>';
    if (post.origin === 'pending') return '<span class="badge local">同步中</span>';
    if (post.origin === 'local') return '<span class="badge local">本机</span>';
    return '';
  }

  function subLine(post) {
    var bits = [];
    if (post.floor) bits.push('第 ' + post.floor + ' 楼');
    if (post.origin === 'docx') bits.push(post.createdAt ? fmtDate(post.createdAt).slice(0, 10) : '回忆录原文');
    else if (post.origin === 'pending') bits.push(timeAgo(post.createdAt) + ' · 已提交 GitHub，等同步');
    else bits.push(timeAgo(post.createdAt));
    return bits.filter(Boolean).join(' · ');
  }

  // 评论正文：保留换行；`> 原文` 渲染成引用块（GitHub 的「Quote reply」就是这种写法）
  function commentHtml(text) {
    var lines = String(text || '').split(/\r?\n/);
    var segs = [];
    var buf = [];
    var quote = [];

    function flushText() {
      if (buf.length) { segs.push({ q: false, v: buf.join('<br>') }); buf = []; }
    }
    function flushQuote() {
      if (quote.length) { segs.push({ q: true, v: quote.join('<br>') }); quote = []; }
    }

    lines.forEach(function (line) {
      if (/^\s*>/.test(line)) {
        flushText();
        quote.push(linkify(esc(line.replace(/^\s*>\s?/, ''))));
        return;
      }
      flushQuote();
      buf.push(linkify(esc(line)));
    });
    flushText();
    flushQuote();

    return segs.map(function (s) {
      return s.q ? '<blockquote class="comment-quote">' + s.v + '</blockquote>' : s.v;
    }).join('<br>');
  }

  function commentDomId(id) { return 'c-' + String(id || '').replace(/[^\w-]/g, ''); }

  function commentItem(post, c, depth, canReply) {
    var id = String(c.id || '');
    var replyBtn = (canReply && id)
      ? '<button class="comment-reply" type="button" data-act="reply" data-cid="' + esc(id) +
        '" data-author="' + esc(c.author || '') + '">回复</button>'
      : '';
    var srcLink = c.url
      ? '<a class="comment-src" href="' + esc(c.url) + '" target="_blank" rel="noopener noreferrer">在 GitHub 看 ↗</a>'
      : '';
    return '<div class="comment' + (depth ? ' is-reply' : '') + '"' +
      (id ? ' id="' + esc(commentDomId(id)) + '"' : '') + '>' +
      avatarOf(c.author, c.origin === 'docx' ? 'docx' : '') +
      '<div class="comment-body"><div class="comment-meta"><b>' + esc(c.author) + '</b>' +
      (c.createdAt ? '<span>' + esc(timeAgo(c.createdAt)) + '</span>' : '<span>原文回复</span>') +
      srcLink + '</div>' +
      '<div class="comment-text">' + commentHtml(c.text) + '</div>' +
      (replyBtn ? '<div class="comment-foot">' + replyBtn + '</div>' : '') +
      '</div></div>';
  }

  function commentRows(post, comments, max) {
    // 卡片预览：直接取前几条，不做树（列表里没有回复框）
    if (typeof max === 'number') {
      var shown = comments.slice(0, max);
      return shown.map(function (c) { return commentItem(post, c, 0, false); }).join('') +
        (comments.length > shown.length
          ? '<button class="comments-more" data-act="detail" data-id="' + post.id + '">查看全部 ' + comments.length + ' 条评论 →</button>'
          : '');
    }

    // 详情页：按 replyTo 拼成楼中楼（最多缩进两级，再深就并到第二级）
    var byId = {};
    comments.forEach(function (c) { if (c.id) byId[c.id] = c; });
    var kids = {};
    var roots = [];
    comments.forEach(function (c) {
      var parent = c.replyTo ? byId[c.replyTo] : null;
      if (parent && parent !== c) {
        (kids[parent.id] = kids[parent.id] || []).push(c);
      } else {
        roots.push(c);
      }
    });

    var seen = {};
    function thread(c, depth) {
      if (c.id && seen[c.id]) return '';
      if (c.id) seen[c.id] = 1;
      var list = (c.id && kids[c.id]) || [];
      var inner = depth >= 2 ? '' : list.map(function (k) { return thread(k, depth + 1); }).join('');
      return '<div class="comment-thread">' + commentItem(post, c, depth, true) +
        (inner ? '<div class="comment-children">' + inner + '</div>' : '') +
        '</div>';
    }

    var html = roots.map(function (c) { return thread(c, 0); }).join('');
    // 兜底：父评论被删了、或者互相回复成环，剩下的直接画在末尾
    var orphans = comments.filter(function (c) { return !c.id || !seen[c.id]; });
    if (orphans.length) html += orphans.map(function (c) { return thread(c, 0); }).join('');
    return html;
  }

  function findComment(post, id) {
    if (!post || !id) return null;
    var list = allCommentsOf(post);
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    return null;
  }

  // 直连拿到的评论 ∪ 烘焙/本地已有的：按 id 去重，按时间排序
  function mergeComments(oldList, liveList) {
    var out = [];
    var byId = {};
    (liveList || []).forEach(function (c) {
      var key = c.id || ('k' + out.length);
      if (byId[key]) return;
      byId[key] = 1;
      out.push(c);
    });
    (oldList || []).forEach(function (c) {
      if (c.id && byId[c.id]) return;
      if (!c.id && out.some(function (o) { return o.text === c.text && o.author === c.author; })) return;
      if (c.id) byId[c.id] = 1;
      out.push(c);
    });
    out.sort(function (a, b) {
      return (new Date(a.createdAt || 0).getTime() || 0) - (new Date(b.createdAt || 0).getTime() || 0);
    });
    return out;
  }

  function bodyHtml(post) {
    if (post.origin === 'github') return markdown(post.text || '');
    return richText(post.text || '');
  }

  function postCard(post, opts) {
    opts = opts || {};
    var detail = !!opts.detail;
    var sec = sectionDef(post.section);
    var text = post.text || '';
    var canClamp = !detail && text.length > 320;
    var comments = allCommentsOf(post);
    // 详情页的评论由下面的 comments-box 统一渲染，卡片里不再重复一遍
    var preview = detail ? [] : comments.slice(0, 2);
    var titleHtml = post.title && post.title !== text.trim()
      ? '<h2 class="post-title">' + esc(post.title) + '</h2>' : '';

    return '<article class="post' + (isSeen(post) ? '' : ' is-new') + '" id="post-' + esc(post.id) + '" data-post="' + esc(post.id) + '">' +
      '<div class="post-head">' + avatarOf(post.author, post.origin) +
      '<div class="post-who"><div class="name">' + esc(post.author) + badgeOf(post) + '</div>' +
      '<div class="sub">' + esc(subLine(post)) + (post.group ? ' · ' + esc(post.group) : '') + '</div></div>' +
      '<div class="post-section-tag"><a href="#/s/' + post.section + '">' + sec.emoji + ' ' + esc(sec.short || sec.name) + '</a></div>' +
      '</div>' +
      titleHtml +
      '<div class="post-text' + (canClamp ? ' clamp' : '') + '">' + bodyHtml(post) + '</div>' +
      (canClamp ? '<button class="post-more" data-act="detail" data-id="' + post.id + '">展开全文</button>' : '') +
      mediaBlock(post) + audioBlock(post) +
      (preview.length ? '<div class="comments">' + commentRows(post, preview) + '</div>' : '') +
      '<div class="post-foot">' +
        '<button class="act' + (likedByMe(post) ? ' liked' : '') + '" data-act="like" data-id="' + esc(post.id) + '">' +
          '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.35-7-9a4 4 0 0 1 7-2.65A4 4 0 0 1 19 11c0 4.65-7 9-7 9z"/></svg>' +
          '<span data-like-count>' + likeCountOf(post) + '</span></button>' +
        '<button class="act" data-act="detail" data-id="' + esc(post.id) + '">' +
          '<svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.5 9.5 0 0 1-3.7-.8L4 20l1-3.6A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/></svg>' +
          commentCountOf(post) + '</button>' +
        (detail ? '' : '<button class="act" data-act="copy" data-id="' + esc(post.id) + '">' +
          '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>分享</button>') +
        (post.origin === 'github' && post.url
          ? '<a class="act push" href="' + esc(post.url) + '" target="_blank" rel="noopener noreferrer">在 GitHub 查看 ↗</a>'
          : '') +
      '</div></article>';
  }

  function postDetail(post) {
    var html = postCard(post, { detail: true });
    var comments = allCommentsOf(post);
    var canFetch = post.origin === 'github' && ghEnabled();
    // 只有「一条都没有 + 还没试过拉取」才显示骨架屏；有烘焙评论就先渲染出来
    var needFetch = canFetch && !comments.length && !post.ghFetchTried;
    var head = (comments.length || canFetch)
      ? '<div class="comments-head"><span>评论' + (comments.length ? ' · ' + comments.length : '') + '</span>' +
        (canFetch
          ? '<button class="comments-refresh" type="button" data-act="refresh-comments" data-id="' +
            esc(post.id) + '">🔄 刷新</button>'
          : '') +
        '</div>'
      : '';
    html += '<section class="comments-box" id="comments-' + esc(post.id) + '">' +
      head +
      '<div class="comments" style="border-top:0;padding-top:0">' +
      (needFetch
        ? '<div class="loading" style="padding:30px 0"><div class="spinner"></div><p>正在读取评论…</p></div>'
        : (comments.length
          ? commentRows(post, comments)
          : '<p class="comments-empty">还没有评论，来说第一句吧。</p>')) +
      '</div>' +
      commentForm(post) +
      '</section>';
    return html;
  }

  function commentForm(post) {
    var modeTip = post.origin === 'github'
      ? (state.token ? '评论会直接发到该 GitHub Issue。' : '未连接令牌：发送时会复制内容并打开 GitHub 页面，登录后粘贴即可。')
      : (post.origin === 'pending'
        ? '这条还在等同步：评论先存在本机，同步完成后会一起并到 GitHub 那条下面。'
        : '评论保存在本机浏览器（会立刻显示，但别人看不到）。');
    return '<form class="comment-form" data-form="comment" data-id="' + esc(post.id) + '" data-reply="">' +
      '<div class="reply-bar" hidden><span>正在回复 <b class="reply-who"></b></span>' +
      '<button class="reply-cancel" type="button" data-act="reply-cancel">取消</button></div>' +
      '<textarea name="text" rows="1" placeholder="说点什么…（Ctrl / ⌘ + Enter 发送）" aria-label="评论内容"></textarea>' +
      '<button class="btn sm solid" type="submit">评论</button>' +
      '<p class="comments-note" style="flex-basis:100%">' + esc(modeTip) + '</p>' +
      '</form>';
  }

  // 点「回复」：把表单切到回复态（不重渲染，避免丢掉已经打了一半的字）
  function startReply(commentId, author) {
    var form = $('form[data-form="comment"]');
    if (!form) return;
    form.setAttribute('data-reply', commentId || '');
    var bar = form.querySelector('.reply-bar');
    if (bar) {
      bar.hidden = !commentId;
      var who = bar.querySelector('.reply-who');
      if (who) who.textContent = '@' + (author || '');
    }
    var ta = form.querySelector('textarea');
    if (ta) {
      ta.focus();
      if (ta.scrollIntoView) ta.scrollIntoView({ block: 'nearest' });
    }
  }



  /* ------------------------------------------------------- 页面 */
  function heroHtml() {
    var s = stats();
    var notice = state.config.notice
      ? '<div class="callout" style="margin-top:18px">' + richText(state.config.notice) + '</div>' : '';
    return '<section class="hero">' +
      '<span class="hero-eyebrow">🌱 杭州外国语学校 · 2026 届</span>' +
      '<h1>海弗拉斯26届回忆录<br><span style="color:var(--accent-ink)">hw 也有回忆录 😋</span></h1>' +
      '<p class="lede">' + esc((state.seed && state.seed.site && state.seed.site.tagline) || '') +
      ' 原文 8 个板块已经搬上来，故事还在继续——想补一句的、想吐槽的、想表白的，都可以往下写。</p>' +
      notice +
      '<div class="hero-stats">' +
        '<div class="stat"><b>' + s.posts + '</b><span>帖子</span></div>' +
        '<div class="stat"><b>' + s.comments + '</b><span>评论</span></div>' +
        '<div class="stat"><b>' + s.images + '</b><span>图片</span></div>' +
        '<div class="stat"><b>' + s.audio + '</b><span>录音</span></div>' +
      '</div>' +
      '<div class="hero-actions">' +
        '<button class="btn solid" data-act="compose">✍️ 写一条回忆</button>' +
        '<a class="btn" href="#/s/story">📖 从「忆事」读起</a>' +
        '<button class="btn ghost" data-act="settings">发帖设置</button>' +
      '</div></section>';
  }

  function sectionGridHtml() {
    return '<div class="section-grid">' + state.sections.map(function (sec) {
      return '<a class="section-card" href="#/s/' + sec.id + '">' +
        '<span class="sc-top"><span class="sc-emoji">' + sec.emoji + '</span>' + esc(sec.short || sec.name) +
        '<span class="sc-count">' + countIn(sec.id) + ' 帖</span></span>' +
        '<p>' + esc(sec.desc || '') + '</p></a>';
    }).join('') + '</div>';
  }

  function blockTitle(text, extra) {
    return '<h2 class="block-title"><span>' + esc(text) + '</span><span class="line"></span>' +
      (extra ? '<span style="letter-spacing:0;text-transform:none;font-weight:500;color:var(--ink-3)">' +
        esc(extra) + '</span>' : '') + '</h2>';
  }

  function feedHtml(posts) {
    if (!posts.length) return '';
    return '<div class="feed">' + posts.map(function (p) { return postCard(p); }).join('') + '</div>';
  }

  function emptyHtml(icon, title, sub, actionHtml) {
    return '<div class="empty"><div class="big">' + icon + '</div><p><b>' + esc(title) + '</b></p>' +
      (sub ? '<p>' + esc(sub) + '</p>' : '') + (actionHtml || '') + '</div>';
  }

  function moreHtml(shown, total, kind) {
    if (shown >= total) return '';
    return '<button class="btn-block" data-act="more" data-kind="' + kind + '">加载更多 · 还有 ' +
      (total - shown) + ' 帖</button>';
  }

  function viewHome() {
    var fresh = freshIn('');
    var archive = archiveIn('').slice().sort(function (a, b) { return (b.floor || 0) - (a.floor || 0); });
    var shownArchive = archive.slice(0, state.limit);
    var html = heroHtml() + blockTitle('八个板块') + sectionGridHtml();

    html += blockTitle('新帖', fresh.length ? fresh.length + ' 条' : '等你来写');
    html += fresh.length
      ? feedHtml(fresh.slice(0, 8))
      : emptyHtml('🖊️', '还没有人发新帖', '原文是 2026 届的回忆，这里留给你们续写。',
        '<p style="margin-top:12px"><button class="btn solid" data-act="compose">写第一条</button></p>');

    html += blockTitle('回忆录原文', archive.length + ' 楼 · 按楼层倒序');
    html += feedHtml(shownArchive);
    html += moreHtml(shownArchive.length, archive.length, 'home');
    return html;
  }


  function viewSection(id) {
    var sec = sectionDef(id);
    if (!state.sections.some(function (s) { return s.id === id; })) return notFoundHtml();
    var fresh = freshIn(id);
    var archive = archiveIn(id);
    var shown = archive.slice(0, state.limit);

    var html = '<section class="section-head">' +
      '<p class="crumb"><a href="#/">全部帖子</a> / ' + esc(sec.short || sec.name) + '</p>' +
      '<h1><span class="sc-emoji">' + sec.emoji + '</span>' + esc(sec.name) + '</h1>' +
      '<p>' + esc(sec.desc || '') + '</p>' +
      '<div class="meta"><span>' + countIn(id) + ' 帖</span><span>' + archive.length + ' 楼原文</span>' +
      (fresh.length ? '<span>' + fresh.length + ' 条新帖</span>' : '') + '</div></section>';

    html += '<button class="btn-block" data-act="compose" data-section="' + sec.id + '">✍️ 在这里发一条 · ' +
      esc(sec.short || sec.name) + '</button>';
    if (fresh.length) html += blockTitle('新帖') + feedHtml(fresh);
    if (archive.length) {
      html += blockTitle('原文楼层');
      var lastGroup = null;
      html += '<div class="feed">';
      shown.forEach(function (p) {
        if (p.group && p.group !== lastGroup) html += '<h3 class="group-title">' + esc(p.group) + '</h3>';
        lastGroup = p.group || lastGroup;
        html += postCard(p);
      });
      html += '</div>';
      html += moreHtml(shown.length, archive.length, 'section');
    } else if (!fresh.length) {
      html += emptyHtml('🌱', '这个板块还空着', '原文里没有收录，但你可以写下第一句。');
    }
    return html;
  }

  function viewPost(id) {
    var post = state.byId[id];
    if (!post) return notFoundHtml();
    var sec = sectionDef(post.section);
    return '<p class="crumb" style="font-size:12.5px;color:var(--ink-3);margin:0 0 14px">' +
      '<a href="#/">全部帖子</a> / <a href="#/s/' + post.section + '">' + esc(sec.short) + '</a> / 单条</p>' +
      postDetail(post);
  }

  function viewMine() {
    var mine = myPosts();
    var name = state.profile.name || '（还没设置昵称）';
    var commentThreads = Object.keys(state.localComments).filter(function (k) {
      return (state.localComments[k] || []).length;
    }).length;
    var html = '<section class="section-head"><p class="crumb"><a href="#/">全部帖子</a> / 我的发帖</p>' +
      '<h1><span class="sc-emoji">🖊️</span>我的发帖</h1>' +
      '<p>这台浏览器里保存的帖子与评论。它们只存在本机，换设备或清缓存会消失。' +
      (state.pendingPosts.length
        ? '<br>其中 <b>' + state.pendingPosts.length + '</b> 条已提交 GitHub、正在等同步，同步完成后会自动变成所有人可见的帖子。'
        : '') + '</p>' +
      '<div class="meta"><span>昵称：' + esc(name) + '</span><span>' + mine.length + ' 条本地帖</span>' +
      '<span>' + commentThreads + ' 个帖子有本地评论</span></div></section>';

    html += '<div class="hero-actions" style="margin-bottom:18px">' +
      '<button class="btn solid" data-act="compose">写一条</button>' +
      '<button class="btn" data-act="settings">改昵称 / 连接 GitHub</button>' +
      '<button class="btn" data-act="export">导出备份</button>' +
      '<button class="btn" data-act="import">导入备份</button>' +
      '<button class="btn" data-act="wipe">清空本地数据</button></div>';

    html += mine.length ? feedHtml(mine) : emptyHtml('🫥', '本机还没有你的帖子',
      '发帖时会默认存到本机；连接 GitHub 令牌后可以发到公共 Issues。',
      '<p style="margin-top:12px"><button class="btn solid" data-act="compose">现在写一条</button></p>');
    return html;
  }

  function viewSearch(q) {
    var kw = String(q || '').trim().toLowerCase();
    if (!kw) return emptyHtml('🔍', '输入关键词开始搜索', '试试「拌面」「1306」「蕾丽」「天台」。');
    var hits = state.posts.filter(function (p) {
      var sec = sectionDef(p.section);
      var hay = [p.title, p.text, p.author, p.group, sec.name, sec.short].join(' ').toLowerCase();
      return hay.indexOf(kw) >= 0;
    }).sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });

    var shown = hits.slice(0, state.limit);
    var html = '<section class="section-head"><p class="crumb"><a href="#/">全部帖子</a> / 搜索</p>' +
      '<h1><span class="sc-emoji">🔍</span>“' + esc(q) + '”</h1>' +
      '<p>找到 ' + hits.length + ' 条相关回忆。</p></section>';
    if (!hits.length) return html + emptyHtml('🫧', '没有找到', '换个词试试，或者干脆自己写一条。');
    return html + feedHtml(shown) + moreHtml(shown.length, hits.length, 'search');
  }

  function notFoundHtml() {
    return emptyHtml('🫥', '没有找到这一页', '链接可能过期了。',
      '<p style="margin-top:12px"><a class="btn" href="#/">回到首页</a></p>');
  }


  function viewAbout() {
    var sum = stats();
    var modeLine = ghEnabled()
      ? '当前站点已连接 GitHub 仓库 <b>' + esc(state.config.repo) + '</b>：带令牌发帖/评论会直接写进该仓库的 Issues。'
      : '当前站点是“本地模式”：发帖与评论只保存在你自己的浏览器里。';
    return '<section class="section-head"><p class="crumb"><a href="#/">全部帖子</a> / 关于</p>' +
      '<h1><span class="sc-emoji">ℹ️</span>关于这面回忆墙</h1>' +
      '<p>原文来自 2026 届同学整理的回忆录 docx：' + ((state.seed && state.seed.posts.length) || 0) +
      ' 楼、' + sum.comments + ' 条回复、' + sum.images + ' 张图片与 ' + sum.audio +
      ' 段录音。现在它长成了一个可以继续说话的地方。</p></section>' +
      '<div class="prose">' +
      '<h2>怎么发帖</h2>' +
      '<p>点右上角「发帖」，选板块、写正文即可。默认保存在本机浏览器（本机模式），刷新还在，但别人看不到。</p>' +
      '<div class="callout">' + modeLine + '</div>' +
      '<h2>怎么让大家都能看见</h2>' +
      '<p>GitHub 模式使用仓库 Issues 当“帖子表”——不需要服务器、不需要数据库，静态页面用 REST API 读写：</p>' +
      '<ol>' +
      '<li>建一个公开仓库（或者用现有的），在 <code>data/config.json</code> 里填 <code>repo</code>。</li>' +
      '<li>给仓库建 label：<code>post</code>，以及每个板块的 <code>sec-&lt;id&gt;</code>（如 <code>sec-story</code>）。</li>' +
      '<li>生成一个 fine-grained token，权限勾 <code>Issues: Read and write</code>。</li>' +
      '<li>在「设置」里粘贴令牌（只存本机 localStorage），之后发帖/评论就直达 Issues。</li>' +
      '</ol>' +
      '<p>没有令牌的同学点发送时，站点会复制好内容并打开 GitHub 新建 Issue 页面，登录后粘贴即可。</p>' +
      '<h2>数据与隐私</h2>' +
      '<ul>' +
      '<li>原文数据：<code>data/posts.json</code>，由 <code>scripts/build_site_data.py</code> 从 docx 生成。</li>' +
      '<li>图片与音频：<code>assets/img</code>、<code>assets/audio</code>，已压缩以便网页加载。</li>' +
      '<li>昵称、令牌、点赞、本地帖都只在本机 localStorage，不会上传到任何第三方。</li>' +
      '<li>清除浏览器数据会丢掉本地帖，记得在「我的发帖」里导出备份。</li>' +
      '</ul>' +
      '<h2>鸣谢</h2>' +
      '<p>谢谢写序的 Marguerite.，谢谢每一个在年级群里盖楼、发语音、偷偷投稿的人。' +
      '也谢谢杭外：樱花、猫、1306、拌面和那些老师，都还在。</p>' +
      '</div>';
  }

  /* ------------------------------------------------------- 渲染入口 */
  function render() {
    var main = $('#main');
    if (!main) return;
    var route = parseRoute();
    var changed = route.name !== state.route.name || route.section !== state.route.section ||
      route.id !== state.route.id;
    if (route.name === 'search' && route.q !== state.route.q) changed = false;
    state.route = route;
    if (changed) {
      state.limit = 20;
      closeModal();
      if (!$('#lightbox').hidden) closeLightbox();
    }

    var html;
    if (!state.seed) {
      html = '<div class="loading"><div class="spinner"></div><p>正在翻开回忆录…</p></div>';
    } else if (route.name === 'section') {
      html = viewSection(route.section);
    } else if (route.name === 'post') {
      html = viewPost(route.id);
    } else if (route.name === 'mine') {
      html = viewMine();
    } else if (route.name === 'about') {
      html = viewAbout();
    } else if (route.name === 'search') {
      html = viewSearch(route.q);
    } else {
      html = viewHome();
    }
    main.innerHTML = html;

    renderNav();
    document.title = pageTitle(route);
    if (changed && !state.silent) window.scrollTo({ top: 0, behavior: 'auto' });
    state.silent = false;

    if (route.name === 'post') loadPostComments(route.id);
    if (route.name === 'search' && $('#searchInput')) $('#searchInput').value = route.q || '';
  }

  function pageTitle(route) {
    var base = '海弗拉斯26届回忆录';
    if (route.name === 'section') return sectionDef(route.section).name + ' · ' + base;
    if (route.name === 'post') {
      var p = state.byId[route.id];
      return (p && (p.title || String(p.text || '').slice(0, 18))) || '单条回忆' + ' · ' + base;
    }
    if (route.name === 'mine') return '我的发帖 · ' + base;
    if (route.name === 'about') return '关于 · ' + base;
    if (route.name === 'search') return '搜索：' + route.q + ' · ' + base;
    return base + ' · hw 也有回忆录😋';
  }

  function loadPostComments(id, force) {
    var post = state.byId[id];
    if (!post || post.origin !== 'github' || !ghEnabled() || post.ghFetching) return;
    var now = Date.now();
    // 60 秒内不重复拉；烘焙评论可能是旧的，所以有评论也要并一次最新的
    if (!force && post.ghFetchedAt && now - post.ghFetchedAt < 60000) return;
    post.ghFetching = true;
    post.ghFetchedAt = now;
    ghComments(post.id).then(function (list) {
      post.ghFetching = false;
      post.ghFetchTried = true;
      var merged = mergeComments(post.ghComments || [], list);
      post.ghComments = merged;
      post.commentCount = Math.max(post.commentCount || 0, merged.length);
      writeGhCache();
      if (state.route.name === 'post' && state.route.id === id) render();
    }).catch(function (err) {
      post.ghFetching = false;
      post.ghFetchTried = true;
      // 没令牌的访客连不上 GitHub 是常态，安静降级，不要弹红字
      if (state.token) toast('评论读取失败：' + err.message);
      if (state.route.name === 'post' && state.route.id === id) render();
    });
  }


  /* ------------------------------------------------------- 弹层 */
  function openModal(html) {
    var root = $('#modalRoot');
    root.innerHTML = html;
    root.hidden = false;
    $('#scrim').hidden = false;
    document.body.classList.add('no-scroll');
    var focusable = root.querySelector('input:not([type=hidden]), textarea, select, button');
    if (focusable) setTimeout(function () { focusable.focus(); }, 60);
  }

  function closeModal() {
    var root = $('#modalRoot');
    root.hidden = true;
    root.innerHTML = '';
    $('#scrim').hidden = true;
    document.body.classList.remove('no-scroll');
  }

  function composeMode() {
    return (ghEnabled() && state.token) ? 'github' : 'local';
  }

  function openCompose(sectionId) {
    pendingImages = [];
    var secId = sectionId || (state.route.name === 'section' ? state.route.section : '');
    if (!state.sections.some(function (s) { return s.id === secId; })) secId = 'story';
    var mode = composeMode();

    var pills = state.sections.map(function (s) {
      return '<button type="button" class="section-pill" data-pill="' + s.id + '" aria-pressed="' +
        (s.id === secId) + '">' + s.emoji + ' ' + esc(s.short || s.name) + '</button>';
    }).join('');

    openModal('<div class="modal" role="dialog" aria-modal="true" aria-labelledby="composeHead">' +
      '<div class="modal-head"><h2 id="composeHead">写一条回忆</h2>' +
      '<button class="icon-btn close" type="button" data-act="close-modal" aria-label="关闭">✕</button></div>' +
      '<form id="composeForm">' +
      '<div class="modal-body">' +
      '<div class="mode-note" id="composeMode"></div>' +
      '<div class="field"><label for="cpName">昵称</label>' +
      '<input id="cpName" name="name" type="text" maxlength="24" placeholder="匿名同学 / 你的名字" value="' +
      esc(state.profile.name || '') + '"></div>' +
      '<div class="field"><label>放进哪个板块</label><div class="section-pills">' + pills + '</div>' +
      '<input type="hidden" name="section" value="' + esc(secId) + '"></div>' +
      '<div class="field"><label for="cpTitle">标题（可留空）</label>' +
      '<input id="cpTitle" name="title" type="text" maxlength="80" placeholder="例如：1306 的最后一夜"></div>' +
      '<div class="field"><label for="cpText">正文</label>' +
      '<textarea id="cpText" name="text" placeholder="写点什么…换行会保留，链接会自动识别。"></textarea>' +
      '<p class="hint">Ctrl / ⌘ + Enter 直接发布。</p></div>' +
      '<div class="field" id="cpFileWrap"><label for="cpFiles">本地图片（最多 3 张）</label>' +
      '<input id="cpFiles" type="file" accept="image/*" multiple>' +
      '<div class="media-grid n3" id="cpPreview" style="margin-top:10px"></div>' +
      '<p class="hint">会在浏览器里压缩到长边 1280px 再保存。</p></div>' +
      '<p class="hint" id="cpPicHint" hidden></p>' +
      '<div class="field"><label for="cpUrls">图片直链（可选）</label>' +
      '<input id="cpUrls" name="imageUrls" type="text" placeholder="https://… 多个用空格分隔">' +
      '<p class="hint">站外的直链不会被搬到本站，墙内能不能打开要看那个图床。</p></div>' +
      '<div class="field"><label for="cpTarget">保存到</label>' +
      '<select id="cpTarget" name="target">' +
      '<option value="local"' + (mode === 'local' ? ' selected' : '') + '>本机浏览器（只有我可见）</option>' +
      '<option value="github"' + (mode === 'github' ? ' selected' : '') + (ghEnabled() ? '' : ' disabled') +
      '>GitHub Issues（所有人可见）</option>' +
      '</select></div>' +
      '</div>' +
      '<div class="modal-foot"><button class="btn ghost" type="button" data-act="close-modal">取消</button>' +
      '<button class="btn solid push" type="submit" id="cpSubmit">发布</button></div>' +
      '</form></div>');

    updateComposeMode();
    $$('[data-pill]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        $$('[data-pill]').forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
        btn.setAttribute('aria-pressed', 'true');
        $('#composeForm').elements.section.value = btn.getAttribute('data-pill');
      });
    });
    $('#cpTarget').addEventListener('change', updateComposeMode);
    $('#cpFiles').addEventListener('change', onPickImages);
    $('#composeForm').addEventListener('submit', onComposeSubmit);
    $('#cpText').addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        $('#composeForm').requestSubmit();
      }
    });
  }

  function updateComposeMode() {
    var mode = $('#cpTarget').value;
    var box = $('#composeMode');
    if (!box) return;
    box.innerHTML = mode === 'github'
      ? '<span>🌐</span><div>' + (state.token
        ? '会发布到 <b>' + esc(state.config.repo) + '</b> 的 Issues，所有打开这个页面的人都能看到。'
        : '未连接令牌：点击发布后会<b>复制内容并打开 GitHub 新建 Issue 页面</b>，登录后粘贴提交。' +
          '<br>提交后这条会先在本页显示成「同步中」，约 1 分钟内变成所有人可见的公共帖。') +
        '<br>作者昵称会写在正文里的隐藏标记中。</div>'
      : '<span>💾</span><div>保存在<b>本机浏览器</b>，立刻显示在页面上；换设备或清缓存会消失。' +
        (ghEnabled() ? '<br>想让所有人看见，请在「设置」里连接 GitHub 令牌。' : '') + '</div>';
    var fileWrap = $('#cpFileWrap');
    if (fileWrap) fileWrap.style.display = mode === 'github' ? 'none' : '';

    // GitHub 模式：本地图片是 base64，塞不进 Issue，改成「在 GitHub 页面里拖图」
    var picHint = $('#cpPicHint');
    if (picHint) {
      picHint.hidden = mode !== 'github';
      picHint.innerHTML = mode === 'github'
        ? (state.token
          ? '📷 图片：连接令牌时只能填下面的 https 直链（API 不能上传文件）；' +
            '想<b>直接把图拖进正文</b>，就手动去 GitHub 建一条 Issue，本页会自动同步回来。'
          : '📷 图片：点「发布」后会在新窗口打开 GitHub 的新建 Issue 页面，把图片<b>直接拖进正文</b>即可（GitHub 自动托管）。' +
            '同步完成后本站会把图下载到自己的服务器，墙内也能正常显示。')
        : '';
    }
    if (mode === 'github' && pendingImages.length) {
      pendingImages = [];
      renderComposePreviews();
      toast('本地图片不会上传到 GitHub，已清空（请在 GitHub 页面里拖图）');
    }
  }


  function onPickImages(e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    if (!files.length) return;
    var room = 3 - pendingImages.length;
    if (room <= 0) { toast('最多 3 张图片'); e.target.value = ''; return; }
    files.slice(0, room).forEach(function (file) {
      if (!/^image\//.test(file.type)) return;
      compressImage(file).then(function (img) {
        pendingImages.push(img);
        renderComposePreviews();
      }).catch(function () { toast('这张图片读不出来'); });
    });
    e.target.value = '';
  }

  function renderComposePreviews() {
    var box = $('#cpPreview');
    if (!box) return;
    box.innerHTML = pendingImages.map(function (im, i) {
      return '<button type="button" class="media-item" data-drop-img="' + i + '" title="移除">' +
        '<img src="' + im.src + '" alt="">' +
        '<span class="more-count" style="opacity:1;background:rgba(20,14,10,.45);font-size:12px">移除</span></button>';
    }).join('');
    $$('[data-drop-img]').forEach(function (b) {
      b.addEventListener('click', function () {
        pendingImages.splice(Number(b.getAttribute('data-drop-img')), 1);
        renderComposePreviews();
      });
    });
  }

  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var max = 1280;
        var scale = Math.min(1, max / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        var data;
        try { data = canvas.toDataURL('image/jpeg', 0.72); } catch (err) { reject(err); return; }
        URL.revokeObjectURL(url);
        resolve({ src: data, thumb: data, w: w, h: h });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  function collectImageUrls(raw) {
    return String(raw || '').split(/[\s,，]+/).filter(function (u) {
      return /^https?:\/\//i.test(u);
    }).slice(0, 9);
  }


  function onComposeSubmit(e) {
    e.preventDefault();
    var form = e.target;
    var name = (form.elements.name.value || '').trim() || '匿名同学';
    var text = (form.elements.text.value || '').trim();
    var title = (form.elements.title.value || '').trim();
    var section = form.elements.section.value;
    var target = form.elements.target.value;
    var urlImages = collectImageUrls(form.elements.imageUrls.value);

    if (!text && !pendingImages.length && !urlImages.length) { toast('写点什么再发布吧'); return; }

    state.profile = { name: name };
    lsSet(KEYS.profile, state.profile);

    var btn = $('#cpSubmit');
    btn.disabled = true;
    btn.textContent = '发布中…';
    var reset = function () { if (btn) { btn.disabled = false; btn.textContent = '发布'; } };

    var images = pendingImages.slice().concat(urlImages.map(function (src) {
      return { src: src, thumb: src, w: 0, h: 0, remote: true };
    }));

    if (target === 'github' && ghEnabled()) {
      publishToGitHub({ name: name, text: text, title: title, section: section, images: images })
        .then(function (ok) {
          if (!ok) return;
          closeModal();
          if (ok === 'pending') {
            if (lastPendingId && state.byId[lastPendingId]) navigate('#/p/' + lastPendingId);
            return;
          }
          toast('已发到 GitHub Issues');
        })
        .catch(function (err) { toast('发布失败：' + err.message); reset(); });
      return;
    }

    var post = {
      id: 'local-' + Date.now().toString(36),
      section: section,
      origin: 'local',
      author: name,
      createdAt: new Date().toISOString(),
      title: title,
      text: text,
      images: images,
      audio: [],
      comments: []
    };
    state.localPosts.unshift(post);
    if (!saveLocalPosts()) { state.localPosts.shift(); reset(); return; }
    rebuildIndex();
    closeModal();
    toast('已保存到本机');
    navigate('#/p/' + post.id);
  }

  function issueBody(name, text, images, section, extra) {
    // 板块也写进隐藏标记：非协作者发帖时 GitHub 会忽略新建 Issue 的 labels 参数
    var meta = { name: name };
    if (section) meta.section = section;
    if (extra && extra.reply) meta.reply = extra.reply;
    var body = '<!-- hfls:' + JSON.stringify(meta) + ' -->\n\n' + (text || '') + '\n';
    (images || []).forEach(function (im) {
      body += '\n![图片](' + im.src + ')\n';
    });
    return body;
  }

  function issueTitle(title, text) {
    if (title) return title;
    var one = String(text || '').split(/\n/)[0].trim();
    return one ? one.slice(0, 40) : '一条回忆';
  }

  function publishToGitHub(payload) {
    // base64 的本地图片塞不进 Issue（data: URL 会被 GitHub 丢掉，正文也有长度上限）
    var kept = (payload.images || []).filter(function (im) {
      return im && /^https?:\/\//i.test(String(im.src || ''));
    });
    var dropped = (payload.images || []).length - kept.length;
    var publicPayload = {
      name: payload.name, text: payload.text, title: payload.title,
      section: payload.section, images: kept
    };
    var body = issueBody(payload.name, payload.text, kept, payload.section);
    var title = issueTitle(payload.title, payload.text);
    var labels = [state.config.postsLabel || 'post',
      (state.config.sectionLabelPrefix || 'sec-') + payload.section];

    if (!state.token) {
      var url = 'https://github.com/' + state.config.repo + '/issues/new?title=' +
        encodeURIComponent(title) + '&body=' + encodeURIComponent(body) +
        '&labels=' + encodeURIComponent(labels.join(','));
      copyText(body);
      // 先在本机显示成「同步中」，这样发完立刻能看见自己的帖子
      var pend = addPendingPost(publicPayload, title);
      lastPendingId = pend.id;
      rebuildIndex();
      window.open(url, '_blank', 'noopener');
      toast('内容已复制并打开 GitHub：登录后粘贴提交，约 1 分钟后这里会自动出现' +
        (dropped ? '（本地图片没带上，记得在 GitHub 页面里拖图）' : ''));
      return Promise.resolve('pending');
    }

    return ghSend('POST', 'https://api.github.com/repos/' + state.config.repo + '/issues', {
      title: title, body: body, labels: labels
    }).then(function (issue) {
      var post = mapIssue(issue);
      state.ghPosts = state.ghPosts.filter(function (p) { return p.id !== post.id; });
      state.ghPosts.unshift(post);
      rebuildIndex();
      if (dropped) toast('本地图片不会上传到 GitHub，已跳过 ' + dropped + ' 张');
      navigate('#/p/' + post.id);
      return true;
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { legacyCopy(text); });
    }
    legacyCopy(text);
    return Promise.resolve();
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }


  /* ------------------------------------------------------- 设置 */
  function openSettings() {
    openModal('<div class="modal" role="dialog" aria-modal="true" aria-labelledby="setHead" style="width:min(560px,100%)">' +
      '<div class="modal-head"><h2 id="setHead">设置</h2>' +
      '<button class="icon-btn close" type="button" data-act="close-modal" aria-label="关闭">✕</button></div>' +
      '<form id="settingsForm">' +
      '<div class="modal-body">' +
      '<div class="field"><label for="stName">我在这面墙上的昵称</label>' +
      '<input id="stName" name="name" type="text" maxlength="24" placeholder="匿名同学" value="' +
      esc(state.profile.name || '') + '">' +
      '<p class="hint">发帖/评论时默认使用，可随时修改。</p></div>' +
      '<div class="field"><label for="stRepo">GitHub 仓库（owner/repo）</label>' +
      '<input id="stRepo" name="repo" type="text" placeholder="例如 hw2026/memoir" value="' +
      esc(state.config.repo || '') + '">' +
      '<p class="hint">填了之后，站点会把仓库 Issues 当作帖子列表读取（不需要登录）。</p></div>' +
      '<div class="field"><label for="stToken">GitHub 令牌（可选）</label>' +
      '<input id="stToken" name="token" type="password" autocomplete="off" placeholder="github_pat_… / ghp_…" value="' +
      esc(state.token) + '">' +
      '<p class="hint">只需要 fine-grained token 的 <b>Issues: Read and write</b> 权限。令牌只保存在本机浏览器，' +
      '不会发给除 api.github.com 以外的任何地方。</p></div>' +
      '<div class="mode-note" id="stStatus"></div>' +
      '</div>' +
      '<div class="modal-foot">' +
      '<button class="btn ghost" type="button" data-act="clear-token">清除令牌</button>' +
      '<button class="btn" type="button" data-act="test-gh">测试连接</button>' +
      '<button class="btn solid push" type="submit">保存</button>' +
      '</div></form></div>');

    var status = $('#stStatus');
    status.innerHTML = state.gh.broken
      ? '<span>⚠️</span><div>已填仓库 <b>' + esc(state.config.repo) + '</b>，但读取失败：' +
        esc(state.gh.error || '未知原因') + '。现在按<b>本地模式</b>运行，修好仓库名 / 标签后刷新即可。</div>'
      : ghEnabled()
        ? '<span>✅</span><div>仓库已配置：<b>' + esc(state.config.repo) + '</b>' +
          (state.token ? '，令牌已连接。' : '，尚未连接令牌（可读，不能直接写入）。') + '</div>'
        : '<span>💾</span><div>当前为<b>本地模式</b>：所有内容只存在这台设备上。</div>';

    $('#settingsForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      state.profile = { name: (f.elements.name.value || '').trim() };
      lsSet(KEYS.profile, state.profile);

      var repo = (f.elements.repo.value || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
      var token = (f.elements.token.value || '').trim();
      try {
        if (repo) localStorage.setItem(KEYS.repo, repo); else localStorage.removeItem(KEYS.repo);
        if (token) localStorage.setItem(KEYS.token, token); else localStorage.removeItem(KEYS.token);
      } catch (err) { /* ignore */ }
      state.config.repo = repo || state.configFileRepo || '';
      state.repoOverride = repo;
      state.token = token;
      closeModal();
      toast('设置已保存');
      state.gh.broken = false;
      loadGitHub().then(function () {
        render();
        if (state.gh.error) toast('GitHub：' + state.gh.error);
      });
    });
  }

  function testGitHub() {
    var repo = ($('#stRepo') ? $('#stRepo').value : state.config.repo).trim()
      .replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    if (!repo) { toast('先填仓库，例如 owner/repo'); return; }
    ghGet('https://api.github.com/repos/' + repo).then(function (info) {
      return ghGet('https://api.github.com/rate_limit').then(function (rl) {
        var core = rl && rl.resources && rl.resources.core;
        var left = core ? '（本小时剩余 ' + core.remaining + ' 次）' : '';
        toast('连接成功：' + info.full_name + ' ' + left);
      });
    }).catch(function (err) {
      toast('连接失败：' + err.message);
    });
  }


  /* ------------------------------------------------------- 评论 / 点赞 / 分享 */
  function submitComment(postId, text, replyTo) {
    var post = state.byId[postId];
    if (!post) return;
    var body = String(text || '').trim();
    if (!body) { toast('说点什么吧'); return; }
    var name = state.profile.name || '匿名同学';

    // 回复：正文里带一句引用（GitHub 上也能看出在回谁），隐藏标记里记 replyTo 供站内缩进
    var parent = replyTo ? findComment(post, replyTo) : null;
    var quoted = parent
      ? '> ' + (parent.author ? '@' + parent.author + '：' : '') +
        String(parent.text || '').replace(/\s+/g, ' ').slice(0, 80) + '\n\n'
      : '';
    var full = quoted + body;
    var replyMeta = replyTo ? { reply: replyTo } : null;

    if (post.origin === 'github' && ghEnabled()) {
      if (!state.token) {
        copyText(full);
        if (post.url) window.open(post.url, '_blank', 'noopener');
        toast('内容已复制；登录 GitHub 后在 Issue 下粘贴评论');
        return;
      }
      ghSend('POST', 'https://api.github.com/repos/' + state.config.repo + '/issues/' +
        post.number + '/comments', { body: issueBody(name, full, [], '', replyMeta) })
        .then(function (c) {
          post.ghComments = (post.ghComments || []).concat([{
            id: 'ghc-' + c.id,
            author: name,
            text: full,
            createdAt: c.created_at,
            origin: 'github',
            url: c.html_url || '',
            replyTo: replyTo || ''
          }]);
          post.commentCount = (post.commentCount || 0) + 1;
          render();
          toast(replyTo ? '回复已发到 GitHub' : '评论已发到 GitHub');
        })
        .catch(function (err) { toast('评论失败：' + err.message); });
      return;
    }

    var list = state.localComments[postId] || (state.localComments[postId] = []);
    list.push({
      id: 'lc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      author: name,
      text: full,
      replyTo: replyTo || '',
      createdAt: new Date().toISOString()
    });
    saveLocalComments();
    render();
    toast(post.origin === 'pending'
      ? '评论先存在本机，同步完成后会并到公共帖下面'
      : '评论已保存在本机');
  }

  function toggleLike(postId) {
    var post = state.byId[postId];
    if (!post) return;
    if (state.likes[postId]) delete state.likes[postId];
    else state.likes[postId] = 1;
    saveLikes();
    var count = $('#post-' + cssEscape(postId) + ' [data-like-count]');
    if (count) count.textContent = likeCountOf(post);
    var btn = $('#post-' + cssEscape(postId) + ' [data-act="like"]');
    if (btn) btn.classList.toggle('liked', likedByMe(post));
  }

  function cssEscape(str) {
    if (window.CSS && CSS.escape) return CSS.escape(str);
    return String(str).replace(/["\\]/g, '\\$&');
  }

  function copyPostLink(postId) {
    var url = location.origin + location.pathname + '#/p/' + postId;
    copyText(url).then(function () { toast('链接已复制'); });
  }

  /* ------------------------------------------------------- 灯箱 */
  var lb = { postId: null, index: 0 };

  function openLightbox(postId, index) {
    var post = state.byId[postId];
    if (!post || !(post.images || []).length) return;
    lb.postId = postId;
    lb.index = Math.max(0, Math.min((post.images || []).length - 1, Number(index) || 0));
    $('#lightbox').hidden = false;
    document.body.classList.add('no-scroll');
    paintLightbox();
  }

  function paintLightbox() {
    var post = state.byId[lb.postId];
    if (!post) return closeLightbox();
    var imgs = post.images || [];
    var im = imgs[lb.index];
    var img = $('#lbImg');
    img.src = im.src;
    img.alt = (post.title || post.text || '').slice(0, 60) + ' 图片 ' + (lb.index + 1);
    $('#lbCap').textContent = (post.author || '') + ' · ' + sectionDef(post.section).short +
      ' · ' + (lb.index + 1) + ' / ' + imgs.length;
    $('#lightbox .lb-prev').style.visibility = imgs.length > 1 ? 'visible' : 'hidden';
    $('#lightbox .lb-next').style.visibility = imgs.length > 1 ? 'visible' : 'hidden';
  }

  function stepLightbox(delta) {
    var post = state.byId[lb.postId];
    if (!post) return;
    var n = (post.images || []).length;
    if (!n) return;
    lb.index = (lb.index + delta + n) % n;
    paintLightbox();
  }

  function closeLightbox() {
    $('#lightbox').hidden = true;
    $('#lbImg').removeAttribute('src');
    document.body.classList.remove('no-scroll');
  }

  /* ------------------------------------------------------- 主题 */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(KEYS.theme, theme); } catch (e) { /* ignore */ }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#16130f' : '#faf7f2');
    var btn = $('#themeBtn');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌗';
  }

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem(KEYS.theme); } catch (e) { /* ignore */ }
    if (!saved) {
      saved = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    applyTheme(saved);
  }

  /* ------------------------------------------------------- 侧栏 */
  function toggleSidebar(open) {
    var bar = $('#sidebar');
    var scrim = $('#scrim');
    var btn = $('#menuBtn');
    var next = typeof open === 'boolean' ? open : !bar.classList.contains('open');
    bar.classList.toggle('open', next);
    if (btn) btn.setAttribute('aria-expanded', String(next));
    if (next && window.innerWidth <= 900) {
      scrim.hidden = false;
      document.body.classList.add('no-scroll');
    } else {
      if ($('#modalRoot').hidden) {
        scrim.hidden = true;
        document.body.classList.remove('no-scroll');
      }
    }
  }


  /* ------------------------------------------------------- 备份 */
  function exportData() {
    var dump = {
      kind: 'hfls-memoir-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      profile: state.profile,
      posts: state.localPosts,
      comments: state.localComments,
      likes: state.likes
    };
    var blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'hw-memoir-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('备份已导出');
  }

  function importData() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var data;
        try { data = JSON.parse(String(reader.result)); } catch (e) { toast('文件不是有效的 JSON'); return; }
        if (!data || !Array.isArray(data.posts)) { toast('备份格式不对'); return; }
        var known = {};
        state.localPosts.forEach(function (p) { known[p.id] = true; });
        var added = 0;
        data.posts.forEach(function (p) {
          if (!p || !p.id || known[p.id]) return;
          p.origin = 'local';
          state.localPosts.push(p);
          known[p.id] = true;
          added++;
        });
        Object.keys(data.comments || {}).forEach(function (k) {
          var mine = state.localComments[k] || [];
          var seenText = {};
          mine.forEach(function (c) { seenText[c.author + '|' + c.text] = true; });
          (data.comments[k] || []).forEach(function (c) {
            if (!seenText[c.author + '|' + c.text]) { mine.push(c); seenText[c.author + '|' + c.text] = true; }
          });
          state.localComments[k] = mine;
        });
        Object.keys(data.likes || {}).forEach(function (k) { state.likes[k] = data.likes[k]; });
        saveLocalPosts(); saveLocalComments(); saveLikes();
        rebuildIndex();
        render();
        toast('已导入 ' + added + ' 条本地帖');
      };
      reader.readAsText(file, 'utf-8');
    });
    input.click();
  }

  function wipeLocal() {
    if (!window.confirm('确定清空本机的帖子、评论、点赞和昵称吗？（GitHub 上的内容不受影响）')) return;
    [KEYS.posts, KEYS.pending, KEYS.ghCache, KEYS.comments, KEYS.likes, KEYS.profile, KEYS.seen,
      KEYS.lastVisit].forEach(function (k) {
      try { localStorage.removeItem(k); } catch (e) { /* ignore */ }
    });
    state.localPosts = [];
    state.pendingPosts = [];
    state.localComments = {};
    state.likes = {};
    state.profile = { name: '' };
    rebuildIndex();
    render();
    toast('本地数据已清空');
  }


  /* ------------------------------------------------------- 事件 */
  function onClick(e) {
    var target = e.target.closest ? e.target.closest('[data-act]') : null;
    if (target) {
      var act = target.getAttribute('data-act');
      if (act === 'compose') { openCompose(target.getAttribute('data-section') || ''); return; }
      if (act === 'settings') { openSettings(); return; }
      if (act === 'close-modal') { closeModal(); return; }
      if (act === 'like') { toggleLike(target.getAttribute('data-id')); return; }
      if (act === 'detail') { navigate('#/p/' + target.getAttribute('data-id')); return; }
      if (act === 'copy') { copyPostLink(target.getAttribute('data-id')); return; }
      if (act === 'lightbox') {
        openLightbox(target.getAttribute('data-post'), target.getAttribute('data-index'));
        return;
      }
      if (act === 'more') { state.limit += 20; render(); return; }
      if (act === 'reply') {
        startReply(target.getAttribute('data-cid'), target.getAttribute('data-author'));
        return;
      }
      if (act === 'reply-cancel') { startReply('', ''); return; }
      if (act === 'refresh-comments') {
        loadPostComments(target.getAttribute('data-id'), true);
        toast('正在刷新评论…');
        return;
      }
      if (act === 'export') { exportData(); return; }
      if (act === 'import') { importData(); return; }
      if (act === 'wipe') { wipeLocal(); return; }
      if (act === 'test-gh') { testGitHub(); return; }
      if (act === 'retry-gh') { refreshGitHub(); return; }
      if (act === 'clear-token') {
        try { localStorage.removeItem(KEYS.token); } catch (err) { /* ignore */ }
        state.token = '';
        var tok = $('#stToken');
        if (tok) tok.value = '';
        renderStatus();
        toast('令牌已清除');
        return;
      }
    }

    var lbBtn = e.target.closest ? e.target.closest('[data-lb]') : null;
    if (lbBtn) {
      var dir = lbBtn.getAttribute('data-lb');
      if (dir === 'close') closeLightbox();
      else if (dir === 'prev') stepLightbox(-1);
      else if (dir === 'next') stepLightbox(1);
      return;
    }

    if (e.target.id === 'scrim') {
      closeModal();
      toggleSidebar(false);
      return;
    }

    var navLink = e.target.closest ? e.target.closest('a[href^="#/"]') : null;
    if (navLink && window.innerWidth <= 900) toggleSidebar(false);
  }

  function onSubmit(e) {
    var form = e.target;
    if (form.getAttribute('data-form') === 'comment') {
      e.preventDefault();
      var ta = form.querySelector('textarea[name="text"]');
      var text = ta ? ta.value : '';
      submitComment(form.getAttribute('data-id'), text, form.getAttribute('data-reply') || '');
      if (ta && String(text || '').trim()) {
        ta.value = '';
        startReply('', '');
      }
    }
  }

  function onCommentKey(e) {
    if (e.target.tagName !== 'TEXTAREA') return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      var form = e.target.closest('form[data-form="comment"]');
      if (form) { e.preventDefault(); form.requestSubmit(); }
    }
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      if (!$('#lightbox').hidden) { closeLightbox(); return; }
      if (!$('#modalRoot').hidden) { closeModal(); return; }
      toggleSidebar(false);
      return;
    }
    if (!$('#lightbox').hidden) {
      if (e.key === 'ArrowLeft') stepLightbox(-1);
      if (e.key === 'ArrowRight') stepLightbox(1);
      return;
    }
    var tag = (e.target.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
    if (e.key === '/' && !typing) {
      e.preventDefault();
      var input = $('#searchInput');
      if (input) input.focus();
    }
  }

  function bindEvents() {
    document.addEventListener('click', onClick);
    document.addEventListener('submit', onSubmit);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('keydown', onCommentKey);
    window.addEventListener('hashchange', render);

    var menuBtn = $('#menuBtn');
    if (menuBtn) menuBtn.addEventListener('click', function () { toggleSidebar(); });

    var themeBtn = $('#themeBtn');
    if (themeBtn) themeBtn.addEventListener('click', function () {
      var now = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(now);
    });

    var search = $('#searchInput');
    if (search) {
      var timer = null;
      search.addEventListener('input', function () {
        clearTimeout(timer);
        var q = search.value.trim();
        timer = setTimeout(function () {
          if (!q) navigate('#/');
          else navigate('#/search/' + encodeURIComponent(q), { silent: true });
        }, 240);
      });
      search.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { search.value = ''; navigate('#/'); search.blur(); }
      });
    }

    window.addEventListener('beforeunload', function () { lsSet(KEYS.lastVisit, Date.now()); });
  }


  /* ------------------------------------------------------- 加载 */
  function loadConfig() {
    return fetch(CONFIG_URL, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (cfg) {
      state.config = Object.assign({}, DEFAULT_CONFIG, cfg || {});
    }).catch(function () {
      state.config = Object.assign({}, DEFAULT_CONFIG);
    }).then(function () {
      state.configFileRepo = state.config.repo || '';
      if (state.repoOverride) state.config.repo = state.repoOverride;
      if (ghEnabled()) {
        document.documentElement.setAttribute('data-gh', state.config.repo);
      }
    });
  }

  function loadSeed() {
    return fetch(SEED_URL, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      state.seed = data;
      state.sections = (data && data.sections) || [];
      if (!state.sections.length) throw new Error('缺少板块数据');
    });
  }

  function boot() {
    loadLocal();
    initTheme();
    bindEvents();

    loadConfig().then(loadSeed).then(function () {
      rebuildIndex();
      render();
      var site = (state.seed && state.seed.site) || {};
      var note = $('#footerNote');
      if (note) {
        note.textContent = (site.school ? site.school + ' ' : '') + (site.cohort ? site.cohort + ' · ' : '') +
          '同学们的回忆墙 · 原文 ' + (state.seed.posts || []).length + ' 楼';
      }
      if (ghEnabled()) {
        loadGitHub().then(function () {
          render();
          // 访客端失败已自动降级为本地模式，只有配了令牌的人才提示
          if (state.gh.error && state.token) toast('GitHub 数据读取失败：' + state.gh.error);
        });
      }
      setTimeout(function () { lsSet(KEYS.lastVisit, Date.now()); }, 6000);
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') lsSet(KEYS.lastVisit, Date.now());
      });
    }).catch(function (err) {
      $('#main').innerHTML = '<div class="empty"><div class="big">😵</div><p><b>回忆录没能打开</b></p>' +
        '<p>' + esc(err.message || String(err)) + '</p>' +
        '<p class="hint">如果你是在本地双击 index.html 打开的，请改用本地 HTTP 服务：<br>' +
        '<code>python -m http.server 8000 --directory docs</code></p></div>';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

