// non-blocking toast helper (micro-copy of main.js helper)
(function () {
  function _injectToastStyles() {
    if (document.getElementById('site-toast-styles')) return;
    var s = document.createElement('style');
    s.id = 'site-toast-styles';
  s.textContent = '\n.site-toast{position:fixed;right:20px;bottom:20px;background:linear-gradient(180deg, rgba(0,0,0,0.92), rgba(0,0,0,0.86));color:#fff;padding:10px 14px;border-radius:8px;font-size:15px;line-height:1.25;z-index:1000000;opacity:0;transform:translateY(10px);transition:opacity .22s,transform .22s;box-shadow:0 6px 20px rgba(0,0,0,0.35);max-width:420px;text-align:left}\n.site-toast.visible{opacity:1;transform:translateY(0)}\n';
    document.head.appendChild(s);
  }
  function showToast(msg, ms) {
    try {
      _injectToastStyles();
      ms = typeof ms === 'number' ? ms : 4500;
      var t = document.createElement('div');
      t.className = 'site-toast';
      t.textContent = String(msg || '');
      document.body.appendChild(t);
      requestAnimationFrame(function () { t.classList.add('visible'); });
      setTimeout(function () { t.classList.remove('visible'); }, ms - 300);
      setTimeout(function () { try { t.remove(); } catch (e) {} }, ms);
      return t;
    } catch (e) { console.warn('showToast failed', e); }
  }

  // show initial load message once on page open
  try { if (document.readyState === 'complete' || document.readyState === 'interactive') { showToast('Due to high demand, camera data may take a few minutes to initially load', 11000); } else { window.addEventListener('DOMContentLoaded', function () { showToast('Due to high demand, camera data may take a few minutes to initially load', 11000); }); } } catch (e) {}
  // Ordered camera IDs copied from main app
  var orderedCameraIds = [3429,3498,3416,3415,3414,3413,3882,3909,3410,3412,3411,4036];

  // NV Roads endpoint proxied through the provided workers.dev proxy to bypass CORS
  var nvDefault = 'https://wispy-flower-cdf3.100brightli.workers.dev/?url=https://www.nvroads.com/List/GetData/Cameras?query=%7B%22columns%22%3A%5B%7B%22data%22%3Anull%2C%22name%22%3A%22%22%7D%2C%7B%22name%22%3A%22sortOrder%22%2C%22s%22%3Atrue%7D%2C%7B%22name%22%3A%22region%22%2C%22s%22%3Atrue%7D%2C%7B%22name%22%3A%22roadway%22%2C%22s%22%3Atrue%7D%2C%7B%22data%22%3A4%2C%22name%22%3A%22%22%7D%5D%2C%22order%22%3A%5B%7B%22column%22%3A1%2C%22dir%22%3A%22asc%22%7D%2C%7B%22column%22%3A2%2C%22dir%22%3A%22asc%22%7D%2C%7B%22column%22%3A3%2C%22dir%22%3A%22asc%22%7D%5D%2C%22start%22%3A0%2C%22length%22%3A17%2C%22search%22%3A%7B%22value%22%3A%22f1%22%7D%7D&lang=en-US';

  var grid = document.getElementById('grid');

  function ensureHls() {
    return new Promise(function (resolve) {
      if (window.Hls) return resolve(window.Hls);
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.4.2/dist/hls.min.js';
      s.async = true;
      s.onload = function () { resolve(window.Hls); };
      s.onerror = function () { resolve(null); };
      document.head.appendChild(s);
    });
  }

  // Helper to create a cell for a camera
  function makeCell(cam, idx) {
    var cell = document.createElement('div');
    cell.className = 'cell';

  var v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.autoplay = true; v.controls = false;
    v.style.background = '#000';
    cell.appendChild(v);

  // clear status when video actually starts playing or can play
  v.addEventListener('playing', function () { try { setStatus(''); } catch (e) {} });
  v.addEventListener('canplay', function () { try { setStatus(''); } catch (e) {} });
  v.addEventListener('loadeddata', function () { try { setStatus(''); } catch (e) {} });

  // status overlay to show why a cell may be empty / loading / errored
  var status = document.createElement('div');
  status.style.position = 'absolute';
  status.style.left = '50%';
  status.style.top = '50%';
  status.style.transform = 'translate(-50%, -50%)';
  status.style.background = 'rgba(0,0,0,0.6)';
  status.style.color = '#fff';
  status.style.padding = '8px 10px';
  status.style.borderRadius = '6px';
  status.style.fontSize = '13px';
  status.style.zIndex = 10;
  status.textContent = '';
  // start hidden; use setStatus() to show/hide
  status.style.display = 'none';
  function setStatus(txt) {
    try {
      if (!txt) {
  status.textContent = '';
        status.style.display = 'none';
      } else {
  status.textContent = txt;
        status.style.display = 'block';
      }
    } catch (e) {}
  }
  cell.appendChild(status);

  var label = document.createElement('div'); label.className = 'label';
  label.textContent = cam.title || ('Camera ' + cam.id);
  cell.appendChild(label);

  var idxEl = document.createElement('div'); idxEl.className = 'index'; idxEl.textContent = (typeof idx === 'number' ? (idx + 1) : '') ; cell.appendChild(idxEl);

    cell.addEventListener('click', function () {
      try {
        if (v.paused) v.play().catch(function(){}); else v.pause();
      } catch(e){}
    });

    // attach player (Hls or native), but first probe the URL to surface network activity/CORS
    (function (videoEl, camObj) {
      var url = camObj.videoUrl;
      if (!url) {
        setStatus('No stream URL');
        return; // no stream
      }

  setStatus('Checking…');
      // Probe the manifest with a fetch so the Network tab shows attempted requests (and CORS errors)
      // Use a short timeout via Promise.race in case the request hangs.
      var probe = function (u, timeoutMs) {
        return new Promise(function (resolve) {
          var done = false;
          var timer = setTimeout(function () { if (!done) { done = true; resolve({ ok: false, reason: 'timeout' }); } }, timeoutMs || 6000);
          fetch(u, { method: 'GET', mode: 'cors', cache: 'no-store' }).then(function (r) {
            if (done) return;
            done = true; clearTimeout(timer);
            resolve({ ok: !!(r && r.ok), status: r && r.status });
          }).catch(function (err) {
            if (done) return;
            done = true; clearTimeout(timer);
            resolve({ ok: false, reason: (err && err.message) || String(err) });
          });
        });
      };

      probe(url, 5000).then(function (res) {
        try {
          if (res && res.ok) {
            setStatus('Loading stream…');
          } else if (res && res.status) {
            setStatus('HTTP ' + res.status);
          } else if (res && res.reason) {
            setStatus('Probe error');
            console.warn('Probe error for', url, res.reason);
          } else {
            setStatus('No response');
          }
          } catch (e) {
            try { videoEl.src = url; videoEl.play().catch(function(){}); } catch (er) { setStatus('Error'); }
          }
        // attempt to attach player regardless (so Hls will attempt manifest fetch too)
        ensureHls().then(function (Hls) {
          try {
            if (Hls && Hls.isSupported() && String(url).indexOf('.m3u8') !== -1) {
                var h = new Hls({ enableWorker:true });
                  h.on && h.on(Hls.Events.MANIFEST_PARSED, function () { try { setStatus(''); } catch (e) {} });
                  h.on && h.on(Hls.Events.ERROR, function (ev, data) {
                    try {
                      console.warn('HLS error', data);
                      // Only react to fatal errors; debounce showing the UI in case recovery succeeds
                      if (data && data.fatal) {
                        // clear previous timer if any
                        try { if (videoEl._errorTimer) { clearTimeout(videoEl._errorTimer); videoEl._errorTimer = null; } } catch (e) {}
                        // attempt automatic recovery for common errors
                        try {
                          if (data.type === 'mediaError' && typeof h.recoverMediaError === 'function') {
                            h.recoverMediaError();
                          } else if (data.type === 'networkError') {
                            // try to reload fragments
                            h.startLoad && h.startLoad();
                          }
                        } catch (e) {}
                        // show status only if error persists after 2s
                        videoEl._errorTimer = setTimeout(function () {
                          try { setStatus('Stream error'); } catch (e) {}
                          videoEl._errorTimer = null;
                        }, 2000);
                      }
                    } catch (e) {}
                  });
                  // When fragments buffer, clear any pending error indicator
                  h.on && h.on(Hls.Events.FRAG_BUFFERED, function () { try { if (videoEl._errorTimer) { clearTimeout(videoEl._errorTimer); videoEl._errorTimer = null; } setStatus(''); } catch (e) {} });
                h.loadSource(url);
                h.attachMedia(videoEl);
                videoEl.play().catch(function(){});
                // store h on element to cleanup later
                videoEl._hls = h;

                // Live-sync: if player is behind live edge by >1.5s, jump to live.
                // Use Hls.liveSyncPosition when available, otherwise estimate from buffered end.
                var liveCheck = function () {
                  try {
                    var livePos = (h && h.liveSyncPosition) || null;
                    // fallback: try to compute buffered end - some streams expose target duration
                    if (livePos == null && videoEl.buffered && videoEl.buffered.length) {
                      livePos = videoEl.buffered.end(videoEl.buffered.length - 1);
                    }
                    if (!livePos || !isFinite(livePos)) return;
                    var cur = videoEl.currentTime || 0;
                    var lag = livePos - cur;
                    if (lag > 1.5) {
                      // jump to the live position (slightly behind to avoid rebuffer)
                      var target = Math.max(0, livePos - 0.5);
                      try { videoEl.currentTime = target; } catch (e) { try { videoEl.seek && videoEl.seek(target); } catch (er) {} }
                    }
                  } catch (e) {}
                };
                // run once per second while element is in DOM
                videoEl._liveInterval = setInterval(liveCheck, 1000);

                // cleanup on video error or when the element is removed
                var cleanup = function () {
                  try { if (videoEl._liveInterval) { clearInterval(videoEl._liveInterval); videoEl._liveInterval = null; } } catch (e) {}
                  try { if (videoEl._hls) { videoEl._hls.destroy && videoEl._hls.destroy(); videoEl._hls = null; } } catch (e) {}
                };
                videoEl.addEventListener('error', cleanup);

                // observe removal from DOM to cleanup resources
                var mo = new MutationObserver(function () {
                  if (!document.body.contains(videoEl)) {
                    cleanup();
                    try { mo.disconnect(); } catch (e) {}
                  }
                });
                mo.observe(document.body, { childList:true, subtree:true });
              } else {
                videoEl.src = url;
                videoEl.addEventListener('loadeddata', function () { try { setStatus(''); } catch (e) {} });
                videoEl.addEventListener('error', function () { try { setStatus('Playback error'); } catch (e) {} });
                videoEl.play().catch(function(){});
              }
          } catch (e) {
            try { videoEl.src = url; videoEl.play().catch(function(){}); } catch (er) { setStatus('Error'); }
          }
  }).catch(function () { try { videoEl.src = url; videoEl.play().catch(function(){}); } catch (e) { setStatus('Error'); } });
      });
    })(v, cam);

    return cell;
  }

  // Simple fetch of cameras, then build grid using orderedCameraIds
  (async function () {
    var payload = null;
    try {
      var r = await fetch(nvDefault, { cache:'no-store', mode:'cors' });
      if (r && r.ok) payload = await r.json();
    } catch (e) { /* ignore */ }

    // normalize to array of items
    var arr = null;
    if (Array.isArray(payload)) arr = payload;
    else if (payload && Array.isArray(payload.data)) arr = payload.data;
    else if (payload && Array.isArray(payload.rows)) arr = payload.rows;

    // build a simple map id->item for quick lookups
    var byId = {};
    if (Array.isArray(arr)) {
      arr.forEach(function (it) { if (it && it.id != null) byId[it.id] = it; });
    }

    // If fetch failed or items missing, attempt to read from parent page's camera-json element
    if (!Object.keys(byId).length) {
      try {
        var el = window.opener ? window.opener.document.getElementById('camera-json') : document.getElementById('camera-json');
        if (el) {
          var txt = el.textContent || el.innerText || '';
          if (txt) {
            try {
              var parsed = JSON.parse(txt);
              var src = Array.isArray(parsed) ? parsed : (parsed && parsed.data) || null;
              if (Array.isArray(src)) src.forEach(function (it) { if (it && it.id != null) byId[it.id] = it; });
            } catch (e) {}
          }
        }
      } catch (e) {}
    }

    // Build the grid — use orderedCameraIds array and create placeholder cells for missing items
    orderedCameraIds.forEach(function (id, i) {
      var item = byId[id] || { id: id, title: 'Camera ' + id, videoUrl: null };
      // try to extract video URL field from common payload shapes
      if (!item.videoUrl) {
        try {
          if (item.images && item.images.length && item.images[0].videoUrl) item.videoUrl = item.images[0].videoUrl;
          else if (item.videoUrl) item.videoUrl = item.videoUrl;
        } catch (e) {}
      }
      var c = makeCell({ id: id, title: item.location || item.roadway || item.title || ('Camera ' + id), videoUrl: item.videoUrl }, i);
      grid.appendChild(c);
    });

    // if no streams available, show a message
    if (grid.children.length === 0) {
      var p = document.createElement('div'); p.textContent = 'No camera data available.'; document.body.appendChild(p);
    }
  })();
})();
