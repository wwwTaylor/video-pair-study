/* Static (GitHub Pages) version of the pairwise video questionnaire.
 * The browser picks the pairs for each person and sends every answer to Supabase.
 * Answers that cannot be sent right away are kept in this browser and retried. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var S = null;            // study.json
  var pairById = {};
  var flushing = false;
  var state = {
    annotator: '',
    sessionId: '',
    trials: [],
    index: 0,
    remainingNew: 0,
    trialStart: 0,
    watch: { l: 0, r: 0 },
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
  function queue() { return lsJSON(queueKey(), []); }
  function saveQueue(q) { lsSet(queueKey(), JSON.stringify(q)); updateSyncBanner(); }
  function updateSyncBanner() {
    var n = queue().length;
    $('syncBanner').hidden = n === 0 || flushing;
    $('syncText').textContent = '有 ' + n + ' 条答案还没上传，联网后会自动重传。';
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

  async function flush() {
    if (flushing) return queue().length === 0;
    flushing = true;
    try {
      var q = queue();
      while (q.length) {
        if (!(await sendOne(q[0]))) break;
        q.shift();
        saveQueue(q);
      }
    } finally {
      flushing = false;
      updateSyncBanner();
    }
    return queue().length === 0;
  }

  // ------------------------------------------------------------------ welcome
  function renderWelcome() {
    var title = txt(S.title);
    if (title) { document.title = title; $('brand').textContent = title; $('welcomeTitle').textContent = title; }
    $('welcomeIntro').textContent = txt(S.intro);
    $('consentText').textContent = txt(S.consent);
    $('pilotBanner').hidden = !S.pilot;
  }

  function renderQuestions() {
    var form = $('questions');
    form.textContent = '';
    S.criteria.forEach(function (c, i) {
      var q = el('p', { class: 'qtext' }, [(i + 1) + '. ' + txt(c.question)]);
      var choices = el('div', { class: 'choices', role: 'radiogroup', 'aria-label': txt(c.question) });
      ['left', 'tie', 'right'].forEach(function (value) {
        var input = el('input', { type: 'radio', name: c.id, value: value });
        input.addEventListener('change', function () { state.dirty = true; updateSubmit(); });
        choices.appendChild(el('label', { class: 'choice' }, [input, el('span', { text: txt(S.options[value]) })]));
      });
      form.appendChild(el('fieldset', { class: 'question' }, [q, choices]));
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
    var ids = S.pairs.map(function (p) { return p.id; });
    var order = shuffled(ids, seeded(hashStr(state.annotator + '|order|' + S.study_id)));
    var fresh = order.filter(function (id) { return !done[id]; });
    var chosen, round;
    if (fresh.length) {
      chosen = fresh.slice(0, S.batch_size);
      round = 0;
    } else {
      var least = Math.min.apply(null, ids.map(function (id) { return done[id] || 0; }));
      round = least;
      chosen = shuffled(ids.filter(function (id) { return (done[id] || 0) === least; }),
        seeded(hashStr(state.annotator + '|repeat|' + least + '|' + S.study_id))).slice(0, S.batch_size);
    }
    state.sessionId = randomId();
    var rnd = seeded(hashStr(state.sessionId));
    var trials = chosen.map(function (id) {
      var p = pairById[id];
      var flip = S.fixed_order ? false : rnd() < 0.5;   // fixed_order: keep the built A/B order
      return { item: id, kind: 'pair', story: p.story, left: flip ? p.b : p.a, right: flip ? p.a : p.b, round: round };
    });
    for (var c = 0; c < S.catch_per_batch && S.catches.length && trials.length; c++) {
      var k = S.catches[Math.floor(rnd() * S.catches.length)];
      var f = rnd() < 0.5;
      trials.push({ item: k.id, kind: 'catch', story: k.story, left: f ? k.b : k.a, right: f ? k.a : k.b, round: round });
    }
    trials = shuffled(trials, rnd);
    if (trials.length > 1 && trials[0].kind === 'catch') {
      for (var j = 1; j < trials.length; j++) {
        if (trials[j].kind !== 'catch') { var t = trials[0]; trials[0] = trials[j]; trials[j] = t; break; }
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
    $('progressText').textContent = '第 ' + (state.index + 1) + ' / ' + n + ' 题';
    $('progressBar').style.width = (100 * state.index / n) + '%';
    var story = S.stories[trial.story] || {};
    $('storyTitle').textContent = txt(story.title);
    $('storyTitle').hidden = !txt(story.title);
    $('storyText').textContent = txt(story.text);
    $('storyText').hidden = !txt(story.text);
    Array.prototype.forEach.call($('questions').querySelectorAll('input[type=radio]'), function (r) { r.checked = false; });
    state.dirty = false;
    state.watch = { l: 0, r: 0 };
    state.gen += 1;
    mountVideo('L', trial.left, 'l');
    mountVideo('R', trial.right, 'r');
    state.trialStart = Date.now();
    updateSubmit();
    window.scrollTo(0, 0);
  }

  function mountVideo(slotKey, info, side) {
    var slot = $('slot' + slotKey);
    slot.textContent = '';
    var v = document.createElement('video');
    v.controls = true;
    v.preload = 'auto';
    v.muted = true;
    v.autoplay = true;               // starts by itself (muted videos may autoplay)
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('controlslist', 'nodownload noremoteplayback');
    v.disablePictureInPicture = true;
    if (info.p) v.poster = info.p;
    v.src = info.v;
    v.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    slot.appendChild(v);
    trackWatch(v, side);
    var p = v.play();
    if (p && p.catch) p.catch(function () { /* the user can press play */ });
  }

  // Records (without enforcing anything) how much of each video was played.
  function trackWatch(video, side) {
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
      state.watch[side] = sum / buckets.length;
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

  function playBoth() {
    var vids = [$('slotL').querySelector('video'), $('slotR').querySelector('video')];
    vids.forEach(function (v) { if (v) { v.pause(); v.currentTime = 0; } });
    vids.forEach(function (v) {
      if (!v) return;
      var p = v.play();
      if (p && p.catch) p.catch(function () { /* ignore */ });
    });
  }

  function stopVideos() {
    Array.prototype.forEach.call(document.querySelectorAll('.video-slot video'), function (v) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    });
  }

  function collectAnswers() {
    var values = {}, missing = 0;
    S.criteria.forEach(function (c) {
      var checked = $('questions').querySelector('input[name="' + c.id + '"]:checked');
      if (checked) values[c.id] = checked.value; else missing += 1;
    });
    return { values: values, missing: missing };
  }

  function updateSubmit() {
    $('submitBtn').disabled = collectAnswers().missing > 0;
  }

  function submit() {
    var answers = collectAnswers();
    if (answers.missing) return;
    var trial = state.trials[state.index];
    var q = queue();
    q.push({
      rid: randomId(),
      study_id: S.study_id,
      annotator: state.annotator,
      session_id: state.sessionId,
      item_id: trial.item,
      kind: trial.kind,
      story_id: trial.story,
      left_media: mediaName(trial.left.v),
      right_media: mediaName(trial.right.v),
      answers: answers.values,
      left_watch: Math.round(state.watch.l * 1000) / 1000,
      right_watch: Math.round(state.watch.r * 1000) / 1000,
      duration_ms: Date.now() - state.trialStart,
      round: trial.round,
      position: state.index,
      client_time: new Date().toISOString(),
      user_agent: (navigator.userAgent || '').slice(0, 400)
    });
    saveQueue(q);
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
    show('done');
    var ok = await flush();
    $('doneWarn').hidden = ok;
    $('doneWarn').textContent = ok ? '' : '有 ' + queue().length + ' 条答案还没上传，请保持联网，点上方“重试”。';
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
    S.pairs.forEach(function (p) { pairById[p.id] = p; });
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
    $('playBoth').addEventListener('click', playBoth);
    $('submitBtn').addEventListener('click', submit);
    $('syncRetry').addEventListener('click', function () { flush(); });
    $('continueBtn').addEventListener('click', newBatch);
    $('finishBtn').addEventListener('click', function () { message('谢谢参与！', '可以关闭页面了。'); });
    window.addEventListener('beforeunload', function (e) {
      if ((!$('view-trial').hidden && state.dirty) || queue().length) { e.preventDefault(); e.returnValue = ''; }
    });
    show('welcome');
    var local = ['localhost', '127.0.0.1'].indexOf(window.location.hostname) >= 0;
    if (local) window.__vps = { flush: flush, queue: queue };  // hooks for local tests only
    if (params.get('autostart') === '1' && local) start();     // local testing only
  }

  init();
})();
