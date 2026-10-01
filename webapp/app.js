(function () {
  'use strict';

  var initData = window.__TOTP_INIT__ || (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) || '';
  // dentro Telegram usiamo le API della WebApp; nel browser la sessione è il cookie
  var tg = initData ? window.Telegram.WebApp : null;
  var IN_TELEGRAM = !!tg;
  var $ = function (id) { return document.getElementById(id); };
  document.documentElement.classList.toggle('is-web', !IN_TELEGRAM);

  function tgAtLeast(v) {
    try { return !!(tg && tg.isVersionAtLeast && tg.isVersionAtLeast(v)); } catch (e) { return false; }
  }
  function haptic(type) {
    try { if (tgAtLeast('6.1')) tg.HapticFeedback.notificationOccurred(type); } catch (e) {}
  }
  function tapHaptic() {
    try { if (tgAtLeast('6.1')) tg.HapticFeedback.impactOccurred('light'); } catch (e) {}
  }
  var escHtml = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var ICON = {
    edit: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
    folder: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>',
    down: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>',
    up: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></svg>',
    copy: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    scan: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/></svg>',
    lock: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
    out: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>',
    key: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2 2"/></svg>',
    globe: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  };

  // ================= TEMI =================
  var THEMES = ['auto', 'aurora', 'sky', 'peach', 'mint', 'pearl', 'midnight'];
  var THEME_KEY = 'totp_theme';

  function savedTheme() {
    try { var t = localStorage.getItem(THEME_KEY); if (THEMES.indexOf(t) !== -1) return t; } catch (e) {}
    return 'auto';
  }
  function resolveTheme(t) {
    if (t !== 'auto') return t;
    var dark = IN_TELEGRAM ? tg.colorScheme === 'dark'
      : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    return dark ? 'midnight' : 'aurora';
  }
  function applyTheme(t) {
    var real = resolveTheme(t);
    document.documentElement.setAttribute('data-theme', real);
    var bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    try { if (tgAtLeast('6.1') && bg) { tg.setHeaderColor(bg); tg.setBackgroundColor(bg); } } catch (e) {}
    try { if (tgAtLeast('7.10') && bg) tg.setBottomBarColor(bg); } catch (e) {}
    var btns = document.querySelectorAll('#themes button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].dataset.theme === t);
  }
  var currentTheme = savedTheme();
  applyTheme(currentTheme);
  if (tg && tg.onEvent) tg.onEvent('themeChanged', function () { if (currentTheme === 'auto') applyTheme('auto'); });

  $('themeBtn').addEventListener('click', function () { tapHaptic(); $('themes').hidden = !$('themes').hidden; });
  $('themes').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-theme]');
    if (!b) return;
    currentTheme = b.dataset.theme;
    try { localStorage.setItem(THEME_KEY, currentTheme); } catch (err) {}
    applyTheme(currentTheme);
    tapHaptic();
  });

  // ================= UTIL =================
  var toastTimer = null;
  function toast(text, isErr) {
    var t = $('toast');
    t.textContent = text;
    t.classList.toggle('err', !!isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    ta.remove();
    return ok;
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function askConfirm(msg) {
    return new Promise(function (resolve) {
      if (tgAtLeast('6.2')) {
        try { tg.showConfirm(msg, function (ok) { resolve(!!ok); }); return; } catch (e) {}
      }
      resolve(window.confirm(msg));
    });
  }

  function api(path, body) {
    var payload = Object.assign(initData ? { initData: initData } : {}, body || {});
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    }).then(function (res) {
      if (res.status === 403 && !IN_TELEGRAM) { location.reload(); return new Promise(function () {}); } // sessione scaduta
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var err = new Error(data.error || ('HTTP ' + res.status)); err.data = data; throw err; }
        return data;
      });
    });
  }

  // colore di fallback deterministico per servizi senza logo
  function hashGradient(text) {
    var h = 0, s = String(text || '').toLowerCase();
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return 'linear-gradient(135deg, hsl(' + h + ',70%,58%), hsl(' + ((h + 40) % 360) + ',72%,46%))';
  }

  // ================= STATO =================
  var listEl = $('list');
  var accounts = [];
  var categories = [];
  var activeCat = '';           // '' = tutte, '\u0000none' = senza categoria
  var NONE = '\u0000none';
  var loading = false;
  var RING_C = 2 * Math.PI * 16;

  function splitName(a) {
    var idx = a.name.indexOf(':');
    if (idx > 0) return [a.name.slice(0, idx), a.name.slice(idx + 1) || a.issuer || ''];
    return [a.name, a.issuer || ''];
  }
  function byId(id) {
    for (var i = 0; i < accounts.length; i++) if (accounts[i].id === id) return accounts[i];
    return null;
  }

  function updateSubtitle() {
    var n = accounts.length;
    $('subtitle').textContent = n === 0 ? 'Vault privato · vuoto' : (n + ' account · vault privato cifrato');
  }

  function skeleton() {
    listEl.innerHTML = '<div class="glass skeleton"></div><div class="glass skeleton"></div>';
  }

  // ================= CHIP CATEGORIE =================
  function renderChips() {
    var el = $('chips');
    if (!categories.length) { el.innerHTML = ''; return; }
    if (activeCat && activeCat !== NONE && categories.indexOf(activeCat) === -1) activeCat = '';
    var none = accounts.filter(function (a) { return !a.tags.length; }).length;
    var html = '<button class="chip' + (activeCat === '' ? ' active' : '') + '" data-cat="">Tutti <span class="n">' + accounts.length + '</span></button>';
    categories.forEach(function (c) {
      var n = accounts.filter(function (a) { return a.tags.indexOf(c) !== -1; }).length;
      html += '<button class="chip' + (activeCat === c ? ' active' : '') + '" data-cat="' + escHtml(c) + '">' + escHtml(c) + ' <span class="n">' + n + '</span></button>';
    });
    if (none) html += '<button class="chip' + (activeCat === NONE ? ' active' : '') + '" data-cat="' + NONE + '">Senza categoria <span class="n">' + none + '</span></button>';
    html += '<button class="chip ghost" data-manage>＋ Gestisci</button>';
    el.innerHTML = html;
  }
  $('chips').addEventListener('click', function (e) {
    var b = e.target.closest('.chip');
    if (!b) return;
    tapHaptic();
    if (b.hasAttribute('data-manage')) return openCategories();
    activeCat = b.getAttribute('data-cat');
    renderChips();
    render();
  });

  // ================= LISTA =================
  function render() {
    var q = ($('search').value || '').trim().toLowerCase();
    var shown = accounts.filter(function (a) {
      if (activeCat === NONE && a.tags.length) return false;
      if (activeCat && activeCat !== NONE && a.tags.indexOf(activeCat) === -1) return false;
      return !q || (a.name + ' ' + (a.issuer || '') + ' ' + a.tags.join(' ')).toLowerCase().indexOf(q) !== -1;
    });

    if (!accounts.length) {
      listEl.innerHTML =
        '<div class="glass empty">' +
        '<div class="empty-ico">' + ICON.scan + '</div>' +
        '<h3>Il tuo vault è vuoto</h3><p>Scansiona il QR code di attivazione 2FA, aggiungi il secret a mano<br>oppure importa un backup (menu ⋯).</p></div>';
      return;
    }
    if (!shown.length) {
      listEl.innerHTML = '<div class="glass empty"><h3>Nessun risultato</h3><p>Nessun account corrisponde al filtro.</p></div>';
      return;
    }

    listEl.innerHTML = shown.map(function (a, i) {
      var parts = splitName(a);
      var title = parts[0], sub = parts[1];
      var letter = escHtml((title || '?').trim().charAt(0).toUpperCase() || '?');
      var bg = a.color ? ('linear-gradient(135deg, ' + a.color + ', ' + a.color + ')') : hashGradient(title);
      var tags = a.tags.length ? '<div class="tags">' + a.tags.map(function (t) { return '<span class="tag">' + escHtml(t) + '</span>'; }).join('') + '</div>' : '';
      return '' +
        '<article class="card glass" data-id="' + escHtml(a.id) + '" style="animation-delay:' + Math.min(i * 40, 400) + 'ms">' +
          '<div class="card-top">' +
            '<div class="icon" style="background:' + bg + '">' +
              (a.icon ? '<img src="/icon/' + escHtml(a.icon) + '.svg" alt="" data-fallback="' + letter + '">' : '<span>' + letter + '</span>') +
            '</div>' +
            '<div class="meta"><div class="name">' + escHtml(title) + '</div><div class="issuer">' + escHtml(sub) + '</div>' + tags + '</div>' +
            '<div class="ring" data-ring>' +
              '<svg width="42" height="42"><circle class="ring-bg" cx="21" cy="21" r="16"/>' +
              '<circle class="ring-fg" data-arc cx="21" cy="21" r="16" stroke-dasharray="' + RING_C + '" stroke-dashoffset="0"/></svg>' +
              '<div class="ring-num" data-num></div>' +
            '</div>' +
            '<button class="edit" data-edit aria-label="Modifica">' + ICON.edit + '</button>' +
          '</div>' +
          '<div class="codes">' +
            '<div><div class="code" data-code>' + escHtml(a.spaced) + '</div>' +
            '<div class="copy-hint" data-hint>' + ICON.copy + '<span>Tocca per copiare</span></div></div>' +
            '<div class="next">Next<b>' + escHtml(a.nextSpaced) + '</b></div>' +
          '</div>' +
        '</article>';
    }).join('');

    var imgs = listEl.querySelectorAll('.icon img');
    for (var k = 0; k < imgs.length; k++) {
      imgs[k].addEventListener('error', function () {
        var span = document.createElement('span');
        span.textContent = this.getAttribute('data-fallback') || '?';
        this.parentNode.style.background = hashGradient(span.textContent);
        this.replaceWith(span);
      });
    }
    tick();
  }

  // countdown su tempo assoluto: resiste a tab in background
  function tick() {
    var now = Date.now();
    var expired = false;
    var cards = listEl.querySelectorAll('.card');
    for (var i = 0; i < cards.length; i++) {
      var a = byId(cards[i].dataset.id);
      if (!a) continue;
      var left = Math.max(0, (a.expiresAt - now) / 1000);
      if (left <= 0) expired = true;
      var low = left <= 5;
      cards[i].querySelector('[data-arc]').style.strokeDashoffset = String(RING_C * (1 - left / a.period));
      cards[i].querySelector('[data-num]').textContent = Math.ceil(left);
      cards[i].querySelector('[data-ring]').classList.toggle('low', low);
      cards[i].querySelector('[data-code]').classList.toggle('low', low);
    }
    if (expired) load();
  }
  setInterval(tick, 500);

  function load() {
    if (loading) return Promise.resolve();
    loading = true;
    return api('/api/list').then(function (data) {
      var t = Date.now();
      accounts = (data.accounts || []).map(function (a) { a.expiresAt = t + a.remaining * 1000; return a; });
      categories = data.categories || [];
      updateSubtitle();
      renderChips();
      render();
    }).catch(function (e) {
      listEl.innerHTML = '<div class="glass empty"><h3>Errore</h3><p>' + escHtml(e.message) + '</p></div>';
      $('subtitle').textContent = 'Errore di caricamento';
    }).then(function () { loading = false; });
  }

  listEl.addEventListener('click', function (e) {
    var card = e.target.closest('.card');
    if (!card) return;
    var a = byId(card.dataset.id);
    if (!a) return;

    if (e.target.closest('[data-edit]')) { tapHaptic(); return openEdit(a); }

    if (e.target.closest('[data-code]') || e.target.closest('[data-hint]')) {
      var code = card.querySelector('[data-code]').textContent.replace(/\s/g, '');
      copyText(code).then(function (ok) {
        if (!ok) return toast('Copia non riuscita', true);
        haptic('success');
        var hint = card.querySelector('[data-hint]');
        hint.classList.add('done');
        hint.querySelector('span').textContent = 'Copiato!';
        setTimeout(function () {
          hint.classList.remove('done');
          hint.querySelector('span').textContent = 'Tocca per copiare';
        }, 1600);
      });
    }
  });

  $('search').addEventListener('input', render);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') load(); });

  // ================= BOTTOM SHEET =================
  var sheetWrap = $('sheetWrap');
  var sheetBody = $('sheetBody');
  function openSheet(html, mount) {
    sheetBody.innerHTML = html;
    sheetWrap.hidden = false;
    $('sheet').scrollTop = 0;
    if (mount) mount(sheetBody);
  }
  function closeSheet() {
    sheetWrap.hidden = true;
    sheetBody.innerHTML = '';
  }
  sheetWrap.addEventListener('click', function (e) {
    if (e.target.hasAttribute('data-close') || e.target.closest('[data-dismiss]')) closeSheet();
  });
  if (tg && tg.BackButton && tgAtLeast('6.1')) {
    var obs = new MutationObserver(function () {
      try { sheetWrap.hidden ? tg.BackButton.hide() : tg.BackButton.show(); } catch (e) {}
    });
    obs.observe(sheetWrap, { attributes: true, attributeFilter: ['hidden'] });
    try { tg.BackButton.onClick(closeSheet); } catch (e) {}
  }

  function busy(btn, on, label) {
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Attendi…'; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
  }

  // selettore categorie riutilizzabile (toggle + nuova)
  function pickerHtml(selected) {
    return '<div class="pick" data-pick>' + categories.map(function (c) {
      return '<button type="button" class="chip' + (selected.indexOf(c) !== -1 ? ' active' : '') + '" data-tag="' + escHtml(c) + '">' + escHtml(c) + '</button>';
    }).join('') + '<button type="button" class="chip ghost" data-newtag>＋ Nuova</button></div>';
  }
  function mountPicker(root) {
    var pick = root.querySelector('[data-pick]');
    pick.addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      tapHaptic();
      if (b.hasAttribute('data-newtag')) {
        var input = document.createElement('input');
        input.className = 'field';
        input.placeholder = 'Nome nuova categoria';
        input.maxLength = 32;
        b.replaceWith(input);
        input.focus();
        var commit = function () {
          var v = input.value.trim();
          var exists = Array.prototype.some.call(pick.querySelectorAll('[data-tag]'), function (x) { return x.getAttribute('data-tag').toLowerCase() === v.toLowerCase(); });
          if (v && !exists) {
            var nb = document.createElement('button');
            nb.type = 'button';
            nb.className = 'chip active';
            nb.setAttribute('data-tag', v);
            nb.textContent = v;
            input.replaceWith(nb);
          } else input.remove();
          var add = document.createElement('button');
          add.type = 'button'; add.className = 'chip ghost'; add.setAttribute('data-newtag', ''); add.textContent = '＋ Nuova';
          pick.appendChild(add);
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); } });
        return;
      }
      b.classList.toggle('active');
    });
    return function selected() {
      return Array.prototype.map.call(pick.querySelectorAll('.chip.active[data-tag]'), function (b) { return b.getAttribute('data-tag'); });
    };
  }

  // ---- aggiunta account (manuale o da QR) ----
  function openAdd(prefill) {
    prefill = prefill || {};
    var fromQr = !!prefill.secret;
    var pre = activeCat && activeCat !== NONE ? [activeCat] : [];
    openSheet(
      '<h2>' + (fromQr ? '✨ QR 2FA letto' : 'Aggiungi account') + '</h2>' +
      '<p class="sub">' + (fromQr ? 'Conferma il nome e scegli le categorie.' : 'Il secret viene cifrato nel tuo vault privato e non viene mai restituito all\'app.') + '</p>' +
      '<form class="stack" id="addForm" autocomplete="off">' +
        '<input class="field" id="fName" placeholder="Nome (es. GitHub:mario)" maxlength="80" value="' + escHtml(prefill.name || '') + '" required>' +
        (fromQr ? '' : '<input class="field mono" id="fSecret" placeholder="Secret base32 o otpauth://…" required>') +
        '<label class="lbl">Categorie</label>' + pickerHtml(pre) +
        '<button class="btn primary" type="submit">Salva</button>' +
        '<button class="btn ghost" type="button" data-dismiss>Annulla</button>' +
      '</form>',
      function (root) {
        var getTags = mountPicker(root);
        root.querySelector('#addForm').addEventListener('submit', function (e) {
          e.preventDefault();
          var btn = root.querySelector('button[type=submit]');
          busy(btn, true, 'Salvataggio…');
          api('/api/add', {
            name: root.querySelector('#fName').value.trim(),
            secret: fromQr ? prefill.secret : root.querySelector('#fSecret').value.trim(),
            tags: getTags(),
          }).then(function (r) {
            haptic('success');
            closeSheet();
            toast('“' + r.name + '” salvato');
            load();
          }).catch(function (err) { busy(btn, false); haptic('error'); toast(err.message, true); });
        });
        if (!fromQr) root.querySelector('#fName').focus();
      }
    );
  }
  $('addBtn').addEventListener('click', function () { tapHaptic(); openAdd(); });

  // ---- modifica account ----
  function openEdit(a) {
    openSheet(
      '<h2>Modifica account</h2>' +
      '<p class="sub">' + escHtml(a.issuer || 'Rinomina l\'account o cambia le sue categorie.') + '</p>' +
      '<form class="stack" id="editForm" autocomplete="off">' +
        '<input class="field" id="eName" maxlength="80" value="' + escHtml(a.name) + '" required>' +
        '<label class="lbl">Categorie</label>' + pickerHtml(a.tags) +
        '<button class="btn primary" type="submit">Salva modifiche</button>' +
        '<button class="btn danger" type="button" id="eDel">' + 'Elimina account' + '</button>' +
      '</form>',
      function (root) {
        var getTags = mountPicker(root);
        root.querySelector('#editForm').addEventListener('submit', function (e) {
          e.preventDefault();
          var btn = root.querySelector('button[type=submit]');
          busy(btn, true, 'Salvataggio…');
          api('/api/update', { id: a.id, name: root.querySelector('#eName').value.trim(), tags: getTags() }).then(function () {
            haptic('success');
            closeSheet();
            toast('Modifiche salvate');
            load();
          }).catch(function (err) { busy(btn, false); toast(err.message, true); });
        });
        root.querySelector('#eDel').addEventListener('click', function () {
          askConfirm('Eliminare "' + a.name + '"? L\'operazione è definitiva.').then(function (ok) {
            if (!ok) return;
            api('/api/del', { id: a.id }).then(function () {
              haptic('success');
              closeSheet();
              toast('Account eliminato');
              load();
            }).catch(function (err) { toast(err.message, true); });
          });
        });
      }
    );
  }

  // ---- menu ⋯ ----
  $('moreBtn').addEventListener('click', function () {
    tapHaptic();
    openSheet(
      '<h2>Altro</h2><p class="sub">Organizza, importa ed esporta i tuoi codici.</p>' +
      '<div class="stack">' +
        '<button class="menu-item" data-go="cats"><span class="mi-ico">' + ICON.folder + '</span><span><b>Categorie</b><small>Crea, rinomina ed elimina categorie</small></span></button>' +
        '<button class="menu-item" data-go="import"><span class="mi-ico">' + ICON.down + '</span><span><b>Importa backup</b><small>File .txt in chiaro o .json cifrato</small></span></button>' +
        '<button class="menu-item" data-go="export"><span class="mi-ico">' + ICON.up + '</span><span><b>Esporta backup</b><small>Ricevi il file nella chat del bot</small></span></button>' +
        '<button class="menu-item" data-go="security"><span class="mi-ico">' + ICON.lock + '</span><span><b>Sicurezza e accessi</b><small>Passkey, accesso da browser, sessioni</small></span></button>' +
        (IN_TELEGRAM ? '' : '<button class="menu-item" data-go="logout"><span class="mi-ico">' + ICON.out + '</span><span><b>Esci</b><small>Chiudi la sessione su questo browser</small></span></button>') +
      '</div>',
      function (root) {
        root.addEventListener('click', function (e) {
          var b = e.target.closest('[data-go]');
          if (!b) return;
          tapHaptic();
          var go = b.getAttribute('data-go');
          if (go === 'cats') openCategories();
          if (go === 'import') openImport();
          if (go === 'export') openExport();
          if (go === 'security') openSecurity();
          if (go === 'logout') logout();
        });
      }
    );
  });

  // ---- gestione categorie ----
  function openCategories() {
    var rows = categories.map(function (c) {
      var n = accounts.filter(function (a) { return a.tags.indexOf(c) !== -1; }).length;
      return '<div class="cat-row" data-cat="' + escHtml(c) + '"><span class="cn">' + escHtml(c) + '</span><span class="cc">' + n + '</span>' +
        '<button class="edit" data-ren aria-label="Rinomina">' + ICON.edit + '</button>' +
        '<button class="edit" data-del aria-label="Elimina">' + ICON.trash + '</button></div>';
    }).join('');
    openSheet(
      '<h2>Categorie</h2><p class="sub">Organizza i tuoi codici. Le categorie vengono mantenute in import ed export.</p>' +
      '<div class="stack">' + (rows || '<p class="sub">Nessuna categoria ancora.</p>') +
        '<form class="stack" id="catForm" autocomplete="off"><input class="field" id="catName" placeholder="Nuova categoria (es. Lavoro)" maxlength="32" required>' +
        '<button class="btn primary" type="submit">Crea categoria</button></form>' +
      '</div>',
      function (root) {
        root.querySelector('#catForm').addEventListener('submit', function (e) {
          e.preventDefault();
          api('/api/category', { action: 'add', name: root.querySelector('#catName').value.trim() }).then(function () {
            haptic('success');
            return load();
          }).then(openCategories).catch(function (err) { toast(err.message, true); });
        });
        root.addEventListener('click', function (e) {
          var row = e.target.closest('.cat-row');
          if (!row) return;
          var name = row.getAttribute('data-cat');
          if (e.target.closest('[data-del]')) {
            askConfirm('Eliminare la categoria "' + name + '"? Gli account restano nel vault.').then(function (ok) {
              if (!ok) return;
              api('/api/category', { action: 'delete', name: name }).then(function () {
                if (activeCat === name) activeCat = '';
                return load();
              }).then(openCategories).catch(function (err) { toast(err.message, true); });
            });
          }
          if (e.target.closest('[data-ren]')) {
            row.innerHTML = '<input class="field" maxlength="32" value="' + escHtml(name) + '"><button class="btn primary" style="width:auto">OK</button>';
            var input = row.querySelector('input');
            input.focus();
            var save = function () {
              var v = input.value.trim();
              if (!v || v === name) return openCategories();
              api('/api/category', { action: 'rename', name: name, newName: v }).then(function () {
                if (activeCat === name) activeCat = v;
                return load();
              }).then(openCategories).catch(function (err) { toast(err.message, true); });
            };
            row.querySelector('button').addEventListener('click', save);
            input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') save(); });
          }
        });
      }
    );
  }

  // ---- import backup ----
  function openImport() {
    openSheet(
      '<h2>Importa backup</h2>' +
      '<p class="sub">Puoi usare un backup <b>cifrato</b> (.json) o <b>in chiaro</b> (.txt, un URI otpauth:// per riga). I tag diventano categorie.</p>' +
      '<div class="stack">' +
        '<label class="file-drop"><input type="file" id="impFile" accept=".txt,.json,text/plain,application/json">' +
          '<span id="impFileName">📂 Scegli il file di export</span><small>oppure incolla il contenuto qui sotto</small></label>' +
        '<textarea class="field" id="impText" placeholder="otpauth://totp/…"></textarea>' +
        '<input class="field" id="impPw" type="password" placeholder="Password dell\'export cifrato" autocomplete="off" hidden>' +
        '<div class="result" id="impResult" hidden></div>' +
        '<button class="btn primary" id="impGo">Importa</button>' +
        '<button class="btn ghost" data-dismiss>Chiudi</button>' +
      '</div>',
      function (root) {
        var text = root.querySelector('#impText');
        var pw = root.querySelector('#impPw');
        var detect = function () {
          var v = text.value.trim();
          var enc = false;
          try { var j = JSON.parse(v); enc = !!(j && j.encryptedData && j.kdfParams); } catch (e) {}
          pw.hidden = !enc;
          if (enc) pw.focus();
        };
        text.addEventListener('input', detect);
        root.querySelector('#impFile').addEventListener('change', function (e) {
          var f = e.target.files && e.target.files[0];
          if (!f) return;
          if (f.size > 1024 * 1024) return toast('File troppo grande (max 1 MB)', true);
          var reader = new FileReader();
          reader.onload = function () {
            text.value = String(reader.result || '');
            root.querySelector('#impFileName').textContent = '📄 ' + f.name;
            detect();
          };
          reader.readAsText(f);
        });
        root.querySelector('#impGo').addEventListener('click', function () {
          var btn = this;
          var content = text.value.trim();
          if (!content) return toast('Scegli un file o incolla il contenuto', true);
          busy(btn, true, pw.hidden ? 'Importazione…' : 'Decifratura…');
          api('/api/import', { content: content, password: pw.hidden ? undefined : pw.value }).then(function (r) {
            haptic('success');
            text.value = '';
            pw.value = '';
            var res = root.querySelector('#impResult');
            var lines = ['✅ <b>' + r.imported + '</b> account importati'];
            if (r.duplicates) lines.push('↩️ ' + r.duplicates + ' già presenti (saltati)');
            if (r.trashed) lines.push('🗑 ' + r.trashed + ' nel cestino (saltati)');
            if (r.unsupported) lines.push('⚠️ ' + r.unsupported + ' non TOTP (HOTP/Steam non supportati)');
            if (r.invalid) lines.push('❌ ' + r.invalid + ' non validi');
            if (r.limit) lines.push('⛔ Limite account raggiunto');
            res.innerHTML = lines.map(function (l) { return '<div>' + l + '</div>'; }).join('');
            res.hidden = false;
            busy(btn, false);
            load();
          }).catch(function (err) {
            busy(btn, false);
            if (err.data && err.data.needPassword) { pw.hidden = false; pw.focus(); }
            haptic('error');
            toast(err.message, true);
          });
        });
      }
    );
  }

  // ---- export backup ----
  function openExport() {
    openSheet(
      '<h2>Esporta backup</h2>' +
      '<p class="sub">Il file ti verrà inviato nella <b>chat privata del bot</b>.</p>' +
      '<div class="stack">' +
        '<div class="seg" id="expSeg"><button class="on" data-f="encrypted">🔒 Cifrato</button><button data-f="plain">📄 In chiaro</button></div>' +
        '<div id="expEnc" class="stack">' +
          '<input class="field" id="expPw" type="password" placeholder="Password (min. 8 caratteri)" autocomplete="new-password">' +
          '<input class="field" id="expPw2" type="password" placeholder="Ripeti la password" autocomplete="new-password">' +
          '<p class="sub" style="margin:0">Cifrato con Argon2id + XChaCha20-Poly1305. Senza password il file non è recuperabile.</p>' +
        '</div>' +
        '<div id="expPlain" class="warn" hidden>⚠️ L\'export in chiaro contiene tutti i secret leggibili: chiunque lo ottenga può generare i tuoi codici. Il file verrà eliminato dalla chat dopo 10 minuti.</div>' +
        '<button class="btn primary" id="expGo">Invia in chat</button>' +
        '<button class="btn ghost" data-dismiss>Annulla</button>' +
      '</div>',
      function (root) {
        var format = 'encrypted';
        root.querySelector('#expSeg').addEventListener('click', function (e) {
          var b = e.target.closest('button[data-f]');
          if (!b) return;
          tapHaptic();
          format = b.getAttribute('data-f');
          Array.prototype.forEach.call(this.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === b); });
          root.querySelector('#expEnc').hidden = format !== 'encrypted';
          root.querySelector('#expPlain').hidden = format !== 'plain';
        });
        root.querySelector('#expGo').addEventListener('click', function () {
          var btn = this;
          var pwv = root.querySelector('#expPw').value;
          if (format === 'encrypted') {
            if (pwv.length < 8) return toast('Password di almeno 8 caratteri', true);
            if (pwv !== root.querySelector('#expPw2').value) return toast('Le password non coincidono', true);
          }
          busy(btn, true, format === 'encrypted' ? 'Cifratura…' : 'Invio…');
          api('/api/export', { format: format, password: format === 'encrypted' ? pwv : undefined }).then(function (r) {
            haptic('success');
            closeSheet();
            toast('📤 Export di ' + r.count + ' account inviato in chat');
          }).catch(function (err) { busy(btn, false); haptic('error'); toast(err.message, true); });
        });
      }
    );
  }

  // ================= SICUREZZA: passkey, sessioni web =================
  function fmtDate(ts) {
    if (!ts) return 'mai';
    try { return new Date(ts).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function loadWebAuthn() {
    return new Promise(function (resolve, reject) {
      if (window.SimpleWebAuthnBrowser) return resolve(window.SimpleWebAuthnBrowser);
      var s = document.createElement('script');
      s.src = '/webauthn.js';
      s.onload = function () { resolve(window.SimpleWebAuthnBrowser); };
      s.onerror = function () { reject(new Error('libreria passkey non disponibile')); };
      document.head.appendChild(s);
    });
  }
  function deviceName() {
    var ua = navigator.userAgent || '';
    var b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    var o = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    return b + (o ? ' su ' + o : '');
  }

  function openSecurity() {
    var webUrl = location.origin;
    api('/api/security').then(function (s) {
      var pk = s.passkeys.map(function (p) {
        return '<div class="cat-row" data-pk="' + escHtml(p.id) + '"><span class="cn">' + ICON.key + ' ' + escHtml(p.name) +
          '<small class="sec-meta">creata ' + fmtDate(p.created) + ' · usata ' + fmtDate(p.lastUsed) + (p.backedUp ? ' · sincronizzata' : '') + '</small></span>' +
          '<button class="edit" data-delpk aria-label="Elimina passkey">' + ICON.trash + '</button></div>';
      }).join('');
      var ss = s.sessions.map(function (x) {
        return '<div class="cat-row" data-sid="' + escHtml(x.id) + '"><span class="cn">' + ICON.globe + ' ' + escHtml(x.ua) + (x.current ? ' <span class="tag">questo browser</span>' : '') +
          '<small class="sec-meta">' + escHtml(x.method || '') + ' · IP ' + escHtml(x.ip) + ' · attiva ' + fmtDate(x.lastSeen) + '</small></span>' +
          (x.current ? '' : '<button class="edit" data-revoke aria-label="Disconnetti">' + ICON.out + '</button>') + '</div>';
      }).join('');
      var canPasskey = !!(window.PublicKeyCredential && navigator.credentials);
      openSheet(
        '<h2>Sicurezza e accessi</h2>' +
        '<p class="sub">Puoi usare i tuoi codici anche da browser su <b>' + escHtml(webUrl.replace(/^https?:\/\//, '')) + '</b>, accedendo con Telegram o con una passkey.</p>' +
        '<div class="stack">' +
          '<label class="lbl">Passkey</label>' +
          (pk || '<p class="sub" style="margin:0">Nessuna passkey. Aggiungine una per entrare dal browser con impronta, volto o PIN del dispositivo.</p>') +
          '<input class="field" id="pkName" maxlength="40" value="' + escHtml(deviceName()) + '" placeholder="Nome della passkey">' +
          '<button class="btn primary" id="pkAdd"' + (canPasskey ? '' : ' disabled') + '>Aggiungi passkey su questo dispositivo</button>' +
          (IN_TELEGRAM ? '<button class="btn ghost" id="openWeb">Apri la versione web nel browser</button>' : '') +
          '<label class="lbl">Sessioni web attive</label>' +
          (ss || '<p class="sub" style="margin:0">Nessuna sessione web attiva.</p>') +
          (s.sessions.some(function (x) { return !x.current; }) ? '<button class="btn danger" id="revokeAll">' + (IN_TELEGRAM ? 'Disconnetti tutti i browser' : 'Disconnetti gli altri browser') + '</button>' : '') +
          (IN_TELEGRAM ? '' : '<button class="btn ghost" id="logoutBtn">Esci da questo browser</button>') +
        '</div>',
        function (root) {
          var add = root.querySelector('#pkAdd');
          add.addEventListener('click', function () {
            var name = root.querySelector('#pkName').value.trim() || deviceName();
            busy(add, true, 'Conferma sul dispositivo…');
            loadWebAuthn().then(function (wa) {
              return api('/api/passkey/options').then(function (o) { return wa.startRegistration({ optionsJSON: o }); });
            }).then(function (att) {
              return api('/api/passkey/register', { response: att, name: name });
            }).then(function () {
              haptic('success');
              toast('Passkey aggiunta');
              openSecurity();
            }).catch(function (e) {
              busy(add, false);
              var msg = e && e.name === 'NotAllowedError' ? 'Operazione annullata'
                : e && (e.name === 'NotSupportedError' || e.name === 'SecurityError') && IN_TELEGRAM ? 'Telegram non supporta le passkey qui: apri la versione web'
                : (e.message || 'Errore');
              toast(msg, true);
            });
          });
          var ow = root.querySelector('#openWeb');
          if (ow) ow.addEventListener('click', function () { try { tg.openLink(webUrl); } catch (e) { window.open(webUrl, '_blank'); } });
          var ra = root.querySelector('#revokeAll');
          if (ra) ra.addEventListener('click', function () {
            askConfirm('Disconnettere ' + (IN_TELEGRAM ? 'tutti i browser' : 'gli altri browser') + '?').then(function (ok) {
              if (!ok) return;
              api('/api/sessions/revoke', {}).then(function (r) { toast(r.revoked + ' sessioni chiuse'); openSecurity(); });
            });
          });
          var lo = root.querySelector('#logoutBtn');
          if (lo) lo.addEventListener('click', logout);
          root.addEventListener('click', function (e) {
            var pkRow = e.target.closest('[data-pk]');
            if (pkRow && e.target.closest('[data-delpk]')) {
              askConfirm('Eliminare questa passkey? Non potrai più usarla per accedere.').then(function (ok) {
                if (!ok) return;
                api('/api/passkey/delete', { id: pkRow.getAttribute('data-pk') }).then(function () { toast('Passkey eliminata'); openSecurity(); })
                  .catch(function (err) { toast(err.message, true); });
              });
            }
            var sRow = e.target.closest('[data-sid]');
            if (sRow && e.target.closest('[data-revoke]')) {
              api('/api/sessions/revoke', { id: sRow.getAttribute('data-sid') }).then(function () { toast('Sessione chiusa'); openSecurity(); });
            }
          });
        }
      );
    }).catch(function (e) { toast(e.message, true); });
  }

  function logout() {
    fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function () { location.reload(); }, function () { location.reload(); });
  }

  if (!IN_TELEGRAM && window.matchMedia) {
    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (currentTheme === 'auto') applyTheme('auto'); });
    } catch (e) {}
  }

  // ================= SCANNER QR =================
  var mediaStream = null;
  var scanTimer = null;

  function handleQr(text) {
    text = String(text || '').trim();
    if (!text) return;
    $('qrText').hidden = true;
    if (/^otpauth:\/\/totp\//i.test(text)) {
      var label = '';
      try { label = decodeURIComponent(new URL(text).pathname.replace(/^\//, '')); } catch (e) {}
      haptic('success');
      openAdd({ name: label || 'account', secret: text });
    } else {
      $('qrTextContent').textContent = text;
      $('qrText').hidden = false;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      copyText(text).then(function (ok) { if (ok) toast('Contenuto copiato'); });
    }
  }
  $('qrTextClose').addEventListener('click', function () { $('qrText').hidden = true; });

  function loadJsQr() {
    return new Promise(function (resolve, reject) {
      if (window.jsQR) return resolve();
      var s = document.createElement('script');
      s.src = '/jsQR.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('decoder QR non disponibile')); };
      document.head.appendChild(s);
    });
  }

  function stopLive() {
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    if (mediaStream) { mediaStream.getTracks().forEach(function (t) { t.stop(); }); mediaStream = null; }
    $('scanner').classList.remove('open');
    $('scanErr').hidden = true;
  }

  function startLive() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('fotocamera non supportata da questo client'));
    }
    return loadJsQr().then(function () {
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    }).then(function (stream) {
      mediaStream = stream;
      var video = $('scanVideo');
      video.srcObject = stream;
      $('scanner').classList.add('open');
      return video.play().then(function () {
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d', { willReadFrequently: true });
        var loop = function () {
          if (!mediaStream) return;
          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            var scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            var qr = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
            if (qr && qr.data) { stopLive(); handleQr(qr.data); return; }
          }
          scanTimer = setTimeout(loop, 160);
        };
        loop();
      });
    });
  }

  $('scanBtn').addEventListener('click', function () {
    tapHaptic();
    // 1) scanner nativo Telegram (fotocamera attiva, client mobile)
    if (tgAtLeast('6.4') && /android|ios/i.test(tg.platform || '')) {
      try {
        tg.showScanQrPopup({ text: 'Inquadra il QR code 2FA' }, function (text) {
          try { tg.closeScanQrPopup(); } catch (e) {}
          setTimeout(function () { handleQr(text); }, 50);
          return true;
        });
        return;
      } catch (e) { /* fallback sotto */ }
    }
    // 2) fallback: fotocamera via getUserMedia + jsQR in locale
    startLive().catch(function (e) {
      stopLive();
      $('scanErr').textContent = 'Fotocamera non disponibile: ' + e.message + '. Puoi anche inviare la foto del QR direttamente al bot.';
      $('scanErr').hidden = false;
      $('scanner').classList.add('open');
    });
  });
  $('scanCancel').addEventListener('click', stopLive);

  // ================= AVVIO =================
  skeleton();
  load();
})();
