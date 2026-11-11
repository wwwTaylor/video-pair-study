/* Static (GitHub Pages) version of the video questionnaire.
 * Two formats: "pair" (two videos, choose A / same / B per question) and
 * "rank" (several videos, rank them per question).
 * The browser picks the items for each person and sends every answer to Supabase.
 * Answers that cannot be sent right away are kept in this browser and retried. */
(function () {
  'use strict';

  var LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
  var $ = function (id) { return document.getElementById(id); };
  var S = null;            // study.json
  var itemById = {};
  var nVideos = 2;         // videos per item
  var memQueue = null;     // answers waiting for upload; the single source of truth (mirrored to localStorage)
  var flushPromise = null; // the upload loop in progress, shared by every caller
  var state = {
    annotator: '',
    sessionId: '',
    trials: [],
    index: 0,
    remainingNew: 0,
    offset: 0,
    trialStart: 0,
    watch: [],
    rank: {},              // rank format: question id -> video indices, best first
    gen: 0,
    dirty: false
  };

  // ------------------------------------------------------------------ helpers
  function lsGet(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, value) { try { window.localStorage.setItem(key, value); return true; } catch (e) { return false; } }
  function lsJSON(key, fallback) {
    try { var v = window.localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function seeded(seed) {           // mulberry32
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffled(arr, rnd) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function randomId() {
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function normalise(id) { return id.trim().split(/\s+/).join(' ').toLowerCase(); }
  function mediaName(path) { var m = /media\/([0-9a-f]+)\.mp4$/.exec(path || ''); return m ? m[1] : String(path).slice(0, 64); }
  function txt(obj) { return obj ? (obj.zh || obj.en || '') : ''; }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c !== null && c !== undefined) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }
  function show(view) {
    ['welcome', 'trial', 'done', 'message'].forEach(function (v) { $('view-' + v).hidden = v !== view; });
    $('progressWrap').hidden = view !== 'trial';
    window.scrollTo(0, 0);
  }
  function message(title, text) {
    $('messageTitle').textContent = title;
    $('messageText').textContent = text || '';
    show('message');
  }

  // ------------------------------------------------------------------ local progress
  function doneKey() { return 'vps_done_' + S.study_id + '_' + state.annotator; }
  function queueKey() { return 'vps_queue_' + S.study_id; }
  function doneMap() { return lsJSON(doneKey(), {}); }
  function completedCount() {
    var d = doneMap(), n = 0;
    Object.keys(d).forEach(function (k) { n += d[k]; });
    return n;
  }

  // ------------------------------------------------------------------ upload queue
  function queue() {
    if (memQueue === null) {
      var stored = lsJSON(queueKey(), []);
      memQueue = Array.isArray(stored) ? stored : [];
    }
    return memQueue;
  }
  function persist() {
    lsSet(queueKey(), JSON.stringify(queue()));  // backup only; works even if storage is blocked
    updateSyncBanner();
  }
  function enqueue(record) {
    queue().push(record);                         // append only: never overwrite pending answers
    persist();
  }
  function updateSyncBanner() {
    var n = queue().length;
    $('syncBanner').hidden = n === 0 || flushPromise !== null;
    $('syncText').textContent = '有 ' + n + ' 条答案还没上传，联网后会自动重传。';
    if (n === 0) $('doneWarn').hidden = true;
  }

  async function sendOne(record) {
    var b = S.backend;
    var headers = { 'Content-Type': 'application/json', 'apikey': b.key, 'Prefer': 'return=minimal' };
    if (/^eyJ/.test(b.key)) headers.Authorization = 'Bearer ' + b.key;  // legacy JWT anon keys
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 20000);
    try {
      var res = await fetch(b.url + '/rest/v1/' + encodeURIComponent(b.table), {
        method: 'POST', headers: headers, body: JSON.stringify(record), signal: ctrl.signal, cache: 'no-store'
      });
      if (res.ok || res.status === 409) return true;   // 409 = this answer was already stored
      try { console.warn('upload rejected', res.status, await res.text()); } catch (e) { /* ignore */ }
      return false;
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // Uploads until the queue is empty or a request fails. A second caller joins the loop
  // already running instead of starting another one, and answers added meanwhile are
  // picked up by the same loop, so the result always reflects every pending answer.
  async function uploadAll() {
    while (queue().length) {
      var record = queue()[0];
      if (!(await sendOne(record))) break;
      var q = queue();
      var at = q.indexOf(record);
      if (at >= 0) q.splice(at, 1);
      persist();
    }
    return queue().length === 0;
  }

  function flush() {
    if (flushPromise) return flushPromise;
    // .then callbacks always run asynchronously, i.e. after flushPromise has been assigned,
    // even when uploadAll() finishes at once because the queue is empty.
    flushPromise = uploadAll().then(function (ok) {
      flushPromise = null;
      updateSyncBanner();
      return ok;
    }, function () {
      flushPromise = null;
      updateSyncBanner();
      return false;
    });
    return flushPromise;
  }

  // ------------------------------------------------------------------ welcome
  function renderWelcome() {
    var title = txt(S.title);
    if (title) { document.title = title; $('brand').textContent = title; $('welcomeTitle').textContent = title; }
    $('welcomeIntro').textContent = txt(S.intro);
    $('consentText').textContent = txt(S.consent);
    $('pilotBanner').hidden = !S.pilot;
  }

  // ------------------------------------------------------------------ questions
  function renderQuestions() {
    var form = $('questions');
    form.textContent = '';
    var hint = $('rankHint');
    hint.hidden = S.format !== 'rank';
    hint.textContent = S.format === 'rank' ? (txt(S.rank_hint) || '每个问题：按从好到差的顺序依次点击。') : '';
    S.criteria.forEach(function (c, i) {
      var q = el('p', { class: 'qtext' }, [(i + 1) + '. ' + txt(c.question)]);
      if (S.format === 'rank') {
        var row = el('div', { class: 'rank-row', role: 'group', 'aria-label': txt(c.question) });
        for (var v = 0; v < nVideos; v++) {
          var btn = el('button', { type: 'button', class: 'rank-btn', 'data-crit': c.id, 'data-v': String(v) },
            [el('span', { class: 'letter', text: LETTERS[v] }), el('span', { class: 'badge' })]);
          btn.addEventListener('click', onRankTap);
          row.appendChild(btn);
        }
        form.appendChild(el('fieldset', { class: 'question rank' }, [q, row]));
      } else {
        var choices = el('div', { class: 'choices', role: 'radiogroup', 'aria-label': txt(c.question) });
        ['left', 'tie', 'right'].forEach(function (value) {
          var input = el('input', { type: 'radio', name: c.id, value: value });
          input.addEventListener('change', function () { state.dirty = true; updateSubmit(); });
          choices.appendChild(el('label', { class: 'choice' }, [input, el('span', { text: txt(S.options[value]) })]));
        });
        form.appendChild(el('fieldset', { class: 'question' }, [q, choices]));
      }
    });
  }

  // Rank format: tap the videos from best to worst. Tapping a video that already has a
  // place removes it and everything ranked after it, so a choice can be redone.
  function onRankTap(e) {
    var btn = e.currentTarget;
    var crit = btn.getAttribute('data-crit');
    var v = parseInt(btn.getAttribute('data-v'), 10);
    var order = (state.rank[crit] || []).slice();
    var at = order.indexOf(v);
    if (at >= 0) {
      order = order.slice(0, at);
    } else {
      order.push(v);
      if (order.length === nVideos - 1) {            // the last place is implied
        for (var i = 0; i < nVideos; i++) if (order.indexOf(i) < 0) order.push(i);
      }
    }
    state.rank[crit] = order;
    state.dirty = true;
    paintRank(crit);
    updateSubmit();
  }

  function paintRank(crit) {
    var order = state.rank[crit] || [];
    Array.prototype.forEach.call($('questions').querySelectorAll('.rank-btn[data-crit="' + crit + '"]'), function (btn) {
      var v = parseInt(btn.getAttribute('data-v'), 10);
      var place = order.indexOf(v);
      btn.className = 'rank-btn' + (place >= 0 ? ' ranked r' + (place + 1) : '');
      btn.querySelector('.badge').textContent = place >= 0 ? '第 ' + (place + 1) : '';
      btn.setAttribute('aria-label', LETTERS[v] + (place >= 0 ? '，第 ' + (place + 1) + ' 名' : '，未排名'));
    });
  }

  function start() {
    var input = $('annotatorId');
    var id = normalise(input.value);
    if (!id) {                       // "随便填": an empty box is fine, we make one up
      id = 'anon-' + randomId().slice(0, 6);
      input.value = id;
    }
    if (id.length > 64) id = id.slice(0, 64);
    lsSet('vps_annotator', id);
    state.annotator = id;
    newBatch();
  }

  // ------------------------------------------------------------------ batches
  function newBatch() {
    var done = doneMap();
    var ids = S.items.map(function (p) { return p.id; });
    var fixed = S.item_order === 'fixed';   // fixed: always the order listed in study.json
    var order = fixed ? ids : shuffled(ids, seeded(hashStr(state.annotator + '|order|' + S.study_id)));
    var fresh = order.filter(function (id) { return !done[id]; });
    var candidates, round;
    if (fresh.length) {
      candidates = fresh;
      round = 0;
    } else {
      var least = Math.min.apply(null, ids.map(function (id) { return done[id] || 0; }));
      round = least;
      candidates = ids.filter(function (id) { return (done[id] || 0) === least; });
      if (!fixed) {
        candidates = shuffled(candidates, seeded(hashStr(state.annotator + '|repeat|' + least + '|' + S.study_id)));
      }
    }
    var chosen = candidates.slice(0, S.batch_size);
    state.offset = fixed ? ids.length - candidates.length : 0;   // items of this round answered earlier
    state.sessionId = randomId();
    var rnd = seeded(hashStr(state.sessionId));
    function arranged(videos) {      // fixed_order: keep the positions built into study.json
      if (S.fixed_order) return videos.slice();
      if (videos.length === 2) return rnd() < 0.5 ? [videos[1], videos[0]] : videos.slice();
      return shuffled(videos, rnd);
    }
    var trials = chosen.map(function (id) {
      var it = itemById[id];
      return { item: id, kind: 'pair', story: it.story, videos: arranged(it.videos), round: round };
    });
    var checks = [];
    for (var c = 0; c < S.catch_per_batch && S.catches.length && trials.length; c++) {
      var k = S.catches[Math.floor(rnd() * S.catches.length)];
      checks.push({ item: k.id, kind: 'catch', story: k.story,
        videos: rnd() < 0.5 ? [k.videos[1], k.videos[0]] : k.videos.slice(), round: round });
    }
    if (fixed) {             // keep the item order; a check goes to a random place after the first item
      checks.forEach(function (check) { trials.splice(1 + Math.floor(rnd() * trials.length), 0, check); });
    } else {
      trials = shuffled(trials.concat(checks), rnd);
      if (trials.length > 1 && trials[0].kind === 'catch') {
        for (var j = 1; j < trials.length; j++) {
          if (trials[j].kind !== 'catch') { var t = trials[0]; trials[0] = trials[j]; trials[j] = t; break; }
        }
      }
    }
    state.trials = trials;
    state.index = 0;
    state.remainingNew = Math.max(0, fresh.length - chosen.length);
    if (!trials.length) { message('暂时没有题目', ''); return; }
    show('trial');
    renderTrial();
  }

  // ------------------------------------------------------------------ trial
  function renderTrial() {
    var trial = state.trials[state.index];
    var n = state.trials.length;
    var total = state.offset + n;
    $('progressText').textContent = '第 ' + (state.offset + state.index + 1) + ' / ' + total + ' 题';
    $('progressBar').style.width = (100 * (state.offset + state.index) / total) + '%';
    var story = S.stories[trial.story] || {};
    $('storyTitle').textContent = txt(story.title);
    $('storyTitle').hidden = !txt(story.title);
    $('storyText').textContent = txt(story.text);
    $('storyText').hidden = !txt(story.text);
    Array.prototype.forEach.call($('questions').querySelectorAll('input[type=radio]'), function (r) { r.checked = false; });
    state.rank = {};
    S.criteria.forEach(function (c) { if (S.format === 'rank') paintRank(c.id); });
    state.dirty = false;
    state.gen += 1;
    state.watch = trial.videos.map(function () { return 0; });
    var box = $('videos');
    box.textContent = '';
    box.className = 'videos n' + trial.videos.length;
    trial.videos.forEach(function (info, i) {
      var slot = el('div', { class: 'video-slot' });
      box.appendChild(el('figure', { class: 'video-card' },
        [el('figcaption', {}, [el('span', { class: 'tag', text: LETTERS[i] })]), slot]));
      mountVideo(slot, info, i);
    });
    state.trialStart = Date.now();
    updateSubmit();
    window.scrollTo(0, 0);
  }

  function mountVideo(slot, info, index) {
    var v = document.createElement('video');
    v.controls = true;
    v.preload = 'auto';
    v.muted = true;
    v.autoplay = true;               // starts by itself (muted videos may autoplay)
    v.loop = false;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('controlslist', 'nodownload noremoteplayback');
    v.disablePictureInPicture = true;
    if (info.p) v.poster = info.p;
    v.src = info.v;
    v.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    slot.appendChild(v);
    trackWatch(v, index);
    var p = v.play();
    if (p && p.catch) p.catch(function () { /* the user can press play */ });
  }

  // Records (without enforcing anything) how much of each video was played.
  function trackWatch(video, index) {
    var STEP = 0.5, buckets = null, last = null, gen = state.gen;
    function ensure() {
      if (!buckets && isFinite(video.duration) && video.duration > 0) {
        buckets = new Uint8Array(Math.max(1, Math.ceil(video.duration / STEP)));
      }
      return buckets;
    }
    function mark(from, to) {
      if (!ensure() || gen !== state.gen) return;
      var a = Math.max(0, Math.floor(from / STEP));
      var b = Math.min(buckets.length - 1, Math.floor(to / STEP));
      for (var i = a; i <= b; i++) buckets[i] = 1;
      var sum = 0;
      for (var j = 0; j < buckets.length; j++) sum += buckets[j];
      state.watch[index] = sum / buckets.length;
    }
    video.addEventListener('play', function () { last = video.currentTime; });
    video.addEventListener('seeked', function () { last = video.currentTime; });
    video.addEventListener('timeupdate', function () {
      var t = video.currentTime;
      if (!video.seeking && !video.paused && last !== null && t >= last && t - last < 1.5) mark(last, t);
      last = t;
    });
    video.addEventListener('ended', function () {
      if (ensure() && last !== null && video.duration - last < 1.5) mark(last, video.duration);
    });
  }

  function allVideos() { return Array.prototype.slice.call(document.querySelectorAll('.video-slot video')); }

  function playAll() {
    var vids = allVideos();
    vids.forEach(function (v) { v.pause(); v.currentTime = 0; });
    vids.forEach(function (v) {
      var p = v.play();
      if (p && p.catch) p.catch(function () { /* ignore */ });
    });
  }

  function stopVideos() {
    allVideos().forEach(function (v) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    });
  }

  function collectAnswers() {
    var trial = state.trials[state.index];
    var values = {}, missing = 0;
    S.criteria.forEach(function (c) {
      if (S.format === 'rank') {
        var order = state.rank[c.id] || [];
        if (order.length === trial.videos.length) {
          values[c.id] = order.map(function (i) { return mediaName(trial.videos[i].v); });   // best first
        } else {
          missing += 1;
        }
      } else {
        var checked = $('questions').querySelector('input[name="' + c.id + '"]:checked');
        if (checked) values[c.id] = checked.value; else missing += 1;
      }
    });
    return { values: values, missing: missing };
  }

  function updateSubmit() {
    $('submitBtn').disabled = collectAnswers().missing > 0;
  }

  function round3(x) { return Math.round((x || 0) * 1000) / 1000; }

  function submit() {
    var answers = collectAnswers();
    if (answers.missing) return;
    var trial = state.trials[state.index];
    var names = trial.videos.map(function (info) { return mediaName(info.v); });
    var watch = state.watch.map(round3);
    var values = answers.values;
    if (S.format === 'rank') values._watch = watch;      // "_" fields are not questions
    enqueue({
      rid: randomId(),
      study_id: S.study_id,
      annotator: state.annotator,
      session_id: state.sessionId,
      item_id: trial.item,
      kind: trial.kind,
      story_id: trial.story,
      left_media: names[0],                              // video A
      // video B (and C, ...) in the order shown; the table allows 64 characters here, and the
      // complete ranking is in `answers` anyway
      right_media: names.slice(1).join(',').slice(0, 64),
      answers: values,
      left_watch: watch[0],
      right_watch: Math.min.apply(null, watch.slice(1)),
      duration_ms: Date.now() - state.trialStart,
      round: trial.round,
      position: state.index,
      client_time: new Date().toISOString(),
      user_agent: (navigator.userAgent || '').slice(0, 400)
    });
    if (trial.kind === 'pair') {
      var done = doneMap();
      done[trial.item] = (done[trial.item] || 0) + 1;
      lsSet(doneKey(), JSON.stringify(done));
    }
    flush();
    state.dirty = false;
    stopVideos();
    state.index += 1;
    if (state.index < state.trials.length) renderTrial(); else renderDone();
  }

  async function renderDone() {
    $('progressBar').style.width = '100%';
    $('doneText').textContent = '已完成 ' + completedCount() + ' 题。';
    $('continueBtn').textContent = state.remainingNew > 0 ? '继续' : '再答一次';
    $('doneWarn').hidden = true;
    show('done');
    var ok = await flush();       // waits for the upload already in progress, if any
    if (!ok && queue().length) {
      $('doneWarn').textContent = '有 ' + queue().length + ' 条答案还没上传，请保持联网，点上方“重试”。';
      $('doneWarn').hidden = false;
    }
  }

  // ------------------------------------------------------------------ start-up
  async function init() {
    try {
      var res = await fetch('study.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      S = await res.json();
    } catch (e) {
      message('页面加载失败', e.message);
      return;
    }
    S.items.forEach(function (p) { itemById[p.id] = p; });
    nVideos = S.items.length ? S.items[0].videos.length : 2;
    renderWelcome();
    renderQuestions();
    updateSyncBanner();
    flush();
    setInterval(function () { if (queue().length) flush(); }, 30000);
    window.addEventListener('online', function () { flush(); });
    var params = new URLSearchParams(window.location.search);
    $('annotatorId').value = params.get('annotator') || lsGet('vps_annotator') || '';
    $('startBtn').addEventListener('click', start);
    $('annotatorId').addEventListener('keydown', function (e) { if (e.key === 'Enter') start(); });
    $('playBoth').addEventListener('click', playAll);
    $('submitBtn').addEventListener('click', submit);
    $('syncRetry').addEventListener('click', function () { flush(); });
    $('continueBtn').addEventListener('click', newBatch);
    $('finishBtn').addEventListener('click', function () { message('谢谢参与！', '可以关闭页面了。'); });
    window.addEventListener('beforeunload', function (e) {
      if ((!$('view-trial').hidden && state.dirty) || queue().length) { e.preventDefault(); e.returnValue = ''; }
    });
    show('welcome');
    var local = ['localhost', '127.0.0.1'].indexOf(window.location.hostname) >= 0;
    if (local) window.__vps = { flush: flush, queue: queue, enqueue: enqueue };  // hooks for local tests only
    if (params.get('autostart') === '1' && local) start();     // local testing only
  }

  init();
})();
