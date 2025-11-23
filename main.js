// main.js — initialize map, load track GeoJSON, fetch standings, and wire UI
// small non-blocking toast helper replaces modal alert() so the page doesn't pause
(function () {
    'use strict';

    // Minimal toast notification helper (non-blocking)
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
            // allow CSS to apply
            requestAnimationFrame(function () { t.classList.add('visible'); });
            setTimeout(function () { t.classList.remove('visible'); }, ms - 300);
            setTimeout(function () { try { t.remove(); } catch (e) {} }, ms);
            return t;
        } catch (e) { try { console.warn('showToast failed', e); } catch (er) {} }
    }

    // Show the initial non-blocking notice once on page load
    try { if (document.readyState === 'complete' || document.readyState === 'interactive') { showToast('Due to high demand, camera data may take a few minutes to initially load', 11000); } else { window.addEventListener('DOMContentLoaded', function () { showToast('Due to high demand, camera data may take a few minutes to initially load', 11000); }); } } catch (e) {}

    // Utility: safe parse floats
    function toFloat(n, fallback) {
        var v = parseFloat(String(n).replace(/[^0-9+\-\.eE]/g, ''));
        return Number.isFinite(v) ? v : fallback;
    }

    // Main app initialization extracted so we can call it after loading Leaflet dynamically if needed
    function initApp() {
        var mapEl = document.getElementById('map');
        if (!mapEl) return console.warn('Map element not found');

        // Read dataset config
        var ds = mapEl.dataset || {};
        var centerStr = ds.mapCenter || '36.147, -115.160';
        var centerParts = centerStr.split(',').map(function (s) { return s.trim(); });
        var centerLat = toFloat(centerParts[0], 36.147);
        var centerLng = toFloat(centerParts[1], -115.160);

    var maxbounds = null;
        if (ds.mapMaxbounds) {
            var parts = ds.mapMaxbounds.split(',').map(function (s) { return toFloat(s.trim(), NaN); });
            if (parts.length === 4 && parts.every(function (p) { return Number.isFinite(p); })) {
                var sw = [parts[0], parts[1]];
                var ne = [parts[2], parts[3]];
                // Leaflet expects [lat,lng]
                maxbounds = L.latLngBounds(L.latLng(sw[0], sw[1]), L.latLng(ne[0], ne[1]));
            }
        }

        // keep original bounds so we can temporarily relax them at high zoom
        var originalMaxBounds = maxbounds;
        var boundsPermanentlyRemoved = false;
        var boundsTemporarilyRemoved = false;

        // Create map
        var map = L.map('map', {
            center: [centerLat, centerLng],
            zoom: 15,
            zoomControl: true,
            attributionControl: true,
            maxBounds: maxbounds || undefined,
            maxBoundsViscosity: 0.9
        });

        // Utility to relax or remove max bounds (user reported bounds too restrictive)
        function relaxBounds() {
            try {
                map.setMaxBounds(null);
                boundsPermanentlyRemoved = true;
                console.info('Map maxBounds removed to allow panning further.');
            } catch (e) { console.warn(e); }
        }

        // When user zooms in, temporarily relax bounds (pad them and lower viscosity)
        // so the geographic coordinates remain bounded but panning is more forgiving.
        // When they zoom back out, restore the original bounds and viscosity
        map.on('zoomend', function () {
            try {
                var z = map.getZoom();
                var threshold = 17; // zoom level at which we relax bounds
                if (originalMaxBounds && !boundsPermanentlyRemoved) {
                    if (z >= threshold && !boundsTemporarilyRemoved) {
                        // Pad bounds proportionally to how far past the threshold we are
                        var zoomOver = Math.max(0, z - threshold);
                        var pad = Math.min(1.5, 0.2 + zoomOver * 0.15); // clamp pad
                        var padded = originalMaxBounds.pad(pad);
                        map.setMaxBounds(padded);
                        // make the bounds less 'sticky' while zoomed in
                        try { map.options.maxBoundsViscosity = 0.2; } catch (e) { }
                        boundsTemporarilyRemoved = true;
                        console.info('Temporarily relaxed maxBounds (pad=' + pad.toFixed(2) + ') at zoom ' + z);
                    } else if (z < threshold && boundsTemporarilyRemoved) {
                        map.setMaxBounds(originalMaxBounds);
                        try { map.options.maxBoundsViscosity = 0.9; } catch (e) { }
                        boundsTemporarilyRemoved = false;
                        console.info('Restored maxBounds after zoom out (' + z + ')');
                    }
                }
            } catch (e) {
                console.warn('Error handling zoom bounds behavior', e);
            }
        });

        // Add Esri World Imagery (satellite) tiles for a clean satellite view
        var esriUrl = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
        var tileLayerRef = L.tileLayer(esriUrl, {
            maxZoom: 19,
            minZoom:15,
            maxNativeZoom: 19,
            tileSize: 256,
            // a small placeholder image for failed tiles (data URI svg)
            errorTileUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="100%" height="100%" fill="%23f2f2f2"/><text x="50%" y="50" dominant-baseline="middle" text-anchor="middle" fill="%23999" font-size="14">Tile unavailable</text></svg>',
            // Slightly smoother zoom transitions on some tile servers
            updateWhenIdle: false,
            attribution: ds.tileAttribution || 'Esri World Imagery'
        }).addTo(map);

        // Camera markers layer (initially hidden)
        var cameraLayer = L.layerGroup();
    // Keep a map of camera id -> objects (marker, videoEl, ctrlWrap, url)
    var cameraById = {};
    var mainTrackLayer = null;

        // Simple camera icon using an emoji with a white rounded background so it remains readable on any tiles.
        // Use L.divIcon so no external assets needed.
        var cameraIcon = L.divIcon({
            className: 'camera-icon',
            html: '<div style="display:inline-flex;align-items:center;justify-content:center;background:#fff;border-radius:6px;padding:2px;box-shadow:0 1px 2px rgba(0,0,0,0.18);font-size:16px;line-height:18px;">📷</div>',
            iconSize: [26, 26],
            iconAnchor: [13, 13]
        });

        // Helper: parse WKT POINT like "POINT (-115.16383 36.11436)" -> [lat, lng]
        function parseWktPoint(wkt) {
            if (!wkt || typeof wkt !== 'string') return null;
            var m = /POINT\s*\(\s*([\-0-9\.]+)\s+([\-0-9\.]+)\s*\)/i.exec(wkt.trim());
            if (!m) return null;
            var lng = parseFloat(m[1]);
            var lat = parseFloat(m[2]);
            if (!isFinite(lat) || !isFinite(lng)) return null;
            return [lat, lng];
        }

        // Helper to dynamically load hls.js for playing .m3u8 in non-Safari browsers
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

        // Basic HTML-escape for popup content
        function escHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

        // Add markers from an array of camera items (matches the 'data' array in your JSON)
        function addCameraMarkersFromArray(items) {
            if (!Array.isArray(items)) return;
            cameraLayer.clearLayers();
            // clear existing list UI if present
            var listWrap = document.getElementById('camera-list');
            if (listWrap) listWrap.innerHTML = '';

            var total = items.length;
            var skipped = [];
            var created = [];

            items.forEach(function (it, idx) {
                try {
                    var wkt = it && it.latLng && it.latLng.geography && it.latLng.geography.wellKnownText;
                    var coords = parseWktPoint(wkt);
                    if (!coords) {
                        skipped.push({ id: it && it.id, reason: 'invalid coords', wkt: wkt });
                        return;
                    }
                    var marker = L.marker(coords, { icon: cameraIcon, title: it.location || it.roadway || 'Camera' });
                    // Build popup DOM so we can embed a video element when available
                    try {
                        var popup = document.createElement('div');
                        popup.style.minWidth = '220px';
                        popup.style.maxWidth = '420px';

                        var titleEl = document.createElement('div');
                        titleEl.style.fontWeight = '600';
                        titleEl.style.marginBottom = '6px';
                        titleEl.textContent = it.location || it.roadway || 'Camera';
                        popup.appendChild(titleEl);

                        // Camera image removed: thumbnails are intentionally omitted to keep popups compact.

                        // If a video URL (likely an m3u8 playlist) is provided, embed a video element
                        var videoUrl = null;
                        if (it.images && it.images.length && it.images[0].videoUrl) videoUrl = it.images[0].videoUrl;
                        if (!videoUrl && it.videoUrl) videoUrl = it.videoUrl;

                        if (videoUrl) {
                            var vidWrap = document.createElement('div');
                            vidWrap.style.width = '100%';
                            vidWrap.style.marginBottom = '6px';

                            var videoEl = document.createElement('video');
                            // use custom controls for a 'live' feel: hide native controls to remove timestamp/slider
                            videoEl.controls = false;
                            videoEl.muted = true; // start muted to allow autoplay in many browsers
                            videoEl.playsInline = true;
                            videoEl.style.width = '100%';
                            videoEl.style.borderRadius = '6px';
                            videoEl.autoplay = false;

                            // Small note / control container for users
                            var ctrlWrap = document.createElement('div');
                            ctrlWrap.style.display = 'flex';
                            ctrlWrap.style.alignItems = 'center';
                            ctrlWrap.style.justifyContent = 'space-between';
                            ctrlWrap.style.marginTop = '6px';

                            var leftControls = document.createElement('div');
                            leftControls.style.display = 'flex';
                            leftControls.style.gap = '8px';

                            var playBtn = document.createElement('button');
                            playBtn.type = 'button';
                            // nicer circular play/pause button
                            playBtn.innerHTML = '▸';
                            playBtn.title = 'Play / Pause';
                            playBtn.style.fontSize = '14px';
                            playBtn.style.width = '36px';
                            playBtn.style.height = '36px';
                            playBtn.style.display = 'inline-flex';
                            playBtn.style.alignItems = 'center';
                            playBtn.style.justifyContent = 'center';
                            playBtn.style.padding = '0';
                            playBtn.style.borderRadius = '50%';
                            playBtn.style.border = 'none';
                            playBtn.style.background = '#ffffff';
                            playBtn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.12)';
                            playBtn.style.cursor = 'pointer';

                            var liveBadge = document.createElement('span');
                            liveBadge.textContent = 'LIVE';
                            liveBadge.style.background = '#d9534f';
                            liveBadge.style.color = '#fff';
                            liveBadge.style.fontSize = '12px';
                            liveBadge.style.padding = '4px 6px';
                            liveBadge.style.borderRadius = '4px';

                            leftControls.appendChild(playBtn);
                            // Fullscreen button to expand video and shrink map
                            var fsBtn = document.createElement('button');
                            fsBtn.type = 'button';
                            fsBtn.title = 'Fullscreen view';
                            fsBtn.textContent = '⤢';
                            fsBtn.style.fontSize = '14px';
                            fsBtn.style.width = '36px';
                            fsBtn.style.height = '36px';
                            fsBtn.style.display = 'inline-flex';
                            fsBtn.style.alignItems = 'center';
                            fsBtn.style.justifyContent = 'center';
                            fsBtn.style.padding = '0';
                            fsBtn.style.borderRadius = '50%';
                            fsBtn.style.border = 'none';
                            fsBtn.style.background = '#fff';
                            fsBtn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.12)';
                            fsBtn.style.cursor = 'pointer';
                            leftControls.appendChild(fsBtn);
                            ctrlWrap.appendChild(leftControls);
                            ctrlWrap.appendChild(liveBadge);

                            // Keep the player pinned to the live edge while playing.
                            // Refined approach: only seek when clearly behind (>1.5s) and avoid seeking while already seeking.
                            var liveSyncInterval = null;
                            var isSeeking = false;
                            var lastSeek = 0;
                            function startLiveSync(hlsInstance) {
                                stopLiveSync();
                                liveSyncInterval = setInterval(function () {
                                    try {
                                        if (videoEl.paused || isSeeking) return;

                                        var target = null;
                                        // If Hls instance has a recommended live sync position use it (helps avoid chasing segment boundaries)
                                        try {
                                            if (hlsInstance && typeof hlsInstance.liveSyncPosition === 'number' && hlsInstance.levels) {
                                                // hls.js provides a liveSyncPosition which is often the best seek target
                                                target = hlsInstance.liveSyncPosition;
                                            }
                                        } catch (e) {}

                                        if (target == null) {
                                            var b = videoEl.buffered;
                                            if (b && b.length) {
                                                var end = b.end(b.length - 1);
                                                target = Math.max(0, end - 0.5);
                                            }
                                        }

                                        if (target == null) return;

                                        var lag = target - videoEl.currentTime;
                                        // Only jump if we're more than 1.5s behind to avoid tiny repeated seeks
                                        if (lag > 1.5 && Date.now() - lastSeek > 800) {
                                            isSeeking = true;
                                            try {
                                                videoEl.currentTime = target;
                                                lastSeek = Date.now();
                                            } catch (e) { }
                                            // allow some time for the browser to process the seek
                                            setTimeout(function () { isSeeking = false; }, 600);
                                        }
                                    } catch (e) { }
                                }, 800);
                            }
                            function stopLiveSync() { if (liveSyncInterval) { clearInterval(liveSyncInterval); liveSyncInterval = null; } isSeeking = false; }

                            // Wire play button — if media isn't initialized yet, initialize when the user hits play or opens the popup
                            var hlsInstance = null;
                            var mediaInitialized = false;
                                var timeInterval = null;
                                var fragTimeInfo = null; // { pd: Date, start: startPTS }

                            function initMedia() {
                                if (mediaInitialized) return;
                                mediaInitialized = true;
                                ensureHls().then(function (Hls) {
                                    try {
                                        if (Hls && Hls.isSupported()) {
                                                    hlsInstance = new Hls({ enableWorker: true, lowLatencyMode: true, liveSyncDurationCount: 3, maxBufferLength: 30 });
                                                    hlsInstance.loadSource(videoUrl);
                                                    hlsInstance.attachMedia(videoEl);
                                                    // attach fragment listeners to capture program-date-time when present
                                                    try {
                                                        hlsInstance.on && hlsInstance.on(Hls.Events.FRAG_CHANGED, function (ev, data) {
                                                            try {
                                                                var f = data && data.frag;
                                                                if (f && f.programDateTime) fragTimeInfo = { pd: new Date(f.programDateTime), start: f.startPTS };
                                                            } catch (e) {}
                                                        });
                                                        hlsInstance.on && hlsInstance.on(Hls.Events.FRAG_BUFFERED, function (ev, data) {
                                                            try {
                                                                var f = data && data.frag;
                                                                if (f && f.programDateTime) fragTimeInfo = { pd: new Date(f.programDateTime), start: f.startPTS };
                                                            } catch (e) {}
                                                        });
                                                    } catch (e) {}
                                            // attempt autoplay (muted) for UX; user can unmute
                                            videoEl.play().catch(function () { /* ignore autoplay */ });
                                            liveBadge.textContent = 'LIVE';
                                            // store the Hls instance on the marker element so we can reuse it later
                                            try { marker._hlsInstance = hlsInstance; marker._videoEl = videoEl; } catch (e) {}
                                            // start/stop live sync wired on play/pause events below
                                        } else {
                                            // Safari / browsers with native HLS support
                                            videoEl.src = videoUrl;
                                            liveBadge.textContent = 'LIVE';
                                        }
                                    } catch (e) {
                                        // fallback: provide link
                                        var link = document.createElement('a'); link.href = videoUrl; link.target = '_blank'; link.textContent = 'Open stream in new tab';
                                        try { ctrlWrap.parentNode.appendChild(link); } catch (err) { }
                                    }

                                            // time overlay removed per user preference

                                            // wire play/pause listeners that control live sync
                                    videoEl.addEventListener('play', function () { playBtn.innerHTML = '⏸'; startLiveSync(hlsInstance); });
                                    videoEl.addEventListener('pause', function () { playBtn.innerHTML = '▸'; stopLiveSync(); });
                                }).catch(function () {
                                    try { videoEl.src = videoUrl; } catch (e) { }
                                    videoEl.addEventListener('play', function () { playBtn.innerHTML = '⏸'; startLiveSync(null); });
                                    videoEl.addEventListener('pause', function () { playBtn.innerHTML = '▸'; stopLiveSync(); });
                                });
                            }

                            playBtn.addEventListener('click', function () {
                                // initialize media on first interaction
                                if (!mediaInitialized) {
                                    initMedia();
                                    // try to start playback shortly after initialization
                                    setTimeout(function () { try { videoEl.play().catch(function () { }); } catch (e) { } }, 300);
                                    return;
                                }
                                if (videoEl.paused) {
                                    videoEl.play().catch(function () { /* ignore */ });
                                } else {
                                    videoEl.pause();
                                }
                            });

                            // Initialize media when popup opens, and tear down when it closes to save bandwidth
                            marker.on('popupopen', function () { 
                                // update active styling when a popup opens
                                try { updateMarkerActiveState(it && it.id); } catch (e) {}
                                initMedia(); 
                            });
                            marker.on('popupclose', function () {
                                try { videoEl.pause(); } catch (e) { }
                                try { stopLiveSync(); } catch (e) { }
                                try {
                                    // detach media but do not destroy the Hls instance so it can be reused
                                    if (hlsInstance) {
                                        try { hlsInstance.detachMedia(); } catch (e) {}
                                        // keep hlsInstance on marker._hlsInstance for reuse
                                        marker._hlsInstance = hlsInstance;
                                    }
                                } catch (e) { }
                                try { videoEl.removeAttribute('src'); videoEl.src = ''; videoEl.load(); } catch (e) { }
                                try { if (timeInterval) { clearInterval(timeInterval); timeInterval = null; } } catch (e) {}
                                try { /* popup time element removed per user preference */ } catch (e) {}
                                fragTimeInfo = null;
                                mediaInitialized = false;
                                playBtn.innerHTML = '▸';
                            });

                            vidWrap.appendChild(videoEl);
                            vidWrap.appendChild(ctrlWrap);
                            popup.appendChild(vidWrap);

                            // Wire fullscreen button (defined above) to open overlay for this camera
                            (function (camId, vEl, url, markerRef) {
                                fsBtn.addEventListener('click', function () {
                                    openCameraFullscreen(camId, vEl, url, markerRef);
                                });
                            })(it && it.id, videoEl, videoUrl, marker);
                        }

                        // include ID as small text
                        if (it.id) {
                            var idEl = document.createElement('div');
                            idEl.style.fontSize = '12px';
                            idEl.style.color = '#666';
                            idEl.textContent = 'ID: ' + it.id;
                            popup.appendChild(idEl);
                        }

                        marker.bindPopup(popup, { maxWidth: 420 });

                        // Preserve the original popup DOM node so we can temporarily replace it
                        // while in fullscreen and restore it intact (preserving video elements and handlers).
                        try {
                            (function (m, originalNode, titleText, camId) {
                                m.on && m.on('click', function () {
                                    try {
                                        if (fsOverlay && fsOverlay.style.display && fsOverlay.style.display !== 'none') {
                                            var p = m.getPopup && m.getPopup();
                                            if (p) {
                                                var minimal = document.createElement('div');
                                                minimal.style.fontWeight = '600'; minimal.style.padding = '6px';
                                                minimal.textContent = titleText;
                                                p.setContent(minimal);
                                            }
                                        }
                                    } catch (e) { }
                                });

                                // Restore original popup DOM when it closes
                                m.on && m.on('popupclose', function () {
                                    try {
                                        var p = m.getPopup && m.getPopup();
                                        if (p && originalNode) p.setContent(originalNode);
                                    } catch (e) { }
                                });
                            })(marker, popup, (it.location || it.roadway || 'Camera'), it && it.id);
                        } catch (e) { }

                        // store references for later fullscreen/navigation features
                        try {
                            if (it && it.id != null) {
                                // compute a stable human-readable title from available fields so
                                // the mini-map and other UI can show a friendly name instead
                                // of falling back to the numeric id.
                                var titleText = (it.location || it.roadway || it.name || it.cameraName || ('Camera ' + (it.id || '')));
                                cameraById[it.id] = {
                                    marker: marker,
                                    videoEl: (typeof videoEl !== 'undefined' ? videoEl : null),
                                    ctrlWrap: (typeof ctrlWrap !== 'undefined' ? ctrlWrap : null),
                                    videoUrl: videoUrl,
                                    coords: coords,
                                    title: titleText,
                                    raw: it
                                };
                            }
                        } catch (e) { }
                    } catch (e) {
                        // fallback to simple popup if DOM construction fails
                        var html = '<strong>' + escHtml(it.location || it.roadway || 'Camera') + '</strong>';
                        if (it.images && it.images.length) {
                            var img = it.images[0];
                            if (img.videoUrl) html += '<br><a href="' + escHtml(img.videoUrl) + '" target="_blank">Live video</a>';
                        }
                        if (it.id) html += '<br><small>ID: ' + escHtml(it.id) + '</small>';
                        marker.bindPopup(html);
                    }
                    cameraLayer.addLayer(marker);
                    created.push({ id: it && it.id, coords: coords, title: it.location || it.roadway || 'Camera' });

                    // warm playlist if present to reduce switch latency later
                    try { if (videoUrl && it && it.id) prefetchPlaylist(videoUrl, it.id); } catch (e) {}

                    // append to list UI if present
                    try {
                        if (!listWrap) {
                            // create the list container once if missing
                            var legend = document.getElementById('map-legend');
                            if (legend) {
                                listWrap = document.createElement('div');
                                listWrap.id = 'camera-list';
                                listWrap.style.marginTop = '8px';
                                listWrap.style.background = '#fff';
                                listWrap.style.padding = '6px';
                                listWrap.style.borderRadius = '6px';
                                listWrap.style.maxHeight = '160px';
                                listWrap.style.overflow = 'auto';
                                listWrap.style.boxShadow = '0 6px 18px rgba(0,0,0,0.06)';
                                listWrap.innerHTML = '<strong>Traffic Cameras</strong><div id="camera-count" style="font-size:12px;margin-top:4px;color:#444">Loading…</div>';
                                legend.appendChild(listWrap);
                            }
                        }
                        if (listWrap) {
                            var entry = document.createElement('div');
                            entry.style.padding = '4px 2px';
                            entry.style.borderBottom = '1px solid rgba(0,0,0,0.06)';
                            entry.style.cursor = 'pointer';
                            entry.textContent = it.location || it.roadway || ('Camera ' + (it.id || ''));
                            (function (coords, marker) {
                                entry.addEventListener('click', function () {
                                        try { map.setView(coords, Math.max(map.getZoom(), 17)); marker.openPopup(); try { updateMarkerActiveState(it && it.id); } catch (e) {} } catch (e) { }
                                    });
                            })(coords, marker);
                            listWrap.appendChild(entry);
                        }
                    } catch (e) { /* ignore UI errors */ }
                } catch (e) {
                    skipped.push({ id: (it && it.id) || ('index:' + idx), reason: 'exception', error: String(e) });
                    console.warn('Failed to add camera item', e, it);
                }
            });

            // update count display and log diagnostics
            try {
                var cnt = cameraLayer.getLayers().length;
                var cntEl = document.getElementById('camera-count');
                if (cntEl) cntEl.textContent = cnt + ' marker' + (cnt === 1 ? '' : 's') + ' shown';

                // If the payload contains a 'recordsFiltered' or 'recordsTotal' hint, show it so users
                // can see if the embedded JSON was truncated or filtered by the server.
                var expectedHint = null;
                try {
                    // try to derive hints from the items array's parent payload (we may receive items directly)
                    // If caller passed the full payload object rather than the inner array, it would have been handled
                    // by addCameraMarkersFromArray only. Here we read attributes on the original containing element if present.
                    var camJsonEl = document.getElementById('camera-json');
                    if (camJsonEl) {
                        try {
                            var raw = camJsonEl.textContent || camJsonEl.innerText || '';
                            var parsed = raw ? JSON.parse(raw) : null;
                            if (parsed && typeof parsed === 'object') {
                                if (Number.isInteger(parsed.recordsFiltered)) expectedHint = parsed.recordsFiltered;
                                else if (Number.isInteger(parsed.recordsTotal)) expectedHint = parsed.recordsTotal;
                            }
                        } catch (e) {
                            // ignore JSON parse errors here
                        }
                    }
                } catch (e) { }

                if (expectedHint && expectedHint !== total) {
                    if (cntEl) cntEl.textContent += ' (showing ' + total + ' of ' + expectedHint + ' returned)';
                    console.warn('Camera data length mismatch: array length=' + total + ', expected/hint=' + expectedHint + ', markers shown=' + cnt);

                    // If the embedded payload appears truncated, offer a small runtime helper so
                    // users can paste extra camera JSON (the missing 7 items you mentioned) and
                    // merge them into the map without modifying index.html on disk.
                    try {
                        var legendEl = document.getElementById('map-legend');
                        if (legendEl && !document.getElementById('paste-extra-btn')) {
                            var pasteBtn = document.createElement('button');
                            pasteBtn.id = 'paste-extra-btn';
                            pasteBtn.type = 'button';
                            pasteBtn.textContent = 'Paste extra cameras';
                            pasteBtn.style.display = 'block';
                            pasteBtn.style.marginTop = '6px';
                            pasteBtn.style.fontSize = '12px';
                            pasteBtn.onclick = function () {
                                // Create a lightweight modal overlay with a textarea for pasting JSON
                                var overlay = document.createElement('div');
                                overlay.id = 'paste-extra-overlay';
                                overlay.style.position = 'fixed';
                                overlay.style.left = '0';
                                overlay.style.top = '0';
                                overlay.style.right = '0';
                                overlay.style.bottom = '0';
                                overlay.style.background = 'rgba(0,0,0,0.35)';
                                overlay.style.zIndex = 9999;

                                var box = document.createElement('div');
                                box.style.background = '#fff';
                                box.style.padding = '10px';
                                box.style.margin = '40px auto';
                                box.style.width = 'min(900px,95%)';
                                box.style.borderRadius = '6px';
                                box.style.maxHeight = '80vh';
                                box.style.overflow = 'auto';

                                var title = document.createElement('div');
                                title.textContent = 'Paste camera JSON payload or data array below and click "Merge cameras"';
                                title.style.marginBottom = '6px';
                                box.appendChild(title);

                                var ta = document.createElement('textarea');
                                ta.style.width = '100%';
                                ta.style.height = '260px';
                                ta.placeholder = 'Paste a JSON array (data[]) or the whole payload here...';
                                box.appendChild(ta);

                                var bwrap = document.createElement('div');
                                bwrap.style.marginTop = '8px';

                                var submit = document.createElement('button');
                                submit.textContent = 'Merge cameras';
                                submit.type = 'button';
                                submit.style.fontSize = '13px';
                                bwrap.appendChild(submit);

                                var cancel = document.createElement('button');
                                cancel.textContent = 'Cancel';
                                cancel.type = 'button';
                                cancel.style.marginLeft = '8px';
                                cancel.onclick = function () { try { document.body.removeChild(overlay); } catch (e) { } };
                                bwrap.appendChild(cancel);

                                box.appendChild(bwrap);
                                overlay.appendChild(box);
                                document.body.appendChild(overlay);

                                submit.onclick = function () {
                                    var txt = ta.value;
                                    if (!txt || !txt.trim()) { showToast('Please paste JSON containing the missing camera objects.', 5000); return; }
                                    try {
                                        var parsed = JSON.parse(txt);
                                        var newArr = null;
                                        if (Array.isArray(parsed)) newArr = parsed;
                                        else if (parsed && Array.isArray(parsed.data)) newArr = parsed.data;
                                        if (!newArr) { showToast('Could not find an array in the pasted JSON. Paste the inner data array or the full payload.', 6000); return; }

                                        // Read existing embedded payload if available so we can merge uniquely by id
                                        var camJsonEl = document.getElementById('camera-json');
                                        var existing = [];
                                        try {
                                            if (camJsonEl) {
                                                var raw = camJsonEl.textContent || camJsonEl.innerText || '';
                                                var parsedExisting = raw ? JSON.parse(raw) : null;
                                                if (parsedExisting && Array.isArray(parsedExisting.data)) existing = parsedExisting.data;
                                                else if (Array.isArray(parsedExisting)) existing = parsedExisting;
                                            }
                                        } catch (e) { /* ignore parse errors */ }

                                        // Merge by id (new items override existing ones with same id)
                                        var byId = {};
                                        existing.concat(newArr).forEach(function (it) { if (it && it.id != null) byId[it.id] = it; });
                                        // if items have no id, just append them
                                        var appendNoId = [];
                                        existing.concat(newArr).forEach(function (it) { if (it && it.id == null) appendNoId.push(it); });
                                        var merged = Object.keys(byId).map(function (k) { return byId[k]; }).concat(appendNoId);

                                        // Optionally update the in-page script so future reloads in this tab keep the merged payload
                                        try {
                                            if (camJsonEl) {
                                                var payload = { draw: 0, recordsTotal: merged.length, recordsFiltered: merged.length, data: merged };
                                                camJsonEl.textContent = JSON.stringify(payload, null, 2);
                                            }
                                        } catch (e) { }

                                        // Re-render markers using merged array
                                        addCameraMarkersFromArray(merged);

                                        // Close overlay
                                        try { document.body.removeChild(overlay); } catch (e) { }
                                    } catch (e) {
                                        showToast('Failed to parse JSON: ' + (e && e.message ? e.message : String(e)), 7000);
                                    }
                                };
                            };
                            legendEl.appendChild(pasteBtn);
                        }
                    } catch (e) { /* ignore UI errors */ }
                } else {
                    console.info('Camera markers processed: total=' + total + ', created=' + created.length + ', skipped=' + skipped.length);
                }

                if (skipped.length) console.warn('Skipped camera items:', skipped.slice(0, 50));
                if (created.length) console.info('Created camera items (ids):', created.map(function (c) { return c.id; }));
                // Kick off persistent prewarm for the ordered camera list so switches are near-instant.
                try { if (!persistentPrewarmRunning && typeof startPersistentPrewarm === 'function') startPersistentPrewarm(orderedCameraIds); } catch (e) {}
            } catch (e) { }
        }

        // Expose a global helper so you can paste the JSON and call it from the console
        window.addCameraMarkersFromJson = function (json) {
            try {
                var obj = (typeof json === 'string') ? JSON.parse(json) : json;
                if (!obj) return console.warn('No camera data provided');
                if (Array.isArray(obj)) return addCameraMarkersFromArray(obj);
                if (obj.data && Array.isArray(obj.data)) {
                    addCameraMarkersFromArray(obj.data);
                    try { map.addLayer(cameraLayer); } catch (e) {}
                    return;
                }
                console.warn('Unrecognized camera JSON shape. Pass the whole payload or the inner data array.');
            } catch (e) {
                console.error('Failed to parse camera JSON', e);
            }
        };

        // Add a toggle to the legend to show/hide camera markers
        (function addCameraToggleToLegend() {
            try {
                var legend = document.getElementById('map-legend');
                if (!legend) return;
                var wrap = document.createElement('div');
                wrap.style.marginTop = '8px';
                var chk = document.createElement('input'); chk.type = 'checkbox'; chk.id = 'show-cameras';
                var lbl = document.createElement('label'); lbl.htmlFor = 'show-cameras'; lbl.style.fontSize = '13px'; lbl.style.marginLeft = '6px'; lbl.textContent = 'Show cameras';
                wrap.appendChild(chk); wrap.appendChild(lbl);
                legend.appendChild(wrap);
                // Default: show cameras immediately
                try { chk.checked = true; map.addLayer(cameraLayer); } catch (e) { }
                chk.addEventListener('change', function () {
                    if (chk.checked) map.addLayer(cameraLayer); else map.removeLayer(cameraLayer);
                });
            } catch (e) { console.warn('Could not add camera toggle', e); }
        })();

        // Load camera data: try NV Roads endpoint first, fall back to embedded <script id="camera-json"> payload.
        (function () {
            var camJsonEl = document.getElementById('camera-json');
            // Camera endpoint: prefer data-camera-endpoint on the #map element so developers
            // can put the full NV Roads query there. Otherwise fall back to a default NV Roads URL.
            var nvDefault = 'https://www.nvroads.com/List/GetData/Cameras?query=%7B%22columns%22%3A%5B%7B%22data%22%3Anull%2C%22name%22%3A%22%22%7D%2C%7B%22name%22%3A%22sortOrder%22%2C%22s%22%3Atrue%7D%2C%7B%22name%22%3A%22region%22%2C%22s%22%3Atrue%7D%2C%7B%22name%22%3A%22roadway%22%2C%22s%22%3Atrue%7D%2C%7B%22data%22%3A4%2C%22name%22%3A%22%22%7D%5D%2C%22order%22%3A%5B%7B%22column%22%3A1%2C%22dir%22%3A%22asc%22%7D%2C%7B%22column%22%3A2%2C%22dir%22%3A%22asc%22%7D%2C%7B%22column%22%3A3%2C%22dir%22%3A%22asc%22%7D%5D%2C%22start%22%3A0%2C%22length%22%3A17%2C%22search%22%3A%7B%22value%22%3A%22f1%22%7D%7D&lang=en-US';
            var nvUrl = (ds && ds.cameraEndpoint) ? ds.cameraEndpoint : nvDefault;

            async function tryLoadFromNv() {
                try {
                    var r = await fetch(nvUrl, { cache: 'no-store', mode: 'cors' });
                    if (!r.ok) throw new Error('NV Roads response not ok: ' + r.status);
                    var payload = await r.json();
                    // payload may be the full DataTables-like object or already the inner array
                    var arr = null;
                    if (Array.isArray(payload)) arr = payload;
                    else if (payload && Array.isArray(payload.data)) arr = payload.data;
                    else if (payload && Array.isArray(payload.rows)) arr = payload.rows;

                    if (Array.isArray(arr) && arr.length) {
                        console.info('Loaded ' + arr.length + ' cameras from NV Roads endpoint');
                        addCameraMarkersFromArray(arr);
                        try { map.addLayer(cameraLayer); } catch (e) { }
                        return true;
                    }
                    // If no usable array, return false so we fall back
                    console.warn('NV Roads endpoint returned no usable camera array');
                    return false;
                } catch (err) {
                    console.warn('Failed to fetch cameras from NV Roads endpoint, will try embedded JSON fallback', err);
                    return false;
                }
            }

            // Run the NV fetch, then fallback to embedded JSON if needed
            (async function () {
                var usedNv = await tryLoadFromNv();
                if (usedNv) return;

                // Fallback: try to read embedded <script id="camera-json"> element (may be present for offline/local testing)
                try {
                    if (camJsonEl) {
                        var txt = camJsonEl.textContent || camJsonEl.innerText || '';
                        if (txt) {
                            try {
                                var parsed = JSON.parse(txt);
                                if (Array.isArray(parsed)) {
                                    addCameraMarkersFromArray(parsed);
                                    try { map.addLayer(cameraLayer); } catch (e) { }
                                } else if (parsed && Array.isArray(parsed.data)) {
                                    addCameraMarkersFromArray(parsed.data);
                                    try { map.addLayer(cameraLayer); } catch (e) { }
                                } else {
                                    console.warn('Embedded camera-json found but has unexpected shape');
                                }
                            } catch (e) {
                                console.warn('Failed to parse embedded camera-json, skipping', e);
                            }
                        }
                    }
                } catch (e) { /* ignore */ }
            })();
        })();

        // Fullscreen overlay: create once
    var fsOverlay = null;
        var fsVideoContainer = null;
        var fsMapContainer = null;
        var fsCloseBtn = null;
        var fsPrevBtn = null;
        var fsNextBtn = null;
        var currentFsCameraId = null;
    var mapOriginalStyles = null;
    var mapOriginalParent = null;
    var mapOriginalNextSibling = null;
    var fsHlsInstance = null;
    var fsVideoEl = null;
    // mini map instance shown in the fullscreen overlay (we'll create/destroy it to avoid moving the main map DOM)
    var miniMap = null;
    var miniTileLayer = null;
    var miniMarkersById = {};
    var miniRootEl = null;
    // simple playlist prefetch cache to warm m3u8 manifests and reduce switch latency
    var prefetchPromises = {};
    var PREFETCH_LIMIT = 8; // avoid prefetching too many at once

    function prefetchPlaylist(url, id) {
        try {
            if (!url || !id) return;
            if (prefetchPromises[id]) return;
            // only attempt to fetch m3u8 playlists (simple heuristic)
            if (String(url).indexOf('.m3u8') === -1) return;
            prefetchPromises[id] = fetch(url, { method: 'GET', mode: 'cors', cache: 'no-store' })
                .then(function (r) { if (r && r.ok) return r.text(); })
                .catch(function () { /* ignore */ });
        } catch (e) { }
    }

    // Prewarm Hls instances using hidden video elements for nearby cameras while fullscreen is open
    var prewarmPool = {};
    function prewarmNearby(centerId) {
        try {
            if (!centerId) return;
            // build list: center, next, prev in orderedCameraIds; limit to 4
            var list = [centerId];
            try {
                var idx = orderedCameraIds.indexOf(Number(centerId));
                if (idx !== -1) {
                    var next = orderedCameraIds[(idx + 1) % orderedCameraIds.length];
                    var prev = orderedCameraIds[(idx - 1 + orderedCameraIds.length) % orderedCameraIds.length];
                    list.push(next); list.push(prev);
                    // add two more neighbors if available
                    var n2 = orderedCameraIds[(idx + 2) % orderedCameraIds.length];
                    var p2 = orderedCameraIds[(idx - 2 + orderedCameraIds.length) % orderedCameraIds.length];
                    list.push(n2); list.push(p2);
                }
            } catch (e) {}
            // limit and unique
            var uniq = [];
            list.forEach(function (i) { if (i != null && uniq.indexOf(i) === -1) uniq.push(i); });
            uniq = uniq.slice(0, Math.min(PREFETCH_LIMIT, uniq.length));

            uniq.forEach(function (id) {
                try {
                    if (prewarmPool[id]) return;
                    var cam = cameraById[id];
                    if (!cam || !cam.videoUrl) return;
                    var url = cam.videoUrl;
                    if (String(url).indexOf('.m3u8') === -1) return;
                    // create hidden video
                    var hv = document.createElement('video'); hv.style.position = 'absolute'; hv.style.left = '-9999px'; hv.style.width = '1px'; hv.style.height = '1px'; hv.muted = true; hv.playsInline = true; hv.autoplay = true;
                    document.body.appendChild(hv);
                    var pool = { video: hv, hls: null };
                    ensureHls().then(function (Hls) {
                        try {
                            if (Hls && Hls.isSupported()) {
                                var h = new Hls({ enableWorker: true, lowLatencyMode: true, liveSyncDurationCount: 3, maxBufferLength: 30 });
                                h.loadSource(url);
                                h.attachMedia(hv);
                                // start playback to prompt buffering
                                hv.play().catch(function () {});
                                pool.hls = h;
                            } else {
                                hv.src = url; hv.play().catch(function () {});
                            }
                        } catch (e) { }
                    }).catch(function () { try { hv.src = url; hv.play().catch(function () {}); } catch (e) {} });
                    prewarmPool[id] = pool;
                } catch (e) {}
            });
        } catch (e) {}
    }

    function usePrewarm(id) {
        try {
            var p = prewarmPool[id];
            if (!p) return null;
            // if Hls instance available, detach from hidden video and return it
            try {
                if (p.hls) {
                    try { p.hls.detachMedia(); } catch (e) {}
                    return p.hls;
                }
            } catch (e) {}
            return null;
        } catch (e) { return null; }
    }

    function cleanupPrewarm() {
        try {
            for (var k in prewarmPool) {
                try {
                    var p = prewarmPool[k];
                    if (!p) continue;
                    try { if (p.hls) { try { p.hls.destroy(); } catch (e) {} } } catch (e) {}
                    try { if (p.video && p.video.parentNode) p.video.parentNode.removeChild(p.video); } catch (e) {}
                } catch (e) {}
            }
        } catch (e) {}
        prewarmPool = {};
    }

    // Start persistent prewarm players for a list of camera ids.
    // This will create hidden video elements that keep playing the stream in the background
    // so we can instantly show the most recent frames via captureStream when switching.
    var persistentPrewarmRunning = false;
    function startPersistentPrewarm(idList) {
        try {
            if (!Array.isArray(idList) || idList.length === 0) return;
            idList.forEach(function (id) {
                try {
                    if (!cameraById[id] || !cameraById[id].videoUrl) return;
                    if (prewarmPool[id]) return; // already prewarmed
                    var url = cameraById[id].videoUrl;
                    if (!url || String(url).indexOf('.m3u8') === -1) return;
                    var hv = document.createElement('video');
                    hv.style.position = 'absolute'; hv.style.left = '-9999px'; hv.style.width = '1px'; hv.style.height = '1px';
                    hv.muted = true; hv.playsInline = true; hv.autoplay = true; hv.preload = 'auto';
                    document.body.appendChild(hv);
                    var pool = { video: hv, hls: null, persistent: true };
                    // try to attach Hls and start playback
                    ensureHls().then(function (Hls) {
                        try {
                            if (Hls && Hls.isSupported()) {
                                var h = new Hls({enableWorker: true});
                                h.loadSource(url);
                                h.attachMedia(hv);
                                // attempt to autoplay silently
                                hv.play().catch(function () { /* ignore */ });
                                pool.hls = h;
                            } else {
                                hv.src = url;
                                hv.play().catch(function () {});
                            }
                        } catch (e) { try { hv.src = url; hv.play().catch(function () {}); } catch (er) {} }
                    }).catch(function () { try { hv.src = url; hv.play().catch(function () {}); } catch (e) {} });
                    prewarmPool[id] = pool;
                } catch (e) { }
            });
            persistentPrewarmRunning = true;
        } catch (e) {}
    }

    function stopPersistentPrewarm() {
        try {
            for (var k in prewarmPool) {
                try {
                    var p = prewarmPool[k];
                    if (!p) continue;
                    try { if (p.hls) { try { p.hls.destroy(); } catch (e) {} } } catch (e) {}
                    try { if (p.video && p.video.parentNode) p.video.parentNode.removeChild(p.video); } catch (e) {}
                } catch (e) {}
            }
        } catch (e) {}
        prewarmPool = {};
        persistentPrewarmRunning = false;
    }

        // The ordered camera list the user requested
        var orderedCameraIds = [3429,3498,3416,3415,3414,3413,3882,3909,3410,3412,3411,4036];

        function ensureFsOverlay() {
            if (fsOverlay) return;
            fsOverlay = document.createElement('div');
            fsOverlay.id = 'camera-fullscreen-overlay';
            fsOverlay.style.position = 'fixed';
            fsOverlay.style.left = '0'; fsOverlay.style.top = '0'; fsOverlay.style.right = '0'; fsOverlay.style.bottom = '0';
            fsOverlay.style.zIndex = 100000; fsOverlay.style.background = 'rgba(0,0,0,0.95)';
            fsOverlay.style.display = 'flex'; fsOverlay.style.alignItems = 'stretch'; fsOverlay.style.justifyContent = 'stretch';

            // Container to hold video (fills overlay)
            var container = document.createElement('div');
            container.style.position = 'relative';
            container.style.width = '100%'; container.style.height = '100%';
            container.style.display = 'flex'; container.style.alignItems = 'stretch'; container.style.justifyContent = 'stretch';

            // Video area fills the overlay
            fsVideoContainer = document.createElement('div');
            fsVideoContainer.style.flex = '1 1 auto'; fsVideoContainer.style.background = '#000'; fsVideoContainer.style.borderRadius = '0'; fsVideoContainer.style.overflow = 'hidden'; fsVideoContainer.style.display = 'flex'; fsVideoContainer.style.alignItems = 'center'; fsVideoContainer.style.justifyContent = 'center';

            // Map area will be a small draggable box in bottom-right (absolute)
            fsMapContainer = document.createElement('div');
            fsMapContainer.style.position = 'absolute';
            fsMapContainer.style.width = '320px'; fsMapContainer.style.height = '240px';
            fsMapContainer.style.right = '24px'; fsMapContainer.style.bottom = '24px';
            fsMapContainer.style.borderRadius = '8px'; fsMapContainer.style.overflow = 'hidden'; fsMapContainer.style.background = '#222'; fsMapContainer.style.cursor = 'grab'; fsMapContainer.style.zIndex = 100002; fsMapContainer.style.boxShadow = '0 8px 30px rgba(0,0,0,0.6)';

            // Drag handle so dragging the map doesn't pan the map itself
            var dragHandle = document.createElement('div');
            dragHandle.style.height = '26px'; dragHandle.style.background = 'rgba(0,0,0,0.4)'; dragHandle.style.color = '#fff'; dragHandle.style.display = 'flex'; dragHandle.style.alignItems = 'center'; dragHandle.style.padding = '0 8px'; dragHandle.style.cursor = 'grab'; dragHandle.textContent = 'Drag map'; dragHandle.style.fontSize = '12px';
            fsMapContainer.appendChild(dragHandle);


            container.appendChild(fsVideoContainer);
            fsOverlay.appendChild(container);
            fsOverlay.appendChild(fsMapContainer);

            // Close button
            fsCloseBtn = document.createElement('button'); fsCloseBtn.textContent = '✕';
            fsCloseBtn.style.position = 'absolute'; fsCloseBtn.style.right = '12px'; fsCloseBtn.style.top = '12px'; fsCloseBtn.style.zIndex = 100003; fsCloseBtn.style.padding = '8px'; fsCloseBtn.style.borderRadius = '6px';

            // Prev / Next buttons (overlay edges)
            fsPrevBtn = document.createElement('button'); fsPrevBtn.textContent = '◀'; fsPrevBtn.title = 'Previous camera'; fsPrevBtn.style.position = 'absolute'; fsPrevBtn.style.left = '12px'; fsPrevBtn.style.top = '50%'; fsPrevBtn.style.transform = 'translateY(-50%)'; fsPrevBtn.style.zIndex = 100003; fsPrevBtn.style.padding = '8px';
            fsNextBtn = document.createElement('button'); fsNextBtn.textContent = '▶'; fsNextBtn.title = 'Next camera'; fsNextBtn.style.position = 'absolute'; fsNextBtn.style.right = '12px'; fsNextBtn.style.top = '50%'; fsNextBtn.style.transform = 'translateY(-50%)'; fsNextBtn.style.zIndex = 100003; fsNextBtn.style.padding = '8px';

            fsOverlay.appendChild(fsCloseBtn);
            fsOverlay.appendChild(fsPrevBtn);
            fsOverlay.appendChild(fsNextBtn);
            document.body.appendChild(fsOverlay);

            fsCloseBtn.addEventListener('click', function () { try { location.reload(); } catch (e) { closeCameraFullscreen(); } });
            fsPrevBtn.addEventListener('click', function () { navigateFullscreen(-1); });
            fsNextBtn.addEventListener('click', function () { navigateFullscreen(1); });

            // make map container draggable via the handle
            makeDraggable(fsMapContainer, dragHandle);
        }

        function openCameraFullscreen(camId, videoEl, url, markerRef) {
            ensureFsOverlay();
            currentFsCameraId = camId;

            // Move the provided video element into the fsVideoContainer
            // If the video element is not initialized, create a clone video and init media
            fsVideoContainer.innerHTML = ''; // clear
            try {
                // Don't remove the popup's original video element — create a separate fullscreen video
                // This preserves the popup preview when we close fullscreen.
                // Create the fs video element and initialize media for it using the camera's URL.
                try {
                    // clean up any previous fs video/hls
                    if (fsHlsInstance) { try { fsHlsInstance.destroy(); } catch (e) {} fsHlsInstance = null; }
                    if (fsVideoEl) {
                        try { fsVideoEl.pause(); fsVideoEl.removeAttribute('src'); fsVideoEl.src = ''; fsVideoEl.load(); } catch (e) {}
                        try { fsVideoEl.parentNode && fsVideoEl.parentNode.removeChild(fsVideoEl); } catch (e) {}
                        fsVideoEl = null;
                    }
                } catch (e) {}

                var v = document.createElement('video');
                v.style.width = '100%'; v.style.height = '100%'; v.controls = false; v.muted = true; v.playsInline = true; v.autoplay = false;
                try { v.style.objectFit = 'contain'; v.style.maxHeight = '100%'; v.style.maxWidth = '100%'; } catch (e) {}
                fsVideoContainer.appendChild(v);
                fsVideoEl = v;

                // fullscreen time overlay removed per user preference

                // initialize playback for fullscreen video using cameraById[camId].videoUrl if available
                var playUrl = url || (cameraById[camId] && cameraById[camId].videoUrl) || null;
                if (playUrl) {
                    ensureHls().then(function (Hls) {
                        try {
                            if (Hls && Hls.isSupported()) {
                                fsHlsInstance = new Hls({ enableWorker: true, lowLatencyMode: true, liveSyncDurationCount: 3, maxBufferLength: 30 });
                                fsHlsInstance.loadSource(playUrl);
                                fsHlsInstance.attachMedia(fsVideoEl);
                                fsVideoEl.play().catch(function () {});
                            } else {
                                fsVideoEl.src = playUrl;
                                fsVideoEl.play().catch(function () {});
                            }
                        } catch (e) { console.warn('Failed to init fullscreen HLS', e); }
                    }).catch(function () {
                        try { fsVideoEl.src = playUrl; fsVideoEl.play().catch(function () {}); } catch (e) {}
                    });
                }
            } catch (e) { console.warn('Error preparing fullscreen video', e); }

            // Close any open popup (so popup contents don't remain visible)
            try { if (markerRef && markerRef.closePopup) markerRef.closePopup(); } catch (e) { }

            // hide popup controls for the active camera while fullscreen is shown
            try {
                var camObj = cameraById[camId];
                if (camObj && camObj.ctrlWrap && camObj.ctrlWrap.style) {
                    // save previous display so we can restore it later
                    try { camObj._savedCtrlDisplay = camObj.ctrlWrap.style.display; } catch (e) {}
                    camObj.ctrlWrap.style.display = 'none';
                }
            } catch (e) {}

            // Instead of moving the main map DOM into the overlay (which caused reparenting bugs),
            // create a separate mini Leaflet map inside fsMapContainer. This keeps the main map
            // intact and avoids layout thrash on repeated open/close cycles.
            try {
                // create or update miniMap
                createOrUpdateMiniMap(camId);
            } catch (e) { console.warn('Could not create mini map for fullscreen overlay', e); }

            // highlight current camera marker
            highlightCameraMarker(camId);

            // Show or hide prev/next buttons depending on whether this camera exists in the ordered list
            try {
                var inList = orderedCameraIds.indexOf(Number(camId)) !== -1;
                if (fsPrevBtn) fsPrevBtn.style.display = inList ? '' : 'none';
                if (fsNextBtn) fsNextBtn.style.display = inList ? '' : 'none';
            } catch (e) {}

            fsOverlay.style.display = 'flex';
            // force tile redraw on main layer to reduce grey tiles
            try { if (tileLayerRef && typeof tileLayerRef.redraw === 'function') tileLayerRef.redraw(); } catch (e) {}
            // ensure media initialization for the camera
            try { if (cameraById[camId]) {
                var c = cameraById[camId];
                // ensure media init similar to popup open
                if (c && c.marker) {
                    c.marker.fire('popupopen');
                }
            } } catch (e) {}
            // prewarm nearby HLS for faster switching
            try { prewarmNearby(camId); } catch (e) {}
        }

        function closeCameraFullscreen() {
            if (!fsOverlay) return;
            // restore popup controls for the last fullscreen camera (if present)
            try {
                var lastId = currentFsCameraId;
                if (lastId && cameraById[lastId] && cameraById[lastId].ctrlWrap && cameraById[lastId].ctrlWrap.style) {
                    try { cameraById[lastId].ctrlWrap.style.display = cameraById[lastId]._savedCtrlDisplay || ''; } catch (e) {}
                    try { delete cameraById[lastId]._savedCtrlDisplay; } catch (e) {}
                }
            } catch (e) {}
            // Do not destroy miniMap here; persist it to avoid re-creating tiles/DOM on every open.
            try { /* keep miniMap for reuse */ } catch (e) {}

            // stop any media playing in fsVideoContainer
            try {
                if (fsVideoEl) { try { fsVideoEl.pause(); fsVideoEl.removeAttribute('src'); fsVideoEl.src = ''; fsVideoEl.load(); fsVideoEl.parentNode && fsVideoEl.parentNode.removeChild(fsVideoEl); } catch (e) {} fsVideoEl = null; }
                if (fsHlsInstance) { try { fsHlsInstance.destroy(); } catch (e) {} fsHlsInstance = null; }
                try { /* fs time interval/element removed per user preference */ } catch (e) {}
            } catch (e) { }

            // hide overlay immediately
            fsOverlay.style.display = 'none';

            // Strong reflow sequence: redraw tiles, remove/re-add camera layer to rebuild marker DOM,
            // invalidate size multiple times, then open popup after tiles have time to load.
            try { if (tileLayerRef && typeof tileLayerRef.redraw === 'function') tileLayerRef.redraw(); } catch (e) {}

            try { if (map.hasLayer(cameraLayer)) map.removeLayer(cameraLayer); } catch (e) {}
            setTimeout(function () {
                try { if (!map.hasLayer(cameraLayer)) map.addLayer(cameraLayer); } catch (e) {}
                try { map.invalidateSize(); } catch (e) {}
                setTimeout(function () { try { map.invalidateSize(); } catch (e) {} }, 140);
                try { cameraLayer.eachLayer(function (lay) { try { if (lay && typeof lay.getLatLng === 'function') lay.setLatLng(lay.getLatLng()); } catch (e) {} }); } catch (e) {}
            }, 120);

            unhighlightAllMarkers();
            // reopen the popup for the last fullscreen camera after a short delay so tiles/pins are ready
            try {
                var reopenId = currentFsCameraId;
                currentFsCameraId = null;
                if (reopenId && cameraById[reopenId] && cameraById[reopenId].marker) {
                    setTimeout(function () { try { cameraById[reopenId].marker.openPopup(); } catch (e) {} }, 520);
                }
            } catch (e) { currentFsCameraId = null; }
            // clear any saved original parent/nextSibling (no longer used when using miniMap)
            try { mapOriginalParent = null; mapOriginalNextSibling = null; } catch (e) {}
        }

        function highlightCameraMarker(camId) {
            try {
                for (var k in cameraById) {
                    var o = cameraById[k];
                    if (!o || !o.marker) continue;
                    var el = o.marker.getElement && o.marker.getElement();
                    if (el) {
                        if (Number(k) === Number(camId)) el.style.transform = 'scale(1.4)'; else el.style.transform = '';
                    }
                }
            } catch (e) { }
        }

        function unhighlightAllMarkers() { try { for (var k in cameraById) { var o = cameraById[k]; if (o && o.marker && o.marker.getElement) { var el = o.marker.getElement(); if (el) el.style.transform = ''; } } } catch (e) {} }

        function navigateFullscreen(dir) {
            if (!currentFsCameraId) return;
            var idx = orderedCameraIds.indexOf(Number(currentFsCameraId));
            if (idx === -1) {
                // if current not in list, try to find closest by id
                idx = 0;
            }
            idx = (idx + dir + orderedCameraIds.length) % orderedCameraIds.length;
            var nextId = orderedCameraIds[idx];
            if (!cameraById[nextId]) return;
            // If the fullscreen overlay is currently visible, switch cameras in-place
            try {
                if (fsOverlay && fsOverlay.style.display && fsOverlay.style.display !== 'none') {
                    switchFullscreenCamera(nextId);
                    return;
                }
            } catch (e) {}

            // otherwise close and reopen for the next camera (keeps previous behavior)
            try {
                closeCameraFullscreen();
            } catch (e) {}
            setTimeout(function () { var o = cameraById[nextId]; openCameraFullscreen(nextId, o.videoEl, o.videoUrl, o.marker); }, 120);
        }

        // Update the fullscreen overlay to show a different camera without moving the map DOM
        function switchFullscreenCamera(camId) {
            try {
                if (!fsOverlay || fsOverlay.style.display === 'none') return;
                currentFsCameraId = camId;
                // update highlight
                highlightCameraMarker(camId);

                // toggle prev/next visibility for cameras not in the ordered list
                try {
                    var inList2 = orderedCameraIds.indexOf(Number(camId)) !== -1;
                    if (fsPrevBtn) fsPrevBtn.style.display = inList2 ? '' : 'none';
                    if (fsNextBtn) fsNextBtn.style.display = inList2 ? '' : 'none';
                } catch (e) {}

                // center the small map on the new camera
                try {
                    var coords = cameraById[camId] && cameraById[camId].coords;
                    if (coords) {
                        // ensure maps have correct size first, then center miniMap and open its popup to avoid jump-to-top-left
                        try { map.invalidateSize(); } catch (e) {}
                        try { map.setView(coords, Math.max(map.getZoom(), 16)); } catch (e) {}
                        try {
                            if (miniMap) {
                                try { if (miniTileLayer && typeof miniTileLayer.redraw === 'function') miniTileLayer.redraw(); } catch (e) {}
                                try { miniMap.invalidateSize(); } catch (e) {}
                                try { miniMap.setView(coords, Math.max(map.getZoom(), 16)); } catch (e) {}
                                try {
                                    var mm = miniMarkersById && miniMarkersById[Number(camId)];
                                    if (mm && typeof mm.openPopup === 'function') mm.openPopup();
                                } catch (e) {}
                            }
                        } catch (e) {}
                        // nudge main map markers to ensure DOM elements are positioned
                        try { cameraLayer.eachLayer(function (lay) { if (lay && typeof lay.getLatLng === 'function' && typeof lay.setLatLng === 'function') { lay.setLatLng(lay.getLatLng()); } }); } catch (e) {}
                    }
                } catch (e) {}

                // swap fullscreen video source to the selected camera's URL
                try {
                    var cam = cameraById[camId];
                    var newUrl = (cam && cam.videoUrl) || null;
                    if (!newUrl) return;
                    // Double-buffered swap: create a new video element and only remove the old one
                    // after the new stream has started playing. This reduces the visible black/white gap.
                    try {
                        var oldFsVideo = fsVideoEl;
                        var oldFsHls = fsHlsInstance;

                        // lightweight loading spinner while we switch
                        var spinner = document.createElement('div');
                        spinner.className = 'fs-loading-spinner';
                        spinner.style.position = 'absolute';
                        spinner.style.left = '50%';
                        spinner.style.top = '50%';
                        spinner.style.transform = 'translate(-50%, -50%)';
                        spinner.style.padding = '10px 14px';
                        spinner.style.background = 'rgba(0,0,0,0.6)';
                        spinner.style.color = '#fff';
                        spinner.style.borderRadius = '6px';
                        spinner.style.zIndex = 100010;
                        spinner.textContent = 'Loading…';
                        try { if (fsVideoContainer) fsVideoContainer.appendChild(spinner); } catch (e) {}

                        // create the new fullscreen video element (kept hidden until playing)
                        var newV = document.createElement('video');
                        newV.style.width = '100%'; newV.style.height = '100%'; newV.controls = false; newV.muted = true; newV.playsInline = true; newV.autoplay = true; newV.preload = 'auto';
                        try { newV.style.objectFit = 'contain'; newV.style.maxHeight = '100%'; newV.style.maxWidth = '100%'; } catch (e) {}
                        // position above the old video so we can see when frames arrive
                        newV.style.position = 'absolute'; newV.style.left = '0'; newV.style.top = '0'; newV.style.zIndex = 100005; newV.style.background = '#000';
                        try { if (fsVideoContainer) fsVideoContainer.appendChild(newV); } catch (e) {}

                        // helper to finalize swap
                        var swapDone = false;
                        function finalizeSwap(success) {
                            if (swapDone) return; swapDone = true;
                            try { if (spinner && spinner.parentNode) spinner.parentNode.removeChild(spinner); } catch (e) {}
                            try {
                                // remove old video element
                                if (oldFsVideo && oldFsVideo.parentNode) { try { oldFsVideo.pause(); oldFsVideo.removeAttribute('src'); oldFsVideo.src = ''; oldFsVideo.load(); oldFsVideo.parentNode.removeChild(oldFsVideo); } catch (e) {} }
                            } catch (e) {}
                            try {
                                // destroy old Hls instance if it was not reused
                                if (oldFsHls && oldFsHls !== fsHlsInstance) { try { oldFsHls.destroy(); } catch (e) {} }
                            } catch (e) {}
                            try {
                                // If the new video has a srcObject (from previous strategies), clear it when Hls is active
                                try { if (newV && newV.srcObject && fsHlsInstance) { try { newV.srcObject = null; } catch (e) {} } } catch (e) {}
                            } catch (e) {}
                            // set the global fsVideoEl to the new one
                            fsVideoEl = newV;
                            // ensure the new video element is not absolutely positioned anymore
                            try { fsVideoEl.style.position = ''; fsVideoEl.style.left = ''; fsVideoEl.style.top = ''; fsVideoEl.style.zIndex = ''; } catch (e) {}
                        }

                        // attempt to reuse an Hls instance attached to the marker first
                        var reused = null;
                        try { if (cameraById[camId] && cameraById[camId].raw && cameraById[camId].raw._hlsInstance) reused = cameraById[camId].raw._hlsInstance; } catch (e) {}
                        // fall back to marker._hlsInstance as some code stored it directly on marker
                        try { if (!reused && cameraById[camId] && cameraById[camId].marker && cameraById[camId].marker._hlsInstance) reused = cameraById[camId].marker._hlsInstance; } catch (e) {}
                        // also try the prewarm pool
                        try { if (!reused) reused = usePrewarm(camId); } catch (e) {}

                        if (reused) {
                            try {
                                // detach from any previous media and attach to the new video
                                try { if (typeof reused.detachMedia === 'function') reused.detachMedia(); } catch (e) {}
                                fsHlsInstance = reused;
                                fsHlsInstance.attachMedia(newV);
                                // play and wait for playing event
                                newV.play().catch(function () {});
                            } catch (e) { fsHlsInstance = null; }
                        }
                        // Simpler/reliable reuse: if a prewarmed Hls instance exists, detach it from its hidden
                        // video and attach it directly to the new fullscreen video element. This avoids captureStream
                        // and snapshot complexities which can fail under autoplay/cross-origin constraints.
                        try {
                            var prewarmed = usePrewarm(camId);
                            if (prewarmed) {
                                try {
                                    // detach from any previous media and attach to our new video element
                                    if (typeof prewarmed.detachMedia === 'function') {
                                        try { prewarmed.detachMedia(); } catch (e) {}
                                    }
                                    fsHlsInstance = prewarmed;
                                    fsHlsInstance.attachMedia(newV);
                                    newV.play().catch(function () {});
                                } catch (e) { fsHlsInstance = null; }
                            }
                        } catch (e) {}

                        if (!fsHlsInstance) {
                            // init new Hls or native src on the new video element
                            ensureHls().then(function (Hls) {
                                try {
                                    if (Hls && Hls.isSupported()) {
                                        var h = new Hls();
                                        h.loadSource(newUrl);
                                        h.attachMedia(newV);
                                        fsHlsInstance = h;
                                        // play; wait for 'playing' event below
                                        newV.play().catch(function () {});
                                    } else {
                                        newV.src = newUrl;
                                        newV.play().catch(function () {});
                                    }
                                } catch (e) { console.warn('Failed to switch fullscreen HLS', e); }
                            }).catch(function () { try { newV.src = newUrl; newV.play().catch(function () {}); } catch (e) {} });
                        }

                        // Safety attach timeout: if we haven't received frames quickly, force Hls/native fallback.
                        var attachTimeout = setTimeout(function () {
                            try {
                                var isPlaying = newV && !newV.paused && !newV.ended && newV.readyState > 2;
                                if (!isPlaying) {
                                    try {
                                        // If an Hls instance is available (reused), re-attach to ensure it owns the element
                                        if (fsHlsInstance) {
                                            try { fsHlsInstance.detachMedia(); } catch (e) {}
                                            try { fsHlsInstance.attachMedia(newV); newV.play().catch(function () {}); } catch (e) {}
                                        } else {
                                            // Try to initialize Hls now and attach
                                            ensureHls().then(function (Hls) {
                                                try {
                                                    if (Hls && Hls.isSupported()) {
                                                        var hh = new Hls({ enableWorker: true, lowLatencyMode: true, liveSyncDurationCount: 3, maxBufferLength: 30 });
                                                        hh.loadSource(newUrl);
                                                        hh.attachMedia(newV);
                                                        fsHlsInstance = hh;
                                                        try {
                                                            var onFragFb = function () { try { hh.off && hh.off(Hls.Events.FRAG_BUFFERED, onFragFb); finalizeSwap(true); } catch (e) { finalizeSwap(true); } };
                                                            if (hh && hh.on && Hls && Hls.Events && typeof Hls.Events.FRAG_BUFFERED !== 'undefined') hh.on(Hls.Events.FRAG_BUFFERED, onFragFb);
                                                        } catch (e) {}
                                                        newV.play().catch(function () {});
                                                    } else {
                                                        newV.src = newUrl; newV.play().catch(function () {});
                                                    }
                                                } catch (e) { try { newV.src = newUrl; newV.play().catch(function () {}); } catch (er) {} }
                                            }).catch(function () { try { newV.src = newUrl; newV.play().catch(function () {}); } catch (e) {} });
                                        }
                                    } catch (e) {}
                                }
                            } catch (e) {}
                        }, 2200);

                        // When the new video reports playing (a frame rendered), finalize swap.
                        var onPlaying = function () { try { clearTimeout(attachTimeout); newV.removeEventListener('playing', onPlaying); newV.removeEventListener('loadeddata', onLoaded); finalizeSwap(true); } catch (e) { try { clearTimeout(attachTimeout); } catch (er) {} finalizeSwap(true); } };
                        var onLoaded = function () { try { clearTimeout(attachTimeout); newV.removeEventListener('playing', onPlaying); newV.removeEventListener('loadeddata', onLoaded); finalizeSwap(true); } catch (e) { try { clearTimeout(attachTimeout); } catch (er) {} finalizeSwap(true); } };
                        newV.addEventListener('playing', onPlaying);
                        newV.addEventListener('loadeddata', onLoaded);

                        // safety fallback: finalize swap after 4s even if playing event didn't fire
                        setTimeout(function () { finalizeSwap(false); }, 4000);
                    } catch (e) { console.warn('Error while switching fullscreen camera video', e); }
                } catch (e) { }
                // update marker visuals on both maps
                try { updateMarkerActiveState(camId); } catch (e) {}

                // open a minimal popup on the main map marker and center the main map on it (non-FS only) to preserve the previous behavior
                try {
                    var mobj = cameraById[camId];
                    if (mobj && mobj.marker) {
                        try { mobj.marker.openPopup(); } catch (e) {}
                    }
                } catch (e) {}
            } catch (e) { }
        }

        // Make an element draggable within the viewport (mouse and touch)
        function makeDraggable(el, handle) {
            if (!el) return;
            var dragging = false; var startX=0, startY=0, origX=0, origY=0;
            var startOnHandle = false;
            var downTarget = null;
            var actualHandle = handle || el;

            actualHandle.addEventListener('mousedown', function (ev) {
                // only initiate drag if pointer starts on the handle
                startOnHandle = true; downTarget = ev.target;
                dragging = true; startX = ev.clientX; startY = ev.clientY;
                var r = el.getBoundingClientRect(); origX = r.left; origY = r.top;
                el.style.cursor = 'grabbing'; ev.preventDefault();
            });
            document.addEventListener('mousemove', function (ev) {
                if (!dragging) return; var dx = ev.clientX - startX; var dy = ev.clientY - startY;
                var nx = origX + dx; var ny = origY + dy;
                // clamp inside viewport
                nx = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, nx));
                ny = Math.max(8, Math.min(window.innerHeight - el.offsetHeight - 8, ny));
                el.style.left = nx + 'px'; el.style.top = ny + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto';
            });
            document.addEventListener('mouseup', function () { if (dragging) { dragging = false; el.style.cursor = 'grab'; startOnHandle = false; downTarget = null; } });

            // touch support
            actualHandle.addEventListener('touchstart', function (ev) {
                if (!ev.touches || !ev.touches[0]) return; var t = ev.touches[0]; startOnHandle = true; dragging = true; startX = t.clientX; startY = t.clientY; var r = el.getBoundingClientRect(); origX = r.left; origY = r.top; ev.preventDefault();
            }, { passive: false });
            document.addEventListener('touchmove', function (ev) { if (!dragging) return; if (!ev.touches || !ev.touches[0]) return; var t = ev.touches[0]; var dx = t.clientX - startX; var dy = t.clientY - startY; var nx = origX + dx; var ny = origY + dy; nx = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, nx)); ny = Math.max(8, Math.min(window.innerHeight - el.offsetHeight - 8, ny)); el.style.left = nx + 'px'; el.style.top = ny + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto'; }, { passive: false });
            document.addEventListener('touchend', function () { dragging = false; startOnHandle = false; });
        }

        // Create or update the mini map inside the fullscreen overlay
        function createOrUpdateMiniMap(activeCamId) {
            try {
                if (!fsMapContainer) return;
                // If miniMap already exists, reuse it and move its root into the FS container
                if (miniMap && miniRootEl) {
                    // ensure drag handle exists
                    fsMapContainer.innerHTML = '';
                    var dragHandle = document.createElement('div');
                    dragHandle.style.height = '26px'; dragHandle.style.background = 'rgba(0,0,0,0.4)'; dragHandle.style.color = '#fff'; dragHandle.style.display = 'flex'; dragHandle.style.alignItems = 'center'; dragHandle.style.padding = '0 8px'; dragHandle.style.cursor = 'grab'; dragHandle.textContent = 'Drag map'; dragHandle.style.fontSize = '12px';
                    fsMapContainer.appendChild(dragHandle);
                    makeDraggable(fsMapContainer, dragHandle);
                    fsMapContainer.appendChild(miniRootEl);
                    // refresh tiles
                    try { if (miniTileLayer && typeof miniTileLayer.redraw === 'function') miniTileLayer.redraw(); } catch (e) {}
                    try { miniMap.invalidateSize(); } catch (e) {}
                } else {
                    fsMapContainer.innerHTML = '';
                    var dragHandle = document.createElement('div');
                    dragHandle.style.height = '26px'; dragHandle.style.background = 'rgba(0,0,0,0.4)'; dragHandle.style.color = '#fff'; dragHandle.style.display = 'flex'; dragHandle.style.alignItems = 'center'; dragHandle.style.padding = '0 8px'; dragHandle.style.cursor = 'grab'; dragHandle.textContent = 'Drag map'; dragHandle.style.fontSize = '12px';
                    fsMapContainer.appendChild(dragHandle);
                    makeDraggable(fsMapContainer, dragHandle);
                    miniRootEl = document.createElement('div');
                    miniRootEl.style.width = '100%'; miniRootEl.style.height = 'calc(100% - 26px)';
                    fsMapContainer.appendChild(miniRootEl);

                    miniMap = L.map(miniRootEl, { center: [36.147, -115.160], zoom: 15, attributionControl: false, zoomControl: false, dragging: true });
                    try {
                        miniTileLayer = L.tileLayer(esriUrl, { maxZoom: 19 }).addTo(miniMap);
                    } catch (e) {
                        miniTileLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }).addTo(miniMap);
                    }

                    // add markers
                    miniMarkersById = {};
                    try {
                        for (var k in cameraById) {
                            var cam = cameraById[k];
                            if (!cam || !cam.coords) continue;
                            var idnum = Number(k);
                            var miniIcon = L.divIcon({ className: 'mini-camera-icon', html: '<div class="mini-dot" style="width:14px;height:14px;border-radius:50%;background:#ffffff;border:2px solid #666;box-shadow:0 1px 2px rgba(0,0,0,0.3)"></div>', iconSize: [18,18], iconAnchor: [9,9] });
                            var m = L.marker(cam.coords, { icon: miniIcon, title: cam.title || ('Camera ' + k) }).addTo(miniMap);
                            // bind a small, non-panning popup that shows ONLY the camera's name (title/location/roadway)
                            try {
                                // Prefer the stored, computed title (set when markers were created).
                                var nameOnly = (cameraById && cameraById[k] && cameraById[k].title) || (cam && (cam.location || cam.roadway)) || ('Camera ' + k);
                                m.bindPopup(escHtml(String(nameOnly)), { autoPan: false, closeOnClick: true });
                            } catch (e) {}
                            miniMarkersById[idnum] = m;
                            (function (mid, mm) { mm.on('click', function () { try { switchFullscreenCamera(mid); } catch (e) {} }); })(idnum, m);
                        }
                    } catch (e) {}

                    try {
                        var trackEl = document.getElementById('track-geojson');
                        if (trackEl) {
                            var txt = trackEl.textContent || trackEl.innerText || '';
                            var gj = JSON.parse(txt);
                            var miniTrack = L.geoJSON(gj, { style: function (feature) { return { color: '#d6336c', weight: 3, opacity: 0.9 }; } }).addTo(miniMap);
                            try { miniMap.fitBounds(miniTrack.getBounds().pad(0.12)); } catch (e) {}
                        }
                    } catch (e) {}
                }

                // focus on active camera
                try {
                    var coords = cameraById[activeCamId] && cameraById[activeCamId].coords;
                    if (coords && miniMap) miniMap.setView(coords, Math.max(map.getZoom(), 16));
                } catch (e) {}

                // apply active styling
                try { updateMarkerActiveState(activeCamId); } catch (e) {}
            } catch (e) { console.warn('createOrUpdateMiniMap failed', e); }
        }

        // Update marker active styling on both the main map and the mini map
        function updateMarkerActiveState(activeCamId) {
            try {
                for (var k in cameraById) {
                    try {
                        var idnum = Number(k);
                        var o = cameraById[k];
                        var el = o && o.marker && o.marker.getElement && o.marker.getElement();
                        if (el) {
                            if (idnum === Number(activeCamId)) el.style.boxShadow = '0 0 0 3px rgba(52,144,220,0.35)'; else el.style.boxShadow = '';
                        }
                        var mm = miniMarkersById && miniMarkersById[idnum];
                        if (mm && mm.getElement) {
                            var mel = mm.getElement();
                            if (mel) {
                                var dot = mel.querySelector && mel.querySelector('div');
                                if (dot) {
                                    if (idnum === Number(activeCamId)) dot.style.background = '#34a0ff'; else dot.style.background = '#fff';
                                    if (idnum === Number(activeCamId)) dot.style.borderColor = '#0b66ff'; else dot.style.borderColor = '#666';
                                }
                            }
                        }
                    } catch (e) {}
                }
            } catch (e) {}
        }

        // Add imagery metadata to the legend (best-effort; may be blocked by CORS)
        try {
            var legendEl = document.getElementById('map-legend');
            if (legendEl) {
                // Create a small container for imagery info
                var infoEl = document.createElement('div');
                infoEl.id = 'imagery-info';
                infoEl.style.marginTop = '6px';
                infoEl.textContent = 'Imagery date: checking…';
                legendEl.appendChild(infoEl);

                // Also add a button to switch to OpenStreetMap tiles for comparison
                var switchBtn = document.createElement('button');
                switchBtn.type = 'button';
                switchBtn.textContent = 'Switch to OSM (map view)';
                switchBtn.style.display = 'block';
                switchBtn.style.marginTop = '6px';
                switchBtn.style.fontSize = '12px';
                switchBtn.onclick = function () {
                    if (tileLayerRef) map.removeLayer(tileLayerRef);
                    tileLayerRef = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                        maxZoom: 19,
                        attribution: '&copy; OpenStreetMap contributors'
                    }).addTo(map);
                    switchBtn.textContent = 'Switched to OSM — switch back';
                    switchBtn.onclick = function () {
                        if (tileLayerRef) map.removeLayer(tileLayerRef);
                        tileLayerRef = L.tileLayer(esriUrl, {
                            maxZoom: 19,
                            maxNativeZoom: 19,
                            tileSize: 256,
                            errorTileUrl: tileLayerRef.options.errorTileUrl,
                            updateWhenIdle: false,
                            attribution: ds.tileAttribution || 'Esri World Imagery'
                        }).addTo(map);
                        switchBtn.textContent = 'Switch to OSM (map view)';
                        // re-run metadata check if desired
                        fetchImageryMetadata();
                    };
                };
                legendEl.appendChild(switchBtn);

                // Add bounds relax button
                var relaxBtn = document.createElement('button');
                relaxBtn.type = 'button';
                relaxBtn.textContent = 'Relax bounds';
                relaxBtn.style.display = 'block';
                relaxBtn.style.marginTop = '6px';
                relaxBtn.style.fontSize = '12px';
                relaxBtn.onclick = function () {
                    relaxBounds();
                    relaxBtn.textContent = 'Bounds relaxed';
                    relaxBtn.disabled = true;
                };
                legendEl.appendChild(relaxBtn);

                // Add small pan nudges so you can move the map south if the race is further down
                var nudgeWrap = document.createElement('div');
                nudgeWrap.style.marginTop = '6px';
                nudgeWrap.style.display = 'grid';
                nudgeWrap.style.gridTemplateColumns = 'repeat(3, auto)';
                nudgeWrap.style.gap = '4px';

                var btnN = document.createElement('button'); btnN.textContent = '↑';
                var btnS = document.createElement('button'); btnS.textContent = '↓';
                var btnW = document.createElement('button'); btnW.textContent = '←';
                var btnE = document.createElement('button'); btnE.textContent = '→';
                [btnN, btnS, btnW, btnE].forEach(function (b) { b.style.padding = '4px 6px'; b.style.fontSize = '12px'; });
                // nudge function (in degrees lat/lng)
                function nudge(dLat, dLng) { map.setView([map.getCenter().lat + dLat, map.getCenter().lng + dLng], map.getZoom(), { animate: true }); }
                btnN.addEventListener('click', function () { nudge(0.005, 0); });
                btnS.addEventListener('click', function () { nudge(-0.005, 0); });
                btnW.addEventListener('click', function () { nudge(0, -0.005); });
                btnE.addEventListener('click', function () { nudge(0, 0.005); });

                // Arrange buttons visually: N on top row center, W S E on next row
                var grid = document.createElement('div');
                grid.style.display = 'grid';
                grid.style.gridTemplateColumns = '24px 24px 24px';
                grid.style.gridTemplateRows = '24px 24px';
                grid.style.gap = '2px';
                var empty = document.createElement('div'); grid.appendChild(empty);
                var ndiv = document.createElement('div'); ndiv.appendChild(btnN); grid.appendChild(ndiv);
                grid.appendChild(document.createElement('div'));
                var wdiv = document.createElement('div'); wdiv.appendChild(btnW); grid.appendChild(wdiv);
                var sdiv = document.createElement('div'); sdiv.appendChild(btnS); grid.appendChild(sdiv);
                var ediv = document.createElement('div'); ediv.appendChild(btnE); grid.appendChild(ediv);
                legendEl.appendChild(grid);

                // Rotation control: visually rotate the map container and counter-rotate overlays
                var rotLabel = document.createElement('label'); rotLabel.textContent = 'Rotate map:'; rotLabel.style.display = 'block'; rotLabel.style.marginTop = '6px'; rotLabel.style.fontSize = '12px';
                legendEl.appendChild(rotLabel);
                var rotInput = document.createElement('input');
                rotInput.type = 'range'; rotInput.min = -180; rotInput.max = 180; rotInput.value = 0; rotInput.style.width = '100%';
                legendEl.appendChild(rotInput);
                var rotReset = document.createElement('button'); rotReset.type = 'button'; rotReset.textContent = 'Reset rotation'; rotReset.style.display = 'block'; rotReset.style.marginTop = '4px'; rotReset.style.fontSize = '12px';
                legendEl.appendChild(rotReset);

                // Helper to apply rotation
                function applyRotation(deg) {
                    var mapContainer = document.getElementById('map');
                    if (!mapContainer) return;
                    // rotate the visual map area
                    mapContainer.style.transformOrigin = '50% 50%';
                    mapContainer.style.transform = 'rotate(' + deg + 'deg)';
                    // counter-rotate overlays so UI stays readable
                    var overlays = [document.getElementById('map-legend'), document.getElementById('standings'), document.getElementById('overlay-toggle')];
                    overlays.forEach(function (el) {
                        if (!el) return;
                        el.style.transformOrigin = '50% 50%';
                        el.style.transform = 'rotate(' + (-deg) + 'deg)';
                    });
                }
                rotInput.addEventListener('input', function () { applyRotation(Number(rotInput.value)); });
                rotReset.addEventListener('click', function () { rotInput.value = 0; applyRotation(0); });
            }
        } catch (e) {
            console.warn('Could not attach imagery info UI to legend', e);
        }

        // Best-effort function to fetch imagery metadata from Esri MapServer and ArcGIS Online
        function fetchImageryMetadata() {
            var info = document.getElementById('imagery-info');
            if (!info) return;
            info.textContent = 'Imagery date: checking…';
            var metaUrl = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer?f=json';
            fetch(metaUrl).then(function (r) {
                if (!r.ok) throw new Error('meta fetch failed ' + r.status);
                return r.json();
            }).then(function (j) {
                // Look for documentInfo.LastEditDate or serviceItemId
                var last = j && j.documentInfo && j.documentInfo.LastEditDate;
                if (last) {
                    var ms = last;
                    if (ms < 1e11) ms = ms * 1000; // seconds -> ms
                    info.textContent = 'Imagery last edit: ' + new Date(ms).toLocaleString();
                    return;
                }
                var itemId = j && j.serviceItemId;
                if (itemId) {
                    // Try to fetch ArcGIS Online item metadata (may be CORS-blocked)
                    return fetch('https://www.arcgis.com/sharing/rest/content/items/' + encodeURIComponent(itemId) + '?f=json')
                        .then(function (r2) { if (!r2.ok) throw new Error('item fetch failed ' + r2.status); return r2.json(); })
                        .then(function (item) {
                            if (item && item.modified) {
                                // ArcGIS 'modified' is ms since epoch
                                var ms2 = item.modified;
                                info.textContent = 'Imagery item modified: ' + new Date(ms2).toLocaleString();
                            } else {
                                info.textContent = 'Imagery metadata: unavailable';
                            }
                        });
                }
                info.textContent = 'Imagery metadata: unavailable';
            }).catch(function (err) {
                console.warn('Imagery metadata fetch failed', err);
                info.textContent = 'Imagery metadata: unavailable (network/CORS)';
            });
        }

        // Run metadata check once
        try { fetchImageryMetadata(); } catch (e) { }

        // Load the inline GeoJSON for the track
        try {
            var geojsonEl = document.getElementById('track-geojson');
            if (geojsonEl) {
                var txt = geojsonEl.textContent || geojsonEl.innerText || '';
                var gj = JSON.parse(txt);
                var trackLayer = L.geoJSON(gj, {
                    style: function (feature) {
                        return { color: '#d6336c', weight: 3, opacity: 0.9 };
                    }
                }).addTo(map);

                // Fit the map to the track bounds but respect maxbounds
                try {
                    var tb = trackLayer.getBounds();
                    if (tb.isValid()) {
                        map.fitBounds(tb.pad(0.15));
                    }
                } catch (e) {
                    console.warn('Could not fit bounds to track:', e);
                }
            }
        } catch (e) {
            console.warn('Failed to parse track GeoJSON', e);
        }

        // Standings UI
        var standingsEl = document.getElementById('standings-content');
        var toggleBtn = document.getElementById('overlay-toggle');

        function renderMessage(msg) {
            if (!standingsEl) return;
            standingsEl.innerHTML = '<p>' + String(msg) + '</p>';
        }

        // Generic accessor helpers for flexible API shapes
        function getPositionField(item) {
            return item.position || item.Position || item.pos || item.race_position || null;
        }
        function getNumberField(item) {
            return item.number || item.car_number || item.carNo || item.car || item.no || item['#'] || null;
        }
        function getDriverField(item) {
            return item.driver || item.driver_name || item.name || item.pilot || '';
        }

        // Fetch standings from endpoint
        var api = ds.apiEndpoint || 'https://api.openf1.org/v1/position?session_key=latest';

        async function fetchStandings() {
            if (!standingsEl) return;
            renderMessage('Loading latest standings…');
            try {
                var resp = await fetch(api, { cache: 'no-store' });
                if (!resp.ok) {
                    throw new Error('Network response was not ok: ' + resp.status);
                }
                var data = await resp.json();

                // Data may be an object with an array property or be the array itself
                var items = data;
                if (!Array.isArray(items)) {
                    for (var k in data) {
                        if (Array.isArray(data[k])) { items = data[k]; break; }
                    }
                }

                if (!Array.isArray(items) || items.length === 0) {
                    renderMessage('No standings data available');
                    return;
                }

                // Determine the latest date value if present
                var latestDate = null;
                items.forEach(function (it) {
                    if (!it) return;
                    var d = it.date || it.Date || it.timestamp || null;
                    if (!d) return;
                    var parsed = new Date(d);
                    if (!isNaN(parsed.getTime())) {
                        if (!latestDate || parsed > latestDate) latestDate = parsed;
                    }
                });

                var filtered = items.slice();
                if (latestDate) {
                    filtered = filtered.filter(function (it) {
                        var d = it.date || it.Date || it.timestamp || '';
                        return d && new Date(d).getTime() === latestDate.getTime();
                    });
                }

                if (!filtered.length) filtered = items.slice();

                filtered.sort(function (a, b) {
                    var pa = parseInt(getPositionField(a), 10);
                    var pb = parseInt(getPositionField(b), 10);
                    if (isNaN(pa)) pa = 9999;
                    if (isNaN(pb)) pb = 9999;
                    return pa - pb;
                });

                var ul = document.createElement('ul');
                filtered.forEach(function (it) {
                    var pos = getPositionField(it);
                    var num = getNumberField(it);
                    var driver = getDriverField(it) || '';
                    var textParts = [];
                    if (pos !== null && pos !== undefined) textParts.push('P' + pos);
                    if (num !== null && num !== undefined) textParts.push('#' + num);
                    if (driver) textParts.push(driver);
                    var li = document.createElement('li');
                    li.textContent = textParts.join(' — ');
                    ul.appendChild(li);
                });

                standingsEl.innerHTML = '';
                var header = document.createElement('div');
                header.style.marginBottom = '6px';
                header.textContent = latestDate ? ('Updated: ' + latestDate.toLocaleTimeString()) : '';
                standingsEl.appendChild(header);
                standingsEl.appendChild(ul);

            } catch (err) {
                console.error('Failed to fetch standings:', err);
                renderMessage('Unable to load standings (network or CORS).');
            }
        }

        // Initial fetch and periodic refresh
        //fix later, openf1 requires paid for live data
        // fetchStandings();
        // var refreshInterval = 15000; // 15s
        // var refreshId = setInterval(fetchStandings, refreshInterval);

        // Toggle button interaction
        if (toggleBtn) {
            toggleBtn.addEventListener('click', function () {
                var aside = document.getElementById('standings');
                if (!aside) return;
                var expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
                if (expanded) {
                    aside.style.display = 'none';
                    toggleBtn.setAttribute('aria-expanded', 'false');
                    toggleBtn.textContent = 'Show Standings';
                } else {
                    aside.style.display = '';
                    toggleBtn.setAttribute('aria-expanded', 'true');
                    toggleBtn.textContent = 'Hide Standings';
                }
            });
        }

        // Clean up on unload
        window.addEventListener('unload', function () {
            if (refreshId) clearInterval(refreshId);
            try { map.remove(); } catch (e) { }
        });
    }

    // Helper: show a visible diagnostic message in the map area
    function showMapDiagnostic(msg) {
        var mapEl = document.getElementById('map');
        if (!mapEl) return;
        mapEl.innerHTML = '<div style="position:absolute;left:12px;top:12px;z-index:2000;background:rgba(255,255,255,0.95);padding:10px;border-radius:6px;max-width:360px;box-shadow:0 6px 18px rgba(0,0,0,0.12)">' + String(msg) + '</div>';
    }

    // If Leaflet (L) is available, init immediately. Otherwise try to dynamically load it.
    document.addEventListener('DOMContentLoaded', function () {
        if (window.L) {
            initApp();
            return;
        }

        // Inform developer in the DOM and console
        console.warn('Leaflet (L) not found — attempting to load dynamically.');
        showMapDiagnostic('Leaflet map library not found. Attempting to load required assets…');

        // Try to add Leaflet CSS if missing or not actually applied (some CSP/SRI setups leave the link but it may be blocked)
        try {
            var cssLoaded = Array.prototype.slice.call(document.styleSheets).some(function (s) {
                return s && s.href && s.href.indexOf('leaflet') !== -1;
            });
            if (!cssLoaded) {
                var link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
                document.head.appendChild(link);
            }
        } catch (e) {
            // Some browsers restrict access to document.styleSheets due to CORS; fall back to inserting the link
            var link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
            document.head.appendChild(link);
        }

        // Load Leaflet JS without integrity attributes to avoid SRI/CSP mismatches during local testing
        var script = document.createElement('script');
        script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
        script.async = false; // preserve execution order
        script.onload = function () {
            console.info('Leaflet loaded dynamically; initializing app.');
            // remove diagnostic then initialize
            var mapEl = document.getElementById('map'); if (mapEl) mapEl.innerHTML = '';
            initApp();
        };
        script.onerror = function (e) {
            console.error('Failed to load Leaflet library dynamically', e);
            showMapDiagnostic('Failed to load Leaflet library. Please check network or CDN availability and open the browser console for details.');
        };
        document.head.appendChild(script);
    });

})();
