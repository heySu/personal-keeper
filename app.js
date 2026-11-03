/* ============================================================
 * 信息管家 · 个人信息管理 Agent
 * 云端：WorkBuddy Cloud Service（数据库 / 登录 / 大模型）
 * ============================================================ */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const KINDS = { idea: '想法', material: '资料', todo: '待办' };
  const CATS = ['工作', '学习', '生活', '健康', '财务', '灵感', '人际', '其他'];
  const PRIOS = { high: '高', medium: '中', low: '低' };

  let cloud = null;

  const state = {
    session: null,
    notes: [],
    reports: [],
    view: 'inbox',
    filter: 'all',
    q: '',
    period: 'week',
    modelId: null,
    models: [],
    conversationId: null,
    chat: [],
    chatBusy: false,
    currentNoteId: null,
    pendingOtp: null,
    loginMode: 'phone',
    countdown: 0,
    timer: null,
    loading: false,
  };

  /* ---------------- 基础工具 ---------------- */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const pad = (n) => String(n).padStart(2, '0');
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso), now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (d.toDateString() === now.toDateString()) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }
  function toast(msg, isError) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.className = 'toast'; }, 2800);
  }
  function busy(btn, on) {
    if (!btn) return;
    btn.disabled = !!on;
    btn.classList.toggle('loading', !!on);
  }
  function confirmDialog(title, text, okText) {
    return new Promise((resolve) => {
      const modal = $('modal');
      $('modalTitle').textContent = title;
      $('modalText').textContent = text;
      $('modalOk').textContent = okText || '确定';
      modal.classList.remove('hidden');
      const done = (v) => {
        modal.classList.add('hidden');
        $('modalOk').onclick = null; $('modalCancel').onclick = null;
        resolve(v);
      };
      $('modalOk').onclick = () => done(true);
      $('modalCancel').onclick = () => done(false);
      $('modal').onclick = (e) => { if (e.target === $('modal')) done(false); };
    });
  }

  /* 中文/英文混排的分词（CJK 双字 + 拉丁词） */
  function tokens(text) {
    const out = [];
    const s = String(text || '').toLowerCase();
    s.replace(/[\u4e00-\u9fa5]+/g, (m) => {
      for (let i = 0; i < m.length - 1; i++) out.push(m.slice(i, i + 2));
      if (m.length === 1) out.push(m);
      return ' ';
    });
    s.replace(/[a-z0-9]{2,}/g, (m) => { out.push(m); return ' '; });
    return out;
  }
  function keywordHit(note, q) {
    const ql = q.toLowerCase();
    const fields = [note.title, note.content, note.summary, note.category, (note.tags || []).join(' '), (note.keywords || []).join(' ')]
      .filter(Boolean).join(' ').toLowerCase();
    if (fields.includes(ql)) return true;
    const qt = tokens(q);
    if (!qt.length) return false;
    const nt = new Set(tokens(fields));
    let hit = 0;
    qt.forEach((t) => { if (nt.has(t)) hit++; });
    return hit >= Math.max(1, Math.ceil(qt.length * 0.45));
  }
  function highlight(text, q) {
    let out = escapeHtml(text);
    if (!q) return out;
    const words = String(q).trim().split(/\s+/).filter((w) => w.length >= 1).slice(0, 5);
    words.sort((a, b) => b.length - a.length);
    words.forEach((w) => {
      const safe = escapeHtml(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(safe, 'gi'), (m) => `<mark>${m}</mark>`);
    });
    return out;
  }
  function parseJson(text) {
    if (!text) return null;
    let s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/g, '').trim();
    try { return JSON.parse(s); } catch (e) { /* noop */ }
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { /* noop */ } }
    const a2 = s.indexOf('['), b2 = s.lastIndexOf(']');
    if (a2 >= 0 && b2 > a2) { try { return JSON.parse(s.slice(a2, b2 + 1)); } catch (e) { /* noop */ } }
    return null;
  }
  function mdToHtml(text) {
    const esc = escapeHtml(text || '');
    const lines = esc.split(/\r?\n/);
    let html = '', list = null;
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    const inline = (s) => s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[(\d+)\]/g, '<button class="cite" data-cite="$1">$1</button>');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { close(); continue; }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { close(); html += `<h4>${inline(h[2])}</h4>`; continue; }
      const ui = line.match(/^[-*•]\s+(.*)$/);
      if (ui) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(ui[1])}</li>`; continue; }
      const oi = line.match(/^(\d+)[.)]\s+(.*)$/);
      if (oi) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(oi[2])}</li>`; continue; }
      close();
      html += `<p>${inline(line)}</p>`;
    }
    close();
    return html;
  }

  /* ---------------- 云端初始化 ---------------- */
  function initCloud() {
    if (!window.WorkBuddyCloud || typeof window.WorkBuddyCloud.createWorkBuddyCloud !== 'function') {
      toast('云端 SDK 加载失败，请检查网络后刷新', true);
      return false;
    }
    cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: CFG.endpoint,
      oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
      publishableKey: CFG.publishableKey,
    });
    return true;
  }

  /* ---------------- 登录 ---------------- */
  function showLogin(msg) {
    $('loginScreen').classList.remove('hidden');
    $('app').classList.add('hidden');
    if (msg) setLoginMsg(msg, false);
  }

  function setLoginMsg(msg, ok) {
    const el = $('loginError');
    el.textContent = msg || '';
    el.className = 'form-msg' + (ok ? ' ok' : '');
  }

  function switchLoginMode(mode) {
    state.loginMode = mode;
    state.pendingOtp = null;
    document.querySelectorAll('#loginTabs .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    const isPhone = mode === 'phone';
    $('loginIdLabel').textContent = isPhone ? '手机号' : '邮箱';
    const input = $('loginId');
    input.type = isPhone ? 'tel' : 'email';
    input.inputMode = isPhone ? 'numeric' : 'email';
    input.placeholder = isPhone ? '请输入 11 位手机号' : '请输入邮箱地址';
    input.value = '';
    $('loginCode').value = '';
    setLoginMsg('');
  }

  function startCountdown(sec) {
    state.countdown = sec;
    const btn = $('sendCodeBtn');
    clearInterval(state.timer);
    const tick = () => {
      if (state.countdown <= 0) {
        clearInterval(state.timer);
        btn.textContent = '获取验证码';
        btn.disabled = false;
        return;
      }
      btn.textContent = `${state.countdown}s 后重发`;
      btn.disabled = true;
      state.countdown--;
    };
    tick();
    state.timer = setInterval(tick, 1000);
  }

  async function sendCode() {
    const mode = state.loginMode;
    const raw = $('loginId').value.trim();
    if (mode === 'phone' && !/^1\d{10}$/.test(raw)) { setLoginMsg('请输入正确的 11 位手机号'); return; }
    if (mode === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) { setLoginMsg('请输入有效的邮箱地址'); return; }
    setLoginMsg('');
    const btn = $('sendCodeBtn');
    btn.disabled = true; btn.textContent = '发送中…';
    try {
      const sent = await cloud.auth.sendOtp(mode === 'phone' ? { phone: raw } : { email: raw });
      if (sent.error) {
        setLoginMsg(sent.error.message || '验证码发送失败');
        btn.disabled = false; btn.textContent = '获取验证码';
        return;
      }
      state.pendingOtp = {
        mode, id: raw,
        verificationId: sent.data.verificationId,
        isExistingUser: sent.data.isExistingUser,
      };
      setLoginMsg('验证码已发送，请查看' + (mode === 'phone' ? '短信' : '邮件'), true);
      startCountdown(60);
    } catch (e) {
      setLoginMsg(e && e.message ? e.message : '网络异常，请稍后重试');
      btn.disabled = false; btn.textContent = '获取验证码';
    }
  }

  async function submitLogin(e) {
    e.preventDefault();
    const mode = state.loginMode;
    const raw = $('loginId').value.trim();
    const code = $('loginCode').value.trim();
    const pending = state.pendingOtp;
    if (!pending || pending.id !== raw) { setLoginMsg('请先获取当前账号的验证码'); return; }
    if (!code) { setLoginMsg('请输入验证码'); return; }
    const btn = $('loginSubmit');
    busy(btn, true);
    setLoginMsg('');
    try {
      const ident = mode === 'phone' ? { phone: pending.id } : { email: pending.id };
      const done = await cloud.auth.verifyOtp({
        ...ident,
        verificationId: pending.verificationId,
        isExistingUser: pending.isExistingUser,
        token: code,
      });
      if (done.error) { setLoginMsg(done.error.message || '验证码校验失败'); return; }
      state.pendingOtp = null;
      const sess = done.data;
      const { data: session } = await cloud.auth.getSession();
      enterApp(session || sess);
    } catch (err) {
      setLoginMsg(err && err.message ? err.message : '登录失败，请重试');
    } finally {
      busy(btn, false);
    }
  }

  async function wechatLogin() {
    const btn = $('wechatBtn');
    busy(btn, true);
    try {
      const { data, error } = await cloud.auth.signInWithOAuth({ provider: 'wechat', redirectTo: location.origin });
      if (error) { setLoginMsg(error.message || '微信登录不可用'); busy(btn, false); return; }
      location.assign(data.url);
    } catch (e) {
      setLoginMsg(e && e.message ? e.message : '微信登录失败');
      busy(btn, false);
    }
  }

  async function logout() {
    const ok = await confirmDialog('退出登录', '退出后需要重新验证身份才能查看记录。', '退出');
    if (!ok) return;
    await cloud.auth.signOut();
    state.session = null; state.notes = []; state.reports = []; state.chat = [];
    showLogin();
  }

  /* ---------------- 认证回调 & 启动 ---------------- */
  async function restoreAuth() {
    const url = new URL(location.href);
    const hasCode = url.searchParams.has('code');
    const hasError = url.searchParams.has('error');
    if (!hasCode && !hasError) { return continueNormalStartup(); }
    const provider = url.searchParams.get('provider');
    if (provider !== 'wechat' && provider !== 'workbuddy') {
      setLoginMsg('登录回调缺少有效信息，请重新登录。');
      return showLogin();
    }
    const handler = provider === 'wechat' ? cloud.auth.handleWechatWebCallback : cloud.auth.handleWorkBuddyCallback;
    if (typeof handler !== 'function') {
      setLoginMsg('当前环境暂不支持该登录方式');
      return showLogin();
    }
    try {
      const { data: session, error } = await handler.call(cloud.auth);
      if (error) { setLoginMsg(error.message || '登录失败'); return showLogin(); }
      if (session) {
        ['code', 'state', 'provider'].forEach((k) => url.searchParams.delete(k));
        history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
        return enterApp(session);
      }
      return continueNormalStartup();
    } catch (e) {
      setLoginMsg(e && e.message ? e.message : '登录回调处理失败');
      return showLogin();
    }
  }

  async function continueNormalStartup() {
    const { data: session, error } = await cloud.auth.getSession();
    if (error || !session) { showLogin(); return; }
    enterApp(session);
  }

  async function enterApp(session) {
    if (!session || !session.user) { showLogin(); return; }
    state.session = session;
    $('loginScreen').classList.add('hidden');
    $('app').classList.remove('hidden');
    const name = session.user.name || '我的空间';
    $('userName').textContent = name;
    $('userAvatar').textContent = name.slice(0, 1).toUpperCase();
    const uid = session.user.id || session.user.userId || 'me';
    state.conversationId = localStorage.getItem('ik_conv_' + uid) || newConversationId(uid);
    await Promise.all([loadModels(), loadNotes(), loadReports(), loadChat()]);
    renderAll();
  }

  function newConversationId(uid) {
    const id = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    try { localStorage.setItem('ik_conv_' + uid, id); } catch (e) { /* noop */ }
    return id;
  }

  /* ---------------- 大模型 ---------------- */
  async function loadModels() {
    try {
      const res = await cloud.llm.models.list();
      const list = Array.isArray(res) ? res : (res && res.data) || [];
      state.models = list;
      const usable = list.filter((m) => m && m.disabled !== true);
      state.modelId = usable.length ? (usable[0].id || usable[0].name) : null;
    } catch (e) {
      console.warn('[models]', e && e.message);
      state.modelId = null;
    }
  }

  async function callLLM(opts) {
    if (!state.modelId) throw new Error('模型未就绪');
    const messages = [{ role: 'system', content: opts.system }];
    if (opts.history && opts.history.length) messages.push(...opts.history);
    messages.push({ role: 'user', content: opts.user });
    const payload = {
      model: state.modelId,
      messages,
      stream: true,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.4,
    };
    if (opts.json) payload.response_format = { type: 'json_object' };
    if (opts.conversationId) payload.conversationId = opts.conversationId;
    if (opts.signal) payload.signal = opts.signal;

    let out = '';
    for await (const chunk of cloud.llm.chat.completions.create(payload)) {
      const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (delta && delta.content) {
        out += delta.content;
        if (opts.onDelta) opts.onDelta(out);
      }
    }
    return out;
  }

  const SYS_ORGANIZER = '你是一名严谨的个人信息整理助手。你只输出合法的 JSON 对象，不要输出任何解释文字、Markdown 代码块说明或多余内容。所有字段值使用简体中文。';
  const SYS_TUTOR = '你是用户的个人信息管家，帮助他把零散记录变成可行动的知识。你只能依据用户提供的笔记内容回答，不得编造笔记中不存在的事实、数字或人名。资料不足时要明确说明「你的记录里没有这方面的内容」，并给出建议补充记录的方向。回答使用简体中文，简洁、分点，引用某条笔记时用 [1] 这样的编号标注。';

  async function aiClassify(content) {
    const user = [
      '请整理下面这条个人笔记，抽取结构化信息，严格按以下 JSON 结构返回：',
      '{',
      '  "title": "不超过 20 字的标题，概括核心内容",',
      '  "kind": "idea 想法 / material 资料 / todo 待办，三选一",',
      '  "category": "从 [工作,学习,生活,健康,财务,灵感,人际,其他] 中选一个",',
      '  "summary": "不超过 60 字的一句话摘要，说明这条内容是什么、要做什么",',
      '  "tags": ["2-4 个短标签"],',
      '  "keywords": ["3-6 个可用于检索的关键词"],',
      '  "priority": "high / medium / low，待办按紧迫程度判断，非待办一般为 medium",',
      '  "due_date": "若明确提到时间就换算成 YYYY-MM-DD，否则 null",',
      '  "actionable": true 或 false，是否包含需要执行的动作',
      '}',
      '',
      '笔记原文：',
      '"""',
      content.slice(0, 4000),
      '"""',
    ].join('\n');
    const raw = await callLLM({ system: SYS_ORGANIZER, user, json: true, temperature: 0.2 });
    return parseJson(raw) || {};
  }

  function fallbackTitle(text) {
    const line = String(text).trim().split(/\r?\n/)[0];
    return line.length > 24 ? line.slice(0, 24) + '…' : line || '未命名记录';
  }
  function guessKind(text) {
    return /(要|需|记得|别忘|待办|todo|提醒|明天|后天|本周|下周|截止|之前|deadline)/i.test(text) ? 'todo' : 'idea';
  }

  /* ---------------- 数据读写 ---------------- */
  async function loadNotes() {
    state.loading = true;
    renderList();
    const { data, error } = await cloud.database
      .from('notes').select('*').order('created_at', { ascending: false }).limit(500);
    state.loading = false;
    if (error) {
      console.warn('[notes]', error);
      toast(error.code === '42P01' ? '数据表尚未就绪' : '记录加载失败：' + (error.message || '未知错误'), true);
      state.notes = [];
    } else {
      state.notes = data || [];
    }
    renderAll();
  }

  async function loadReports() {
    const { data, error } = await cloud.database
      .from('reports').select('*').order('created_at', { ascending: false }).limit(30);
    if (!error) state.reports = data || [];
    renderReports();
  }

  async function loadChat() {
    if (!state.conversationId) return;
    const { data, error } = await cloud.database
      .from('chat_messages').select('*')
      .eq('conversation_id', state.conversationId)
      .order('created_at', { ascending: true }).limit(40);
    if (!error) {
      state.chat = (data || []).map((m) => ({ role: m.role, content: m.content, citations: m.citations || [] }));
    }
    renderChat();
  }

  async function createNote(text) {
    const content = String(text || '').trim();
    if (!content) return;
    const btn = $('saveNoteBtn');
    busy(btn, true);
    try {
      const payload = {
        content,
        title: fallbackTitle(content),
        kind: guessKind(content),
        status: 'open',
        priority: 'medium',
      };
      if (state.session && state.session.user && state.session.user.name) payload.owner_name = state.session.user.name;
      const { data, error } = await cloud.database.from('notes').insert(payload).select();
      if (error) {
        toast(error.code === '42501' ? '没有写入权限，请重新登录' : '保存失败：' + (error.message || ''), true);
        return;
      }
      const created = (data && data[0]) || null;
      if (!created) { toast('保存未生效，请重试', true); return; }
      state.notes.unshift(created);
      state.filter = 'all';
      state.q = '';
      document.querySelectorAll('#filterChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === 'all'));
      $('searchInput').value = '';
      $('searchClear').classList.add('hidden');
      $('composerInput').value = '';
      autoGrow();
      renderAll();
      toast('已保存，正在智能整理…');
      enrichNote(created);
    } finally {
      busy(btn, false);
    }
  }

  function relatedWithReason(note) {
    if (!note) return [];
    const tagsA = new Set((note.tags || []).map((t) => t.toLowerCase()));
    const kwA = new Set((note.keywords || []).map((t) => t.toLowerCase()));
    const tkA = new Set(tokens(`${note.title || ''} ${note.content || ''}`));
    const out = [];
    for (const other of state.notes) {
      if (other.id === note.id) continue;
      let score = 0;
      const reasons = [];
      const sharedTags = (other.tags || []).filter((t) => tagsA.has(String(t).toLowerCase()));
      if (sharedTags.length) { score += sharedTags.length * 3; reasons.push('标签：' + sharedTags.slice(0, 2).join('、')); }
      const sharedKw = (other.keywords || []).filter((t) => kwA.has(String(t).toLowerCase()));
      if (sharedKw.length) { score += sharedKw.length * 2; reasons.push('关键词：' + sharedKw.slice(0, 2).join('、')); }
      if (note.category && other.category && note.category === other.category) { score += 1; reasons.push('同分类「' + note.category + '」'); }
      const tkB = new Set(tokens(`${other.title || ''} ${other.content || ''}`));
      let overlap = 0;
      tkA.forEach((t) => { if (tkB.has(t)) overlap++; });
      if (overlap >= 2) { score += Math.min(overlap, 6) * 0.7; if (!reasons.length) reasons.push('内容用词接近'); }
      if (score >= 2) out.push({ note: other, score, reason: reasons.slice(0, 2).join(' · ') || '内容相关' });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 4);
  }

  async function enrichNote(note) {
    if (!state.modelId) return;
    try {
      const meta = await aiClassify(note.content);
      const patch = {
        title: (meta.title && String(meta.title).slice(0, 40)) || note.title,
        kind: KINDS[meta.kind] ? meta.kind : note.kind,
        category: CATS.includes(meta.category) ? meta.category : (meta.category || '其他'),
        summary: meta.summary ? String(meta.summary).slice(0, 200) : '',
        tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 5).map(String) : [],
        keywords: Array.isArray(meta.keywords) ? meta.keywords.slice(0, 8).map(String) : [],
        priority: PRIOS[meta.priority] ? meta.priority : 'medium',
        due_date: /^\d{4}-\d{2}-\d{2}$/.test(meta.due_date || '') ? meta.due_date : null,
        ai_processed: true,
        updated_at: new Date().toISOString(),
      };
      const { data, error } = await cloud.database.from('notes').update(patch).eq('id', note.id).select();
      if (error) throw error;
      if (!data || !data.length) { toast('整理结果未能写入（可能已被删除）', true); return; }
      let updated = data[0];
      const rel = relatedWithReason(updated);
      if (rel.length) {
        const ids = rel.map((r) => r.note.id);
        const { data: d2 } = await cloud.database.from('notes').update({ related_ids: ids }).eq('id', updated.id).select();
        if (d2 && d2[0]) updated = d2[0];
      }
      const idx = state.notes.findIndex((n) => n.id === updated.id);
      if (idx >= 0) state.notes[idx] = updated; else state.notes.unshift(updated);
      renderAll();
    } catch (e) {
      console.warn('[enrich]', e && (e.code || e.message));
      const code = e && (e.code || (e.error && e.error.code));
      if (code && String(code).indexOf('quota') === 0) toast('模型额度已用尽，本条仅保存原文', true);
      else if (code === 'gateway_stream_interrupted') toast('整理被中断，内容已保存');
      else toast('智能整理暂不可用，内容已保存');
    }
  }

  async function toggleDone(id) {
    const n = state.notes.find((x) => Number(x.id) === Number(id));
    if (!n) return;
    const next = n.status === 'done' ? 'open' : 'done';
    const { data, error } = await cloud.database
      .from('notes').update({ status: next, updated_at: new Date().toISOString() }).eq('id', id).select();
    if (error) { toast('更新失败：' + (error.message || ''), true); return; }
    if (!data || !data.length) { toast('没有更新任何记录（可能不属于你）', true); return; }
    const idx = state.notes.findIndex((x) => x.id === id);
    if (idx >= 0) state.notes[idx] = data[0];
    renderAll();
    if (next === 'done') toast('已完成');
  }

  async function deleteNote(id) {
    const n = state.notes.find((x) => Number(x.id) === Number(id));
    const ok = await confirmDialog('删除记录', `确定删除「${(n && (n.title || n.content)) || '这条记录'}」吗？删除后无法恢复。`, '删除');
    if (!ok) return;
    const { data, error } = await cloud.database.from('notes').delete().eq('id', id).select();
    if (error) { toast('删除失败：' + (error.message || ''), true); return; }
    if (!data || !data.length) { toast('没有删除任何记录（可能不属于你）', true); return; }
    state.notes = state.notes.filter((x) => x.id !== id);
    closeDrawer();
    renderAll();
    toast('已删除');
  }

  /* ---------------- 渲染：列表 ---------------- */
  function filteredNotes() {
    const q = state.q.trim();
    if (q) {
      return state.notes.filter((n) => keywordHit(n, q));
    }
    const f = state.filter;
    if (f === 'done') return state.notes.filter((n) => n.status === 'done');
    if (f === 'todo') return state.notes.filter((n) => n.kind === 'todo' && n.status !== 'done');
    if (f === 'idea') return state.notes.filter((n) => n.kind === 'idea');
    if (f === 'material') return state.notes.filter((n) => n.kind === 'material');
    return state.notes;
  }

  function dueBadge(n) {
    if (!n.due_date) return '';
    const today = todayStr();
    const diff = Math.round((new Date(n.due_date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
    if (n.status === 'done') return `<span class="badge">${escapeHtml(n.due_date)}</span>`;
    if (diff < 0) return `<span class="badge due-over">逾期 ${Math.abs(diff)} 天</span>`;
    if (diff === 0) return `<span class="badge due-soon">今天截止</span>`;
    if (diff <= 3) return `<span class="badge due-soon">${diff} 天后</span>`;
    return `<span class="badge">${escapeHtml(n.due_date)}</span>`;
  }

  function noteCard(n) {
    const rel = (n.related_ids || []).length;
    const body = n.summary || n.content || '';
    const isTodo = n.kind === 'todo';
    const tags = (n.tags || []).slice(0, 3).map((t) => `<span class="tag-pill">#${escapeHtml(t)}</span>`).join('');
    return `
      <article class="note-card ${n.status === 'done' ? 'done' : ''}" data-id="${n.id}">
        <div class="note-top">
          ${isTodo ? `<button class="check ${n.status === 'done' ? 'on' : ''}" data-act="toggle" data-id="${n.id}" title="标记完成">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="m5 12.5 4.2 4.2L19 7"/></svg>
          </button>` : `<span class="check" style="border:none;background:transparent"></span>`}
          <div class="note-body" data-act="open" data-id="${n.id}">
            <h3 class="note-title">${highlight(n.title || fallbackTitle(n.content || ''), state.q)}</h3>
            <p class="${n.summary ? 'note-summary' : 'note-excerpt'}">${highlight(body, state.q)}</p>
            <div class="note-meta">
              <span class="badge ${n.kind}">${KINDS[n.kind] || '想法'}</span>
              ${n.category ? `<span class="badge cat">${escapeHtml(n.category)}</span>` : ''}
              ${isTodo && n.priority === 'high' ? `<span class="badge p-high">高优先</span>` : ''}
              ${isTodo ? dueBadge(n) : ''}
              ${tags}
              ${rel ? `<button class="link-pill" data-act="open" data-id="${n.id}">
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1"/></svg>
                关联 ${rel}</button>` : ''}
              <span class="dot-sep">·</span>
              <span>${fmtTime(n.created_at)}</span>
              ${n.ai_processed ? '' : '<span class="dot-sep">·</span><span>整理中…</span>'}
            </div>
          </div>
          <div class="card-actions">
            <button class="icon-btn" data-act="open" data-id="${n.id}" title="查看详情">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M4 12s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6Z"/><circle cx="12" cy="12" r="2.4"/></svg>
            </button>
            <button class="icon-btn danger" data-act="del" data-id="${n.id}" title="删除">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M5 7h14M10 7V5.5A1.5 1.5 0 0 1 11.5 4h1A1.5 1.5 0 0 1 14 5.5V7M7 7l.8 11a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17 7"/></svg>
            </button>
          </div>
        </div>
      </article>`;
  }

  function renderList() {
    const box = $('noteList');
    if (!box) return;
    if (state.loading && !state.notes.length) {
      box.innerHTML = Array.from({ length: 3 }).map(() => '<div class="skeleton-card"></div>').join('');
      $('listMeta').textContent = '加载中…';
      return;
    }
    const list = filteredNotes();
    if (!list.length) {
      box.innerHTML = `<div class="empty">
        <h3>${state.q ? '没有匹配的记录' : (state.filter === 'all' ? '还没有记录' : '这里还没有内容')}</h3>
        <p>${state.q ? '试试更短的关键词，或换个说法。' : '在上方输入框里记下第一个想法、链接或待办，回车即保存。'}</p>
      </div>`;
      $('listMeta').textContent = state.q ? '0 条匹配' : '0 条记录';
      return;
    }
    box.innerHTML = list.map(noteCard).join('');
    $('listMeta').textContent = state.q
      ? `在 ${state.notes.length} 条记录中找到 ${list.length} 条`
      : `共 ${list.length} 条`;
  }

  /* ---------------- 渲染：待办 ---------------- */
  function renderTodos() {
    const box = $('todoGroups');
    if (!box) return;
    const todos = state.notes.filter((n) => n.kind === 'todo');
    const open = todos.filter((n) => n.status !== 'done');
    const today = todayStr();
    const groups = [
      { key: 'overdue', title: '已逾期', items: [] },
      { key: 'today', title: '今天', items: [] },
      { key: 'week', title: '未来 7 天', items: [] },
      { key: 'later', title: '以后', items: [] },
      { key: 'none', title: '未设时间', items: [] },
      { key: 'done', title: '最近完成', items: [] },
    ];
    open.forEach((n) => {
      if (!n.due_date) { groups[4].items.push(n); return; }
      const diff = Math.round((new Date(n.due_date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
      if (diff < 0) groups[0].items.push(n);
      else if (diff === 0) groups[1].items.push(n);
      else if (diff <= 7) groups[2].items.push(n);
      else groups[3].items.push(n);
    });
    todos.filter((n) => n.status === 'done').slice(0, 5).forEach((n) => groups[5].items.push(n));
    const pr = { high: 0, medium: 1, low: 2 };
    groups.forEach((g) => g.items.sort((a, b) => (pr[a.priority] ?? 1) - (pr[b.priority] ?? 1)));

    if (!todos.length) {
      box.innerHTML = `<div class="empty"><h3>还没有待办</h3><p>记录一条含时间或动作的内容，AI 会自动识别成待办，例如「周五前把方案发给张三」。</p></div>`;
      return;
    }
    box.innerHTML = groups.filter((g) => g.items.length).map((g) => `
      <div class="todo-group">
        <h3 class="${g.key === 'overdue' ? 'overdue' : ''}">${g.title}<span>${g.items.length}</span></h3>
        <div class="note-list">${g.items.map(noteCard).join('')}</div>
      </div>`).join('');
  }

  /* ---------------- 渲染：抽屉 ---------------- */
  function openDrawer(id) {
    const n = state.notes.find((x) => Number(x.id) === Number(id));
    if (!n) return;
    state.currentNoteId = id;
    renderDrawer(n);
    $('scrim').classList.add('show');
    $('drawer').classList.add('show');
  }
  function closeDrawer() {
    state.currentNoteId = null;
    $('scrim').classList.remove('show');
    $('drawer').classList.remove('show');
  }

  function renderDrawer(n) {
    $('drawerTitle').textContent = KINDS[n.kind] || '记录';
    const rel = relatedWithReason(n);
    const explicit = (n.related_ids || []).map((id) => state.notes.find((x) => Number(x.id) === Number(id))).filter(Boolean);
    const seen = new Set();
    const relItems = [];
    explicit.forEach((r) => { if (!seen.has(r.id)) { seen.add(r.id); relItems.push({ note: r, reason: '此前已建立关联' }); } });
    rel.forEach((r) => { if (!seen.has(r.note.id)) { seen.add(r.note.id); relItems.push(r); } });

    $('drawerBody').innerHTML = `
      <h3>${escapeHtml(n.title || fallbackTitle(n.content || ''))}</h3>
      <div class="kv" style="margin-bottom:16px">
        <span class="badge ${n.kind}">${KINDS[n.kind] || '想法'}</span>
        ${n.category ? `<span class="badge cat">${escapeHtml(n.category)}</span>` : ''}
        ${n.kind === 'todo' ? `<span class="badge ${n.priority === 'high' ? 'p-high' : ''}">优先级 ${PRIOS[n.priority] || '中'}</span>` : ''}
        ${dueBadge(n)}
        <span class="dot-sep">·</span><span style="font-size:12px;color:var(--muted)">${fmtTime(n.created_at)}</span>
      </div>

      ${n.summary ? `<div class="drawer-block">
        <div class="drawer-block-title">AI 摘要</div>
        <div class="ai-summary">${escapeHtml(n.summary)}</div>
      </div>` : ''}

      <div class="drawer-block">
        <div class="drawer-block-title">原文</div>
        <div class="drawer-content">${escapeHtml(n.content || '')}</div>
      </div>

      ${(n.tags || []).length ? `<div class="drawer-block">
        <div class="drawer-block-title">标签</div>
        <div class="kv">${(n.tags || []).map((t) => `<span class="tag-pill">#${escapeHtml(t)}</span>`).join('')}</div>
      </div>` : ''}

      <div class="drawer-block">
        <div class="drawer-block-title">
          <span>重点信息</span>
          <button class="btn ghost" style="height:26px;padding:0 9px;font-size:12px" id="extractBtn">${(n.highlights || []).length ? '重新提取' : 'AI 提取重点'}</button>
        </div>
        ${(n.highlights || []).length
          ? `<ul class="hi-list">${(n.highlights || []).map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul>`
          : `<p style="color:var(--muted);font-size:12.5px;margin:0">从这段内容里抽出值得记住的要点与需要跟进的事项。</p>`}
      </div>

      <div class="drawer-block">
        <div class="drawer-block-title"><span>相关内容 ${relItems.length ? '(' + relItems.length + ')' : ''}</span></div>
        ${relItems.length ? `<div class="rel-list">${relItems.map((r) => `
          <button class="rel-item" data-open="${r.note.id}">
            <span class="rel-dot"></span>
            <span class="rel-main">
              <span class="rel-title">${escapeHtml(r.note.title || fallbackTitle(r.note.content || ''))}</span>
              <span class="rel-why">${escapeHtml(r.reason)}</span>
            </span>
          </button>`).join('')}</div>`
          : `<p style="color:var(--muted);font-size:12.5px;margin:0">暂时没有找到明显相关的内容，多记几条后关联会更准。</p>`}
      </div>

      <div class="drawer-foot">
        ${n.kind === 'todo' ? `<button class="btn ${n.status === 'done' ? 'ghost' : 'primary'}" data-act="toggle" data-id="${n.id}">${n.status === 'done' ? '恢复为未完成' : '标记完成'}</button>` : ''}
        <button class="btn ghost" id="splitTodoBtn">拆成待办</button>
        <button class="btn ghost" data-act="del" data-id="${n.id}" style="color:var(--red)">删除</button>
      </div>
    `;

    const ex = $('extractBtn');
    if (ex) ex.onclick = () => extractHighlights(n);
    const sp = $('splitTodoBtn');
    if (sp) sp.onclick = () => splitIntoTodos(n);
    $('drawerBody').querySelectorAll('[data-open]').forEach((b) => {
      b.onclick = () => openDrawer(Number(b.dataset.open));
    });
  }

  /* ---------------- AI：重点提取 / 拆待办 ---------------- */
  async function extractHighlights(n) {
    const btn = $('extractBtn');
    busy(btn, true);
    try {
      const raw = await callLLM({
        system: SYS_ORGANIZER,
        json: true,
        temperature: 0.2,
        user: [
          '请从下面这条个人笔记中提取重点信息，返回 JSON：',
          '{"highlights": ["3-5 条要点，每条不超过 30 字，保留关键数字/人名/时间"]}',
          '笔记原文：',
          '"""',
          (n.content || '').slice(0, 4000),
          '"""',
        ].join('\n'),
      });
      const parsed = parseJson(raw);
      const list = (parsed && Array.isArray(parsed.highlights)) ? parsed.highlights.slice(0, 6).map((x) => String(x).slice(0, 80)) : [];
      if (!list.length) { toast('没有提取到明确的重点'); return; }
      const { data, error } = await cloud.database.from('notes')
        .update({ highlights: list, updated_at: new Date().toISOString() }).eq('id', n.id).select();
      if (error) throw error;
      if (data && data[0]) {
        const idx = state.notes.findIndex((x) => x.id === n.id);
        if (idx >= 0) state.notes[idx] = data[0];
        renderAll();
        renderDrawer(data[0]);
        toast('已提取 ' + list.length + ' 条重点');
      }
    } catch (e) {
      toast('提取失败：' + (e && e.message ? e.message : '模型暂不可用'), true);
    } finally {
      busy(btn, false);
    }
  }

  async function splitIntoTodos(n) {
    const btn = $('splitTodoBtn');
    busy(btn, true);
    try {
      const raw = await callLLM({
        system: SYS_ORGANIZER,
        json: true,
        temperature: 0.2,
        user: [
          '把下面这条笔记里隐含的可执行动作拆成待办，返回 JSON：',
          '{"todos": [{"task": "具体动作，不超过 30 字", "priority": "high/medium/low", "due_date": "YYYY-MM-DD 或 null"}]}',
          '如果没有可执行动作，返回 {"todos": []}。最多 5 条。',
          '笔记原文：',
          '"""',
          (n.content || '').slice(0, 4000),
          '"""',
        ].join('\n'),
      });
      const parsed = parseJson(raw);
      const todos = (parsed && Array.isArray(parsed.todos)) ? parsed.todos.filter((t) => t && t.task).slice(0, 5) : [];
      if (!todos.length) { toast('这条记录里没有可执行的动作'); return; }
      const ownerName = state.session && state.session.user && state.session.user.name;
      const rows = todos.map((t) => {
        const row = {
          content: `${t.task}`,
          title: String(t.task).slice(0, 40),
          kind: 'todo',
          status: 'open',
          priority: PRIOS[t.priority] ? t.priority : 'medium',
          category: n.category || '工作',
          summary: `由「${(n.title || '').slice(0, 20)}」拆分而来`,
          tags: (n.tags || []).slice(0, 2),
          keywords: (n.keywords || []).slice(0, 4),
          related_ids: [n.id],
          ai_processed: true,
          due_date: /^\d{4}-\d{2}-\d{2}$/.test(t.due_date || '') ? t.due_date : null,
        };
        if (ownerName) row.owner_name = ownerName;
        return row;
      });
      const { data, error } = await cloud.database.from('notes').insert(rows).select();
      if (error) throw error;
      const created = data || [];
      state.notes.unshift(...created);
      renderAll();
      if (state.view === 'todos') renderTodos();
      toast(`已生成 ${created.length} 条待办`);
      closeDrawer();
    } catch (e) {
      toast('拆分失败：' + (e && e.message ? e.message : '模型暂不可用'), true);
    } finally {
      busy(btn, false);
    }
  }

  /* ---------------- AI：待办计划 ---------------- */
  async function generateTodoAdvice() {
    const open = state.notes.filter((n) => n.kind === 'todo' && n.status !== 'done');
    if (!open.length) { toast('当前没有未完成的待办'); return; }
    const btn = $('adviceBtn');
    busy(btn, true);
    try {
      const digest = open.slice(0, 25).map((n, i) =>
        `${i + 1}. ${n.title || n.content}（优先级${PRIOS[n.priority] || '中'}${n.due_date ? '，截止 ' + n.due_date : ''}${n.category ? '，' + n.category : ''}）`
      ).join('\n');
      const raw = await callLLM({
        system: SYS_ORGANIZER,
        json: true,
        temperature: 0.3,
        user: [
          '今天是 ' + todayStr() + '。下面是用户未完成的待办，请排出今天最值得做的 3-5 件事，返回 JSON：',
          '{"plan": [{"task": "要做的事", "why": "为什么先做它，一句话", "next": "立刻可以做的最小一步"}], "note": "一句提醒，不超过 40 字"}',
          '',
          digest,
        ].join('\n'),
      });
      const parsed = parseJson(raw);
      const plan = (parsed && Array.isArray(parsed.plan)) ? parsed.plan.slice(0, 5) : [];
      if (!plan.length) { toast('没有生成有效的计划'); return; }
      const box = $('adviceBox');
      box.innerHTML = `<h4>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 3v2M12 19v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M3 12h2M19 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/><circle cx="12" cy="12" r="3.2"/></svg>
        今日建议（基于 ${open.length} 条未完成待办）</h4>
        <ol>${plan.map((p) => `<li><b>${escapeHtml(p.task || '')}</b><div class="why">${escapeHtml(p.why || '')}${p.next ? ' · 先做：' + escapeHtml(p.next) : ''}</div></li>`).join('')}</ol>
        ${parsed.note ? `<div class="advice-foot">${escapeHtml(parsed.note)}</div>` : ''}`;
      box.classList.remove('hidden');
    } catch (e) {
      toast('生成失败：' + (e && e.message ? e.message : '模型暂不可用'), true);
    } finally {
      busy(btn, false);
    }
  }

  /* ---------------- AI：问答 ---------------- */
  function retrieveForQuestion(q, limit) {
    const qt = new Set(tokens(q));
    const scored = state.notes.map((n) => {
      let s = 0;
      const text = `${n.title || ''} ${n.content || ''} ${n.summary || ''} ${(n.tags || []).join(' ')} ${(n.keywords || []).join(' ')}`;
      const nt = new Set(tokens(text));
      qt.forEach((t) => { if (nt.has(t)) s += 1; });
      if (n.title && q && n.title.indexOf(q) >= 0) s += 3;
      if (n.status !== 'done') s += 0.2;
      return { n, s };
    }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit);
    return scored.map((x) => x.n);
  }

  function renderChat() {
    const log = $('chatLog');
    if (!log) return;
    if (!state.chat.length) {
      log.innerHTML = `<div class="empty" style="border-style:solid">
        <h3>问点什么吧</h3>
        <p>我会从你已有的记录里找答案，并标出引用来源。记录越多，回答越准。</p>
      </div>`;
      return;
    }
    log.innerHTML = state.chat.map((m, i) => {
      const mine = m.role === 'user';
      const cites = (m.citations || []).map((id) => {
        const n = state.notes.find((x) => Number(x.id) === Number(id));
        if (!n) return '';
        return `<button class="link-pill" data-open="${id}" style="margin-top:8px">${escapeHtml((n.title || n.content || '').slice(0, 18))}</button>`;
      }).join(' ');
      return `<div class="msg ${mine ? 'user' : 'assistant'}">
        <div class="avatar">${mine ? escapeHtml(((state.session && state.session.user && state.session.user.name) || '我').slice(0, 1)) : 'AI'}</div>
        <div class="bubble" data-idx="${i}">${mine ? escapeHtml(m.content) : mdToHtml(m.content)}${cites ? `<div style="margin-top:6px">${cites}</div>` : ''}</div>
      </div>`;
    }).join('');
    bindMessageActions(log);
    scrollChat();
  }

  function bindMessageActions(log) {
    log.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => openDrawer(Number(b.dataset.open)); });
    log.querySelectorAll('.bubble[data-idx]').forEach((b) => {
      const msg = state.chat[Number(b.dataset.idx)];
      const cits = (msg && msg.citations) || [];
      b.querySelectorAll('[data-cite]').forEach((c) => {
        const target = cits[Number(c.dataset.cite) - 1];
        if (target == null) { c.style.opacity = '.5'; return; }
        c.onclick = () => openDrawer(Number(target));
      });
    });
  }

  function scrollChat() {
    const v = $('view-chat');
    if (v) v.scrollTop = v.scrollHeight;
  }

  async function askQuestion(q) {
    const question = String(q || '').trim();
    if (!question || state.chatBusy) return;
    if (!state.modelId) { toast('模型尚未就绪，请稍后重试', true); return; }
    state.chatBusy = true;
    $('chatInput').value = '';
    state.chat.push({ role: 'user', content: question, citations: [] });
    const reply = { role: 'assistant', content: '', citations: [] };
    state.chat.push(reply);
    renderChat();
    const log = $('chatLog');
    const last = log.lastElementChild;
    const bubble = last ? last.querySelector('.bubble') : null;
    if (bubble) bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    $('chatSend').disabled = true;

    try {
      const ctxNotes = retrieveForQuestion(question, 8);
      reply.citations = ctxNotes.map((n) => n.id);
      const ctx = ctxNotes.length
        ? ctxNotes.map((n, i) => `[${i + 1}] ${n.title || '未命名'}（${KINDS[n.kind] || ''}${n.category ? '/' + n.category : ''}，${fmtTime(n.created_at)}${n.status === 'done' ? '，已完成' : ''}）\n${(n.summary || n.content || '').slice(0, 380)}`).join('\n\n')
        : '（没有任何相关记录）';
      const system = SYS_TUTOR + '\n如果提供了笔记，请在相关句子后用 [编号] 标注引用；没有可用笔记时直接说明记录中没有相关内容。';
      let acc = '';
      await callLLM({
        system,
        temperature: 0.3,
        conversationId: state.conversationId,
        user: `我的笔记：\n${ctx}\n\n我的问题：${question}`,
        onDelta: (text) => {
          acc = text;
          if (bubble) bubble.innerHTML = mdToHtml(text);
          scrollChat();
        },
      });
      reply.content = acc || '（没有返回内容）';
      if (bubble) {
        bubble.innerHTML = mdToHtml(reply.content);
        const chips = (reply.citations || []).map((id) => {
          const n = state.notes.find((x) => Number(x.id) === Number(id));
          return n ? `<button class="link-pill" data-open="${id}" style="margin-top:8px">${escapeHtml((n.title || n.content || '').slice(0, 18))}</button>` : '';
        }).join(' ');
        if (chips) bubble.insertAdjacentHTML('beforeend', `<div style="margin-top:6px">${chips}</div>`);
        bubble.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => openDrawer(Number(b.dataset.open)); });
        bubble.querySelectorAll('[data-cite]').forEach((c) => {
          const target = (reply.citations || [])[Number(c.dataset.cite) - 1];
          if (target == null) { c.style.opacity = '.5'; return; }
          c.onclick = () => openDrawer(Number(target));
        });
      }
      persistChat('user', question, []);
      persistChat('assistant', reply.content, reply.citations);
    } catch (e) {
      const code = e && (e.code || (e.error && e.error.code)) || '';
      const msg = code.indexOf('quota') === 0 ? '模型额度已用尽，请稍后再试。'
        : code === 'gateway_stream_interrupted' ? '回答被中断了，可以重新提问。'
          : '回答失败：' + (e && e.message ? e.message : '网络异常');
      reply.content = reply.content || msg;
      if (bubble) bubble.innerHTML = mdToHtml(reply.content);
      toast(msg, true);
    } finally {
      state.chatBusy = false;
      $('chatSend').disabled = false;
      scrollChat();
    }
  }

  async function persistChat(role, content, citations) {
    if (!state.conversationId) return;
    try {
      await cloud.database.from('chat_messages').insert({
        conversation_id: state.conversationId,
        role, content, citations: citations || [],
      });
    } catch (e) {
      console.warn('[chat persist]', e && e.message);
    }
  }

  /* ---------------- AI：阶段总结 ---------------- */
  function periodRange(period) {
    const now = new Date();
    const end = now;
    let start;
    if (period === 'week') {
      start = new Date(now); start.setDate(now.getDate() - 6); start.setHours(0, 0, 0, 0);
    } else if (period === 'month') {
      start = new Date(now); start.setDate(now.getDate() - 29); start.setHours(0, 0, 0, 0);
    } else {
      start = new Date(0);
    }
    return { start, end };
  }

  async function generateReport() {
    const period = state.period;
    const { start, end } = periodRange(period);
    const inRange = state.notes.filter((n) => new Date(n.created_at) >= start);
    if (!inRange.length) { toast('这个时间段还没有记录，先记几条再生成'); return; }
    const btn = $('genReportBtn');
    busy(btn, true);
    try {
      const label = period === 'week' ? '最近 7 天' : period === 'month' ? '最近 30 天' : '全部记录';
      const digest = inRange.slice(0, 80).map((n, i) =>
        `${i + 1}. [${KINDS[n.kind] || '记录'}${n.category ? '/' + n.category : ''}${n.status === 'done' ? '/已完成' : ''}] ${n.title || ''} —— ${(n.summary || n.content || '').slice(0, 160)}${n.due_date ? '（截止 ' + n.due_date + '）' : ''}`
      ).join('\n');
      const raw = await callLLM({
        system: SYS_ORGANIZER,
        json: true,
        temperature: 0.4,
        user: [
          `今天是 ${todayStr()}。下面是用户${label}的 ${inRange.length} 条笔记摘要。请做一次阶段复盘，返回 JSON：`,
          '{',
          '  "title": "总结标题，不超过 20 字",',
          '  "overview": "3-4 句话的整体概览，说清楚这段时间关注了什么、推进了什么",',
          '  "themes": [{"name": "主题名", "note": "这个主题下发生了什么，一句话"}],',
          '  "highlights": ["3-5 条值得记住的进展或结论"],',
          '  "actions": [{"task": "下一步具体动作", "why": "为什么", "when": "本周/两周内/本月"}],',
          '  "risk": "一句风险或需要注意的地方，没有就返回空字符串"',
          '}',
          '要求：只依据给出的笔记，不要编造未出现的内容；actions 给 3 条，必须具体可执行。',
          '',
          '笔记清单：',
          digest,
        ].join('\n'),
      });
      const parsed = parseJson(raw);
      if (!parsed || !parsed.overview) { toast('生成结果解析失败，请重试', true); return; }
      const row = {
        period,
        title: String(parsed.title || `${label}复盘`).slice(0, 60),
        content: JSON.stringify({
          overview: parsed.overview,
          themes: Array.isArray(parsed.themes) ? parsed.themes.slice(0, 6) : [],
          highlights: Array.isArray(parsed.highlights) ? parsed.highlights.slice(0, 8) : [],
          risk: parsed.risk || '',
        }),
        actions: Array.isArray(parsed.actions) ? parsed.actions.slice(0, 5) : [],
        note_count: inRange.length,
        range_start: start.toISOString(),
        range_end: end.toISOString(),
      };
      if (state.session && state.session.user && state.session.user.name) row.owner_name = state.session.user.name;
      const { data, error } = await cloud.database.from('reports').insert(row).select();
      if (error) throw error;
      if (data && data[0]) state.reports.unshift(data[0]);
      renderReports();
      $('countReports').textContent = state.reports.length;
      toast('阶段总结已生成并保存');
      $('view-reports').scrollTop = 0;
    } catch (e) {
      toast('生成失败：' + (e && e.message ? e.message : '模型暂不可用'), true);
    } finally {
      busy(btn, false);
    }
  }

  function renderReports() {
    const box = $('reportList');
    if (!box) return;
    if (!state.reports.length) {
      box.innerHTML = `<div class="empty"><h3>还没有阶段总结</h3><p>选择时间范围后点「生成总结」，AI 会回顾你的记录，给出主题脉络与下一步行动。</p></div>`;
      return;
    }
    box.innerHTML = state.reports.map((r) => {
      let body = {};
      try { body = JSON.parse(r.content || '{}'); } catch (e) { body = { overview: r.content || '' }; }
      const actions = Array.isArray(r.actions) ? r.actions : [];
      const themes = Array.isArray(body.themes) ? body.themes : [];
      const highlights = Array.isArray(body.highlights) ? body.highlights : [];
      const periodLabel = r.period === 'week' ? '周总结' : r.period === 'month' ? '月总结' : '全量复盘';
      return `<article class="report-card">
        <div class="report-head">
          <div>
            <h3>${escapeHtml(r.title || '阶段总结')}</h3>
            <div class="report-date">${fmtTime(r.created_at)} · 基于 ${r.note_count || 0} 条记录</div>
          </div>
          <span class="period-tag">${periodLabel}</span>
        </div>
        <div class="report-body">
          <p>${escapeHtml(body.overview || '')}</p>
          ${themes.length ? `<div class="report-section-title">关注的主题</div><ul>${themes.map((t) => `<li><strong>${escapeHtml(t.name || '')}</strong> ${escapeHtml(t.note || '')}</li>`).join('')}</ul>` : ''}
          ${highlights.length ? `<div class="report-section-title">值得记住的进展</div><ul>${highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul>` : ''}
          ${body.risk ? `<div class="report-section-title">需要注意</div><p style="color:#b45309">${escapeHtml(body.risk)}</p>` : ''}
          ${actions.length ? `<div class="report-section-title">下一步行动</div><div class="action-list">${actions.map((a, i) => `
            <div class="action-item"><span class="action-num">${i + 1}</span>
              <div><b>${escapeHtml(a.task || '')}</b><div class="why">${escapeHtml(a.why || '')}${a.when ? ' · ' + escapeHtml(a.when) : ''}</div></div>
            </div>`).join('')}</div>` : ''}
        </div>
      </article>`;
    }).join('');
  }

  /* ---------------- 视图切换 & 汇总渲染 ---------------- */
  function renderAll() {
    const openNotes = state.notes.filter((n) => n.status !== 'done');
    $('countInbox').textContent = openNotes.length;
    $('countTodo').textContent = state.notes.filter((n) => n.kind === 'todo' && n.status !== 'done').length;
    $('countReports').textContent = state.reports.length;
    renderList();
    renderTodos();
    renderChat();
    renderReports();
    if (state.currentNoteId) {
      const n = state.notes.find((x) => x.id === state.currentNoteId);
      if (n) renderDrawer(n); else closeDrawer();
    }
  }

  function switchView(view) {
    state.view = view;
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    const el = $('view-' + view);
    if (el) el.classList.remove('hidden');
    $('sidebar').classList.remove('open');
    if (view === 'inbox') setTimeout(() => $('composerInput').focus(), 50);
    if (view === 'chat') scrollChat();
  }

  /* ---------------- 事件绑定 ---------------- */
  function autoGrow() {
    const t = $('composerInput');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 320) + 'px';
  }

  function bindEvents() {
    // 登录
    $('loginTabs').addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn');
      if (b) switchLoginMode(b.dataset.mode);
    });
    $('loginId').addEventListener('input', () => {
      if (state.pendingOtp && $('loginId').value.trim() !== state.pendingOtp.id) state.pendingOtp = null;
      setLoginMsg('');
    });
    $('sendCodeBtn').addEventListener('click', sendCode);
    $('loginForm').addEventListener('submit', submitLogin);
    $('wechatBtn').addEventListener('click', wechatLogin);
    $('logoutBtn').addEventListener('click', logout);

    // 导航
    $('nav').addEventListener('click', (e) => {
      const b = e.target.closest('.nav-item');
      if (b) switchView(b.dataset.view);
    });
    $('menuBtn').addEventListener('click', () => $('sidebar').classList.toggle('open'));

    // 搜索
    let searchTimer = null;
    $('searchInput').addEventListener('input', (e) => {
      state.q = e.target.value;
      $('searchClear').classList.toggle('hidden', !state.q);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        if (state.view !== 'inbox') switchView('inbox');
        renderList();
      }, 120);
    });
    $('searchClear').addEventListener('click', () => {
      state.q = ''; $('searchInput').value = '';
      $('searchClear').classList.add('hidden');
      renderList();
    });

    // 输入
    $('composerInput').addEventListener('input', autoGrow);
    $('composerInput').addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); createNote($('composerInput').value); }
    });
    $('saveNoteBtn').addEventListener('click', () => createNote($('composerInput').value));
    $('quickAddBtn').addEventListener('click', () => {
      switchView('inbox');
      $('composerInput').focus();
      $('view-inbox').scrollTop = 0;
    });

    // 过滤
    $('filterChips').addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      state.filter = b.dataset.filter;
      document.querySelectorAll('#filterChips .chip').forEach((c) => c.classList.toggle('active', c === b));
      renderList();
    });

    // 列表 & 待办交互（事件委托）
    ['noteList', 'todoGroups'].forEach((containerId) => {
      $(containerId).addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]');
        if (!act) return;
        const id = Number(act.dataset.id);
        if (act.dataset.act === 'toggle') { e.stopPropagation(); toggleDone(id); return; }
        if (act.dataset.act === 'del') { e.stopPropagation(); deleteNote(id); return; }
        if (act.dataset.act === 'open') { e.stopPropagation(); openDrawer(id); }
      });
    });

    // 抽屉
    $('drawerClose').addEventListener('click', closeDrawer);
    $('scrim').addEventListener('click', closeDrawer);
    $('drawerBody').addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      const id = Number(t.dataset.id);
      if (t.dataset.act === 'toggle') { toggleDone(id); return; }
      if (t.dataset.act === 'del') { deleteNote(id); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeDrawer(); $('sidebar').classList.remove('open'); }
    });

    // 待办建议
    $('adviceBtn').addEventListener('click', generateTodoAdvice);

    // 问答
    $('chatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      askQuestion($('chatInput').value);
    });
    $('chatSuggest').addEventListener('click', (e) => {
      const b = e.target.closest('.suggest');
      if (b) askQuestion(b.dataset.q);
    });
    $('clearChatBtn').addEventListener('click', async () => {
      const ok = await confirmDialog('清空对话', '这会开启一段新对话，历史记录仍保存在云端，但当前窗口不再显示。', '清空');
      if (!ok) return;
      const uid = (state.session && state.session.user && (state.session.user.id || state.session.user.userId)) || 'me';
      state.conversationId = newConversationId(uid);
      state.chat = [];
      renderChat();
      toast('已开启新对话');
    });

    // 总结
    $('periodSeg').addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn');
      if (!b) return;
      state.period = b.dataset.period;
      document.querySelectorAll('#periodSeg .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    });
    $('genReportBtn').addEventListener('click', generateReport);
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    if (!initCloud()) {
      showLogin();
      setLoginMsg('云端 SDK 加载失败，请检查网络后刷新页面');
      return;
    }
    bindEvents();
    restoreAuth();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
