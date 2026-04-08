
// Cek apakah ini halaman media player atau bukan
const isMediaPlayerPage = document.getElementById('media-container') !== null;

if (isMediaPlayerPage) {
    // Kode untuk media player
    let mediaFiles = [];
    let allMediaFiles = []; // Store original list
    let notPriorityFiles = []; // Store not-priority list
    let priorityFiles = []; // Store priority list
    let currentIndex = 0;
    let autoplayEnabled = true;
    let currentView = 'slide'; // 'slide' or 'grid'
    let hideNonPriority = true; // Default aktif
    let wakeLock = null; // For keeping screen awake
    let autoWasDisabledInGrid = false; // Track if auto was disabled when switching to grid
    let renderToken = 0; // Prevent stale async render from replacing newer media
    let gridSelectMode = false;
    const safeModeEnabled = true;
    let autoplayTimer = null;
    let bundleProgressHideTimer = null;
    let activePannellumViewer = null;
    let pannellumLoaderPromise = null;
    let jszipLoaderPromise = null;
    let bundleProgressRefs = null;
    const selectedMediaSet = new Set();
    const photosphereCache = new Map();
    const MAX_PHOTOSPHERE_CACHE_ENTRIES = 400;
    // LFS fallback map: loaded from lfs-fallbacks.json (optional) and merged with localStorage overrides
    let lfsFallbackMap = {};
    let lfsFallbacksLoaded = false;

    async function loadLfsFallbacks() {
        try {
            const res = await fetch('lfs-fallbacks.json', { cache: 'no-store' });
            if (res && res.ok) {
                const json = await res.json();
                if (json && typeof json === 'object') {
                    lfsFallbackMap = Object.assign({}, lfsFallbackMap, json);
                }
            }
        } catch (err) {
            // ignore if file not present
        }

        try {
            const local = localStorage.getItem('lfsFallbacks');
            if (local) {
                const parsed = JSON.parse(local);
                if (parsed && typeof parsed === 'object') {
                    lfsFallbackMap = Object.assign({}, lfsFallbackMap, parsed);
                }
            }
        } catch (err) {
            console.warn('Failed to load local lfsFallbacks:', err);
        }

        lfsFallbacksLoaded = true;
    }

    function getFallbackUrlFor(file) {
        if (!file) return null;
        if (lfsFallbackMap[file]) return lfsFallbackMap[file];
        const name = file.split('/').pop();
        if (lfsFallbackMap[name]) return lfsFallbackMap[name];
        return null;
    }

    function saveLocalFallback(key, url) {
        try {
            lfsFallbackMap[key] = url;
            localStorage.setItem('lfsFallbacks', JSON.stringify(lfsFallbackMap));
        } catch (err) {
            console.error('Failed to save fallback mapping:', err);
        }
    }
    const pannellumSourceCandidates = [
        {
            name: 'local pannellum',
            css: 'pannellum/pannellum.css',
            js: 'pannellum/pannellum.js',
        },
        {
            name: 'cdn',
            css: 'https://cdn.jsdelivr.net/npm/pannellum@2.5.7/build/pannellum.css',
            js: 'https://cdn.jsdelivr.net/npm/pannellum@2.5.7/build/pannellum.js',
        },
    ];
    const ZIP_PART_THRESHOLD_MB = 700;
    const ZIP_PART_THRESHOLD_BYTES = ZIP_PART_THRESHOLD_MB * 1024 * 1024;
    const ZIP_SMART_SINGLE_MAX_MB = 380;
    const ZIP_SMART_SINGLE_MAX_BYTES = ZIP_SMART_SINGLE_MAX_MB * 1024 * 1024;
    const ZIP_SMART_MAX_FILES = 70;
    
    const mediaContainer = document.getElementById('media-container');
    const filenameDiv = document.getElementById('filename');
    const prevBtn = document.getElementById('prev');
    const nextBtn = document.getElementById('next');
    const slideContainer = document.getElementById('slide-container');
    const gridContainer = document.getElementById('grid-container');
    const gridView = document.getElementById('grid-view');
    const autoNotification = document.getElementById('auto-notification');
    const bundleCompressionSelect = document.getElementById('bundleCompression');
    const downloadAllBtn = document.getElementById('download-all-btn');
    const toggleSelectBtn = document.getElementById('toggle-select-btn');
    const downloadSelectedBtn = document.getElementById('download-selected-btn');

    // IntersectionObserver for lazy-loading grid images (reduced prefetch distance)
    const gridObserverOptions = { root: null, rootMargin: '120px', threshold: 0.1 };
    const gridImageObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            const img = entry.target;
            const src = img.dataset.src;
            if (src) {
                // use async decoding and set src when near viewport
                img.decoding = 'async';
                img.src = src;
                img.removeAttribute('data-src');
            }
            gridImageObserver.unobserve(img);
        });
    }, gridObserverOptions);

    // Separate observer to trigger expensive PhotoSphere detection only when image is near viewport
    const sphereObserverOptions = { root: null, rootMargin: '200px', threshold: 0.02 };
    const sphereObserver = new IntersectionObserver((entries) => {
        entries.forEach(async (entry) => {
            if (!entry.isIntersecting) return;
            const img = entry.target;
            const file = img.dataset.src || img.src || img.getAttribute('data-file');
            const gridItem = img.closest && img.closest('.grid-item');
            try {
                const isSphere = await detectPhotoSphere(file);
                if (isSphere && gridItem) addSphereBadge(gridItem);
            } catch (err) {
                console.warn('Grid PhotoSphere detection failed:', err);
            }
            sphereObserver.unobserve(img);
        });
    }, sphereObserverOptions);
    
    console.log('Elements loaded:');
    console.log('- slideContainer:', slideContainer);
    console.log('- gridContainer:', gridContainer);
    console.log('- autoNotification:', autoNotification);
    // Load optional LFS fallback mappings (lfs-fallbacks.json) and local overrides
    loadLfsFallbacks().catch(() => {});

    function clearMediaContainer() {
        clearAutoplayTimer();

        if (mediaContainer) {
            const videos = mediaContainer.querySelectorAll('video');
            videos.forEach(video => {
                try {
                    video.pause();
                    video.removeAttribute('src');
                    video.load();
                } catch (err) {
                    console.warn('Failed to fully release video element:', err);
                }
            });
        }

        if (activePannellumViewer) {
            try {
                activePannellumViewer.destroy();
            } catch (err) {
                console.warn('Failed to destroy PhotoSphere viewer:', err);
            }
            activePannellumViewer = null;
        }
        if (mediaContainer) {
            mediaContainer.innerHTML = '';
        }
    }

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[data-src="${src}"]`);
            if (existing) {
                if (window.pannellum) {
                    resolve();
                } else {
                    existing.addEventListener('load', () => resolve(), { once: true });
                    existing.addEventListener('error', () => reject(new Error('Failed loading script: ' + src)), { once: true });
                }
                return;
            }

            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.dataset.src = src;
            script.onload = () => resolve();
            script.onerror = () => {
                script.remove();
                reject(new Error('Failed loading script: ' + src));
            };
            document.head.appendChild(script);
        });
    }

    function loadStylesheet(href) {
        const existing = document.querySelector(`link[data-href="${href}"]`);
        if (existing) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.dataset.href = href;
        document.head.appendChild(link);
    }

    async function ensurePannellumLoaded() {
        if (window.pannellum) return;
        if (pannellumLoaderPromise) {
            await pannellumLoaderPromise;
            return;
        }

        pannellumLoaderPromise = (async () => {
            let lastError = null;

            const sourcesToTry = safeModeEnabled
                ? pannellumSourceCandidates.filter(source => !/^https?:\/\//i.test(source.js || ''))
                : pannellumSourceCandidates;

            if (!sourcesToTry.length) {
                throw new Error('Safe Mode aktif: sumber lokal Pannellum tidak tersedia.');
            }

            for (const source of sourcesToTry) {
                try {
                    loadStylesheet(source.css);
                    await loadScript(source.js);
                    if (window.pannellum) {
                        console.log('Pannellum loaded from:', source.name);
                        return;
                    }
                } catch (err) {
                    lastError = err;
                    console.warn(`Failed loading Pannellum from ${source.name}:`, err);
                }
            }

            throw lastError || new Error('Pannellum failed to load from all sources');
        })();

        try {
            await pannellumLoaderPromise;
        } catch (err) {
            pannellumLoaderPromise = null;
            throw err;
        }
    }

    async function ensureJSZipLoaded() {
        if (window.JSZip) return;
        if (jszipLoaderPromise) {
            await jszipLoaderPromise;
            return;
        }

        jszipLoaderPromise = (async () => {
            try {
                await loadScript('pannellum/jszip.min.js');
            } catch (localErr) {
                if (safeModeEnabled) {
                    throw new Error('Safe Mode aktif: JSZip lokal tidak ditemukan, fallback CDN diblokir.');
                }

                console.warn('Failed loading local JSZip, fallback CDN:', localErr);
                await loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
            }

            if (!window.JSZip) {
                throw new Error('JSZip tidak tersedia');
            }
        })();

        try {
            await jszipLoaderPromise;
        } catch (err) {
            jszipLoaderPromise = null;
            throw err;
        }
    }

    function toUint8Array(buffer) {
        if (buffer instanceof Uint8Array) return buffer;
        if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
        return new Uint8Array([]);
    }

    function clearAutoplayTimer() {
        if (autoplayTimer) {
            clearTimeout(autoplayTimer);
            autoplayTimer = null;
        }
    }

    function scheduleAutoplay(delayMs) {
        clearAutoplayTimer();
        if (!autoplayEnabled || currentView !== 'slide') return;
        autoplayTimer = setTimeout(() => {
            autoplayTimer = null;
            if (autoplayEnabled && currentView === 'slide') {
                nextMedia();
            }
        }, delayMs);
    }

    function restartAutoplayForCurrentMedia() {
        if (!autoplayEnabled || currentView !== 'slide') return;
        if (activePannellumViewer) {
            scheduleAutoplay(8000);
            return;
        }

        const currentImage = mediaContainer ? mediaContainer.querySelector('img') : null;
        if (currentImage) {
            scheduleAutoplay(3000);
        }
    }

    function isLocalOrSameOriginPath(path) {
        try {
            const url = new URL(path, window.location.href);
            if (url.protocol === 'file:') return true;
            if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
            return url.origin === window.location.origin;
        } catch (err) {
            return false;
        }
    }

    function assertSafePath(path, context) {
        if (!safeModeEnabled) return;
        if (isLocalOrSameOriginPath(path)) return;
        throw new Error(`Safe Mode memblokir ${context} eksternal: ${path}`);
    }

    function setPhotoSphereCache(file, value) {
        if (photosphereCache.has(file)) {
            photosphereCache.delete(file);
        }

        photosphereCache.set(file, value);

        if (photosphereCache.size > MAX_PHOTOSPHERE_CACHE_ENTRIES) {
            const oldestKey = photosphereCache.keys().next().value;
            if (oldestKey !== undefined) {
                photosphereCache.delete(oldestKey);
            }
        }
    }

    function getBundleCompressionConfig() {
        const selectedMode = bundleCompressionSelect ? bundleCompressionSelect.value : 'store';

        switch (selectedMode) {
            case 'deflate-fast':
                return { compression: 'DEFLATE', level: 1, label: 'DEFLATE Lv1 (Cepat)' };
            case 'deflate-balanced':
                return { compression: 'DEFLATE', level: 6, label: 'DEFLATE Lv6 (Seimbang)' };
            case 'deflate-max':
                return { compression: 'DEFLATE', level: 9, label: 'DEFLATE Lv9 (Maksimum)' };
            case 'store':
            default:
                return { compression: 'STORE', level: null, label: 'STORE (Paling Stabil)' };
        }
    }

    function getBundleSplitConfig(totalFiles) {
        const smartLimitBytes = ZIP_SMART_SINGLE_MAX_BYTES;

        return {
            mode: 'smart',
            label: `Auto Cerdas (<=${ZIP_SMART_SINGLE_MAX_MB}MB utuh)`,
            partThresholdBytes: ZIP_PART_THRESHOLD_BYTES,
            smartSingleLimitBytes: smartLimitBytes,
            smartMaxFiles: ZIP_SMART_MAX_FILES,
            shouldSplitImmediately: false,
        };
    }

    function sanitizeBundleName(name) {
        const safe = (name || 'media_bundle')
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[<>:"/\\|?*]+/g, '-')
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^[_\-.]+|[_\-.]+$/g, '');
        return safe || 'media_bundle';
    }

    function setBundleButtonState(isBusy, text) {
        if (!downloadAllBtn) return;
        if (isBusy) {
            downloadAllBtn.disabled = true;
            downloadAllBtn.style.opacity = '0.75';
        } else {
            downloadAllBtn.disabled = false;
            downloadAllBtn.style.opacity = '';
        }
        if (text) {
            downloadAllBtn.textContent = text;
        }
    }

    function updateSelectionControls() {
        if (toggleSelectBtn) {
            toggleSelectBtn.textContent = gridSelectMode ? '☑️ Pilih: ON' : '☑️ Pilih: OFF';
        }

        if (downloadAllBtn) {
            const shouldHideDownloadAll = currentView === 'grid' && gridSelectMode;
            downloadAllBtn.style.display = shouldHideDownloadAll ? 'none' : '';
        }

        if (downloadSelectedBtn) {
            downloadSelectedBtn.style.display = gridSelectMode ? '' : 'none';

            const selectedVisibleCount = mediaFiles.filter(file => selectedMediaSet.has(file)).length;
            downloadSelectedBtn.textContent = `📦 Selected (${selectedVisibleCount})`;
            const canDownloadSelected = currentView === 'grid' && selectedVisibleCount > 0;
            downloadSelectedBtn.disabled = !canDownloadSelected;
            downloadSelectedBtn.style.opacity = canDownloadSelected ? '' : '0.55';
        }
    }

    function toggleGridSelectMode() {
        gridSelectMode = !gridSelectMode;
        if (!gridSelectMode) {
            selectedMediaSet.clear();
        }

        if (currentView === 'grid') {
            populateGridView();
        }
        updateSelectionControls();
    }

    function toggleGridItemSelection(file, gridItem, selectBtn) {
        if (!file) return;

        if (selectedMediaSet.has(file)) {
            selectedMediaSet.delete(file);
        } else {
            selectedMediaSet.add(file);
        }

        const isSelected = selectedMediaSet.has(file);
        if (gridItem) {
            gridItem.classList.toggle('selected', isSelected);
        }
        if (selectBtn) {
            selectBtn.textContent = isSelected ? '✅' : '☐';
        }

        updateSelectionControls();
    }

    function getSelectedFilesInCurrentOrder() {
        return mediaFiles.filter(file => selectedMediaSet.has(file));
    }

    function formatBytes(bytes) {
        const value = Number(bytes) || 0;
        if (value < 1024) return `${value} B`;
        const units = ['KB', 'MB', 'GB'];
        let num = value / 1024;
        let unitIndex = 0;
        while (num >= 1024 && unitIndex < units.length - 1) {
            num /= 1024;
            unitIndex += 1;
        }
        return `${num.toFixed(num >= 10 ? 1 : 2)} ${units[unitIndex]}`;
    }

    function ensureBundleProgressPanel() {
        if (bundleProgressRefs) return bundleProgressRefs;

        const panel = document.createElement('div');
        panel.id = 'bundle-progress-panel';
        panel.style.cssText = [
            'position:fixed',
            'top:108px',
            'right:20px',
            'width:min(360px,calc(100vw - 24px))',
            'padding:10px 12px',
            'border-radius:12px',
            'background:rgba(0,0,0,0.72)',
            'color:#f5f5f5',
            'backdrop-filter:blur(8px)',
            'box-shadow:0 6px 18px rgba(0,0,0,0.35)',
            'z-index:1003',
            'font-size:0.82em',
            'line-height:1.35',
            'display:none',
            'text-align:left'
        ].join(';');

        panel.innerHTML = [
            '<div id="bundle-progress-stage" style="font-weight:700;margin-bottom:6px;">Menyiapkan bundle...</div>',
            '<div id="bundle-progress-detail" style="color:#d6d6d6;margin-bottom:8px;white-space:pre-line;">-</div>',
            '<div style="height:6px;background:rgba(255,255,255,0.15);border-radius:999px;overflow:hidden;">',
            '  <div id="bundle-progress-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#ff9800,#ffc947);transition:width 0.2s ease;"></div>',
            '</div>',
            '<div id="bundle-progress-meta" style="margin-top:8px;color:#bfbfbf;font-size:0.9em;">0%</div>'
        ].join('');

        document.body.appendChild(panel);
        bundleProgressRefs = {
            panel,
            stage: panel.querySelector('#bundle-progress-stage'),
            detail: panel.querySelector('#bundle-progress-detail'),
            bar: panel.querySelector('#bundle-progress-bar'),
            meta: panel.querySelector('#bundle-progress-meta'),
        };
        return bundleProgressRefs;
    }

    function updateBundleProgress({ stage, detail, percent, meta }) {
        const refs = ensureBundleProgressPanel();
        refs.panel.style.display = 'block';
        if (stage) refs.stage.textContent = stage;
        if (detail) refs.detail.textContent = detail;
        if (meta) refs.meta.textContent = meta;
        if (typeof percent === 'number' && Number.isFinite(percent)) {
            const safePercent = Math.max(0, Math.min(100, percent));
            refs.bar.style.width = `${safePercent}%`;
        }
    }

    function hideBundleProgress(delayMs = 2500) {
        if (!bundleProgressRefs) return;

        if (bundleProgressHideTimer) {
            clearTimeout(bundleProgressHideTimer);
            bundleProgressHideTimer = null;
        }

        bundleProgressHideTimer = setTimeout(() => {
            if (!bundleProgressRefs) return;
            bundleProgressRefs.panel.style.display = 'none';
            bundleProgressRefs.bar.style.width = '0%';
            bundleProgressHideTimer = null;
        }, delayMs);
    }

    function addSphereBadge(gridItem) {
        if (!gridItem || gridItem.querySelector('.sphere-badge')) return;
        const badge = document.createElement('span');
        badge.className = 'sphere-badge';
        badge.textContent = '360°';
        badge.title = 'PhotoSphere 360';
        gridItem.appendChild(badge);
    }

    async function detectPhotoSphere(file) {
        if (photosphereCache.has(file)) {
            return photosphereCache.get(file);
        }

        if (safeModeEnabled && !isLocalOrSameOriginPath(file)) {
            setPhotoSphereCache(file, false);
            return false;
        }

        try {
            const response = await fetch(file);
            if (!response.ok) {
                setPhotoSphereCache(file, false);
                return false;
            }

            const blob = await response.blob();
            const chunk = blob.slice(0, Math.min(blob.size, 1024 * 768));
            const buffer = await chunk.arrayBuffer();
            const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

            const isSphere = /GPano:ProjectionType\s*=\s*"equirectangular"|<GPano:ProjectionType>\s*equirectangular\s*<\/GPano:ProjectionType>/i.test(text);
            setPhotoSphereCache(file, isSphere);
            return isSphere;
        } catch (err) {
            console.warn('PhotoSphere detection failed for', file, err);
            setPhotoSphereCache(file, false);
            return false;
        }
    }

    async function renderPhotoSphere(file, tokenAtRender) {
        await ensurePannellumLoaded();
        if (tokenAtRender !== renderToken) return;

        clearMediaContainer();
        const viewerEl = document.createElement('div');
        viewerEl.className = 'photosphere-viewer';
        mediaContainer.appendChild(viewerEl);

        activePannellumViewer = window.pannellum.viewer(viewerEl, {
            type: 'equirectangular',
            panorama: file,
            autoLoad: true,
            showZoomCtrl: true,
            showFullscreenCtrl: true,
            mouseZoom: true,
            draggable: true,
            hfov: 100,
        });

        scrollToSlideBottom();

        if (autoplayEnabled && tokenAtRender === renderToken) {
            scheduleAutoplay(8000);
        }
    }

    // Function to request wake lock (keep screen awake)
    async function requestWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                wakeLock = await navigator.wakeLock.request('screen');
                console.log('Wake Lock aktif - layar akan tetap menyala');
                
                // Re-acquire wake lock if visibility changes
                document.addEventListener('visibilitychange', async () => {
                    if (wakeLock !== null && document.visibilityState === 'visible') {
                        wakeLock = await navigator.wakeLock.request('screen');
                    }
                });
            } else {
                console.log('Wake Lock API tidak didukung di browser ini');
            }
        } catch (err) {
            console.error('Error requesting wake lock:', err);
        }
    }
    
    // Show UI for LFS pointer fallback: allow pasting direct URL or previewing
    function showLfsFallbackUI(file, pointerText, tokenAtRender) {
        if (tokenAtRender !== renderToken) return;
        const basename = file.split('/').pop();

        const container = document.createElement('div');
        container.style.cssText = 'color:#ffefdb;padding:14px;background:rgba(40,30,20,0.8);border-radius:10px;max-width:720px;margin:0 12px;text-align:left;';
        container.innerHTML = `
            <div style="font-weight:700;margin-bottom:6px;">⚠️ File disimpan di Git LFS</div>
            <div style="margin-bottom:8px;color:#ffdcb8;font-size:0.95em;">File ini disimpan di Git LFS dan tidak dapat dilayani langsung oleh GitHub Pages. Masukkan URL publik (CDN / S3 / GitHub Releases) untuk melihat preview atau simpan untuk browser ini.</div>
        `;

        const input = document.createElement('input');
        input.type = 'url';
        input.placeholder = 'https://example.cdn.com/path/to/' + encodeURIComponent(basename);
        input.style.cssText = 'width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);background:rgba(0,0,0,0.25);color:#fff;margin-bottom:8px;';

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;align-items:center';

        const previewBtn = document.createElement('button');
        previewBtn.textContent = 'Preview URL';
        previewBtn.className = 'floating-btn';
        previewBtn.style.cssText = 'padding:8px 10px;border-radius:8px;font-size:0.9em;';

        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Simpan untuk browser ini';
        saveBtn.className = 'floating-btn';
        saveBtn.style.cssText = 'padding:8px 10px;border-radius:8px;font-size:0.9em;opacity:0.95;';

        const openBtn = document.createElement('a');
        openBtn.textContent = 'Buka di tab baru';
        openBtn.target = '_blank';
        openBtn.rel = 'noopener noreferrer';
        openBtn.className = 'floating-btn';
        openBtn.style.cssText = 'padding:8px 10px;border-radius:8px;font-size:0.9em;text-decoration:none;display:inline-flex;align-items:center;';

        btnRow.appendChild(previewBtn);
        btnRow.appendChild(saveBtn);
        btnRow.appendChild(openBtn);

        container.appendChild(input);
        container.appendChild(btnRow);

        // If pointerText available, show a copy button
        if (pointerText) {
            const copyBtn = document.createElement('button');
            copyBtn.textContent = 'Copy LFS pointer';
            copyBtn.className = 'floating-btn';
            copyBtn.style.cssText = 'padding:8px 10px;border-radius:8px;font-size:0.9em;';
            copyBtn.onclick = () => {
                navigator.clipboard && navigator.clipboard.writeText(pointerText).then(() => {
                    copyBtn.textContent = 'Copied';
                    setTimeout(() => copyBtn.textContent = 'Copy LFS pointer', 1400);
                }).catch(() => {});
            };
            container.appendChild(document.createElement('br'));
            container.appendChild(copyBtn);
        }

        // Preview handler
        previewBtn.onclick = async () => {
            const url = (input.value || '').trim();
            if (!url) return alert('Masukkan URL publik terlebih dahulu');
            try {
                // Try to fetch headers first to check content-type
                const head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
                if (head && head.ok) {
                    const type = head.headers.get('content-type') || '';
                    // If video type, create video element and play
                    if (/video\//i.test(type) || url.match(/\.(mp4|webm|mov)(\?|$)/i)) {
                        const vid = document.createElement('video');
                        vid.src = url;
                        vid.controls = true;
                        vid.preload = 'metadata';
                        vid.autoplay = autoplayEnabled;
                        clearMediaContainer();
                        mediaContainer.appendChild(vid);
                        vid.play().catch(() => {});
                    } else if (/image\//i.test(type) || url.match(/\.(jpg|jpeg|png|webp)(\?|$)/i)) {
                        const img = document.createElement('img');
                        img.src = url;
                        clearMediaContainer();
                        mediaContainer.appendChild(img);
                    } else {
                        // Fallback open in new tab
                        window.open(url, '_blank');
                    }
                } else {
                    alert('Gagal menghubungi URL. Coba periksa akses publiknya.');
                }
            } catch (err) {
                console.error('Preview failed:', err);
                alert('Preview gagal: ' + (err.message || err));
            }
        };

        saveBtn.onclick = () => {
            const url = (input.value || '').trim();
            if (!url) return alert('Masukkan URL yang valid untuk disimpan');
            saveLocalFallback(basename, url);
            saveBtn.textContent = 'Tersimpan';
            setTimeout(() => saveBtn.textContent = 'Simpan untuk browser ini', 1400);
        };

        openBtn.onclick = (e) => {
            const url = (input.value || '').trim();
            if (!url) {
                e.preventDefault();
                alert('Masukkan URL publik terlebih dahulu');
                return;
            }
            openBtn.href = url;
        };

        clearMediaContainer();
        mediaContainer.appendChild(container);
        scrollToSlideBottom();
    }

    // Filter and sort media based on priority and not-priority lists
    function filterMedia() {
        let filteredFiles;
        
        // Filter berdasarkan not-priority jika diaktifkan
        if (hideNonPriority && notPriorityFiles.length > 0) {
            filteredFiles = allMediaFiles.filter(file => !notPriorityFiles.includes(file));
        } else {
            filteredFiles = [...allMediaFiles];
        }
        
        // Sort: priority files di awal, sisanya di belakang
        if (priorityFiles.length > 0) {
            const priorityFilesInList = filteredFiles.filter(file => priorityFiles.includes(file));
            const nonPriorityFilesInList = filteredFiles.filter(file => !priorityFiles.includes(file));
            
            // Urutkan priority files sesuai urutan di priority.json
            const sortedPriority = priorityFiles.filter(file => priorityFilesInList.includes(file));
            
            mediaFiles = [...sortedPriority, ...nonPriorityFilesInList];
        } else {
            mediaFiles = filteredFiles;
        }
        
        // Reset index if out of bounds
        if (currentIndex >= mediaFiles.length) {
            currentIndex = 0;
        }

        // Drop selections that are no longer visible after filtering/sorting.
        for (const file of Array.from(selectedMediaSet)) {
            if (!mediaFiles.includes(file)) {
                selectedMediaSet.delete(file);
            }
        }
    }
    
    // Toggle non-priority filter
    function toggleNonPriorityFilter() {
        const checkbox = document.getElementById('hideNonPriority');
        hideNonPriority = checkbox.checked;
        filterMedia();
        
        if (currentView === 'slide') {
            showMedia(currentIndex);
        } else {
            populateGridView();
        }
    }
    
    window.toggleNonPriorityFilter = toggleNonPriorityFilter;

    async function showMedia(index) {
        if (mediaFiles.length === 0) return;
        if (!mediaContainer) {
            console.error('Element dengan id "media-container" tidak ditemukan');
            return;
        }
        
        currentIndex = index;
        const file = mediaFiles[index];
        
        // Update active grid item if grid is populated
        updateActiveGridItem();

        const tokenAtRender = ++renderToken;
        clearMediaContainer();
        
        // Show skeleton loader
        mediaContainer.innerHTML = '<div class="skeleton-loader"></div>';
        
        if (filenameDiv) {
            filenameDiv.textContent = `${index + 1}/${mediaFiles.length} - ${file}`;
        }

        if (safeModeEnabled && !isLocalOrSameOriginPath(file)) {
            mediaContainer.innerHTML = '<div style="color:#ffb3b3; padding: 16px;">🛡️ Safe Mode memblokir media eksternal</div>';
            scrollToSlideBottom();
            return;
        }
        
        if (file.match(/\.(jpg|jpeg|png|webp)$/i)) {
            const isPhotoSphere = await detectPhotoSphere(file);
            if (tokenAtRender !== renderToken) return;

            if (isPhotoSphere) {
                if (filenameDiv) {
                    filenameDiv.textContent = `${index + 1}/${mediaFiles.length} - ${file} (360°)`;
                }

                try {
                    await renderPhotoSphere(file, tokenAtRender);
                } catch (err) {
                    console.error('Error rendering PhotoSphere, falling back to image:', err);
                }
                if (tokenAtRender !== renderToken) return;
            }

            if (isPhotoSphere && activePannellumViewer) {
                return;
            }

            const img = document.createElement('img');
            img.src = file;
            img.onload = () => {
                if (tokenAtRender !== renderToken) return;
                mediaContainer.innerHTML = '';
                mediaContainer.appendChild(img);
                scrollToSlideBottom();
                if (autoplayEnabled) {
                    scheduleAutoplay(3000);
                }
            };
            img.onerror = () => {
                if (tokenAtRender !== renderToken) return;
                mediaContainer.innerHTML = '<div style="color:#fff;">Error loading image</div>';
                scrollToSlideBottom();
            };
        } else if (file.match(/\.(mp4|webm|mov)$/i)) {
            const video = document.createElement('video');
            video.src = file;
            video.controls = true;
            // Reduce automatic download: only fetch metadata until user plays or autoplay is active for current item
            video.preload = 'metadata';
            video.playsInline = true;
            video.setAttribute('playsinline', '');
            video.autoplay = false;

            video.onloadedmetadata = () => {
                if (tokenAtRender !== renderToken) return;
                mediaContainer.innerHTML = '';
                mediaContainer.appendChild(video);
                scrollToSlideBottom();
                // Start playback only when autoplay is desired for the active slide
                if (autoplayEnabled) {
                    video.play().catch(() => {});
                }
            };

            video.onerror = async () => {
                if (tokenAtRender !== renderToken) return;
                try {
                    // Try fetching the URL to detect possible Git LFS pointer content
                    const resp = await fetch(file, { cache: 'no-store' });
                    if (resp && resp.ok) {
                        const text = await resp.text();
                        if (/^version https:\/\/git-lfs.github.com\/spec\/v1/m.test(text)) {
                            // Detected LFS pointer. Try to find fallback mapping (from file or basename)
                            if (!lfsFallbacksLoaded) await loadLfsFallbacks();
                            const fallback = getFallbackUrlFor(file);
                            if (fallback) {
                                // Load from fallback URL
                                clearMediaContainer();
                                const vid = document.createElement('video');
                                vid.src = fallback;
                                vid.controls = true;
                                vid.preload = 'metadata';
                                vid.autoplay = autoplayEnabled;
                                mediaContainer.appendChild(vid);
                                vid.addEventListener('loadedmetadata', () => {
                                    if (tokenAtRender !== renderToken) return;
                                    scrollToSlideBottom();
                                    if (autoplayEnabled) vid.play().catch(() => {});
                                }, { once: true });
                                return;
                            }

                            // No fallback known: show UI to paste a direct URL or save a local mapping
                            showLfsFallbackUI(file, text, tokenAtRender);
                            return;
                        }
                    }
                } catch (fetchErr) {
                    console.warn('Error checking video source after error:', fetchErr);
                }

                mediaContainer.innerHTML = '<div style="color:#fff;">Error loading video</div>';
                scrollToSlideBottom();
            };

            video.onended = () => {
                if (autoplayEnabled) {
                    nextMedia();
                }
            };
        } else {
            mediaContainer.innerHTML = '<div style="color:#fff;">Format tidak didukung: ' + file + '</div>';
            scrollToSlideBottom();
        }
    }

    function nextMedia() {
        currentIndex = (currentIndex + 1) % mediaFiles.length;
        showMedia(currentIndex);
    }

    function prevMedia() {
        currentIndex = (currentIndex - 1 + mediaFiles.length) % mediaFiles.length;
        showMedia(currentIndex);
    }
    
    function populateGridView() {
        if (!gridView) return;
        
        gridView.innerHTML = '';
        const frag = document.createDocumentFragment();
        mediaFiles.forEach((file, index) => {
            const gridItem = document.createElement('div');
            gridItem.className = 'grid-item';
            gridItem.dataset.index = index; // Store index for highlighting
            let selectBtn = null;

            if (selectedMediaSet.has(file)) {
                gridItem.classList.add('selected');
            }
            
            // Highlight current item
            if (index === currentIndex) {
                gridItem.classList.add('active');
            }
            
            gridItem.onclick = () => {
                if (gridSelectMode && currentView === 'grid') {
                    toggleGridItemSelection(file, gridItem, selectBtn);
                    return;
                }
                showSlideView();
                showMedia(index);
            };

            selectBtn = document.createElement('button');
            selectBtn.className = 'grid-select';
            selectBtn.title = gridSelectMode ? 'Pilih item' : 'Aktifkan mode pilih';
            selectBtn.textContent = selectedMediaSet.has(file) ? '✅' : '☐';
            selectBtn.style.display = gridSelectMode ? 'flex' : 'none';
            selectBtn.onclick = (e) => {
                e.stopPropagation();
                if (!gridSelectMode) return;
                toggleGridItemSelection(file, gridItem, selectBtn);
            };
            gridItem.appendChild(selectBtn);
            
            if (file.match(/\.(jpg|jpeg|png|webp)$/i)) {
                const canLoadThumb = !safeModeEnabled || isLocalOrSameOriginPath(file);

                if (canLoadThumb) {
                    const img = document.createElement('img');
                    // Use tiny placeholder and defer real src via data-src + IntersectionObserver
                    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
                    img.dataset.src = file;
                    img.loading = 'lazy';
                    img.alt = `Media ${index + 1}`;

                    // Add error handler for broken images
                    img.onerror = () => {
                        img.style.display = 'none';
                        const placeholder = document.createElement('div');
                        placeholder.style.cssText = 'width:100%;height:100%;background:#333;display:flex;align-items:center;justify-content:center;color:#888;font-size:2em;flex-direction:column;';
                        placeholder.innerHTML = '🖼️<div style="font-size:0.3em;margin-top:10px;">Image Error</div>';
                        gridItem.appendChild(placeholder);
                    };

                    gridItem.appendChild(img);

                    // Observe the image for lazy loading and defer expensive PhotoSphere detection
                    try {
                        gridImageObserver.observe(img);
                        sphereObserver.observe(img);
                    } catch (e) {
                        // Fallback: set src immediately if observer fails
                        img.src = file;
                    }
                } else {
                    const blocked = document.createElement('div');
                    blocked.style.cssText = 'position:absolute;width:100%;height:100%;background:#2a2a2a;display:flex;align-items:center;justify-content:center;color:#ffb3b3;font-size:1.2em;padding:10px;box-sizing:border-box;text-align:center;';
                    blocked.textContent = '🛡️ Safe Mode';
                    gridItem.appendChild(blocked);
                }
            } else if (file.match(/\.(mp4|webm)$/i)) {
                // For grid view we avoid creating <video> elements (heavy). Use a lightweight placeholder instead.
                const placeholder = document.createElement('div');
                placeholder.style.cssText = 'position:absolute;width:100%;height:100%;background:#222;display:flex;align-items:center;justify-content:center;color:#fff;font-size:2em;';
                placeholder.innerHTML = '▶️';
                gridItem.style.position = 'relative';
                gridItem.appendChild(placeholder);

                // Optionally show a small file label in the middle-bottom
                const miniLabel = document.createElement('div');
                miniLabel.style.cssText = 'position:absolute;bottom:8px;left:8px;right:8px;color:#ddd;font-size:0.75em;text-align:center;pointer-events:none;';
                miniLabel.textContent = 'Video';
                gridItem.appendChild(miniLabel);

                // We will load the video only when user opens the item (slide view)
            }

            // Add per-item download button (stopPropagation so click opens slide only)
            const dlBtn = document.createElement('button');
            dlBtn.className = 'grid-download';
            dlBtn.title = 'Download';
            dlBtn.innerHTML = '⬇️';
            dlBtn.onclick = (e) => {
                e.stopPropagation();
                downloadFile(file);
            };
            gridItem.appendChild(dlBtn);
            
            const overlay = document.createElement('div');
            overlay.className = 'overlay';
            overlay.textContent = `${index + 1}. ${file.split('/').pop()}`;
            gridItem.appendChild(overlay);
            
            frag.appendChild(gridItem);
        });
        gridView.appendChild(frag);

        updateSelectionControls();

        // Scroll to active item after grid is populated
        scrollToActiveItem();
    }
    
    // Function to scroll to active grid item
    function scrollToActiveItem() {
        if (currentView !== 'grid') return;
        
        setTimeout(() => {
            const activeItem = gridView.querySelector('.grid-item.active');
            if (activeItem) {
                activeItem.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center',
                    inline: 'center'
                });
            }
        }, 100); // Small delay to ensure grid is rendered
    }

    function scrollToSlideBottom() {
        if (currentView !== 'slide') return;

        requestAnimationFrame(() => {
            setTimeout(() => {
                if (currentView !== 'slide') return;
                const doc = document.documentElement;
                const targetTop = Math.max(doc.scrollHeight, document.body.scrollHeight);
                window.scrollTo({
                    top: targetTop,
                    behavior: 'smooth',
                });
            }, 80);
        });
    }
    
    // Update active highlight when navigating in slide view
    function updateActiveGridItem() {
        if (!gridView) return;
        
        // Remove previous active class
        const previousActive = gridView.querySelector('.grid-item.active');
        if (previousActive) {
            previousActive.classList.remove('active');
        }
        
        // Add active class to current item
        const currentItem = gridView.querySelector(`.grid-item[data-index="${currentIndex}"]`);
        if (currentItem) {
            currentItem.classList.add('active');
        }
    }
    
    // View switching functions
    function showSlideView() {
        currentView = 'slide';
        slideContainer.style.display = 'block';
        gridContainer.style.display = 'none';
        
        console.log('showSlideView called');
        console.log('autoWasDisabledInGrid:', autoWasDisabledInGrid);
        console.log('autoplayEnabled:', autoplayEnabled);
        
        // Tampilkan notifikasi kecil jika auto sempat dimatikan di grid view
        if (autoWasDisabledInGrid && !autoplayEnabled) {
            console.log('Conditions met, calling showAutoNotification');
            showAutoNotification();
        }
        
        // Update toggle buttons
        document.querySelectorAll('.toggle-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelector('.toggle-btn').classList.add('active');
        updateSelectionControls();
        scrollToSlideBottom();
    }
    
    function showGridView() {
        currentView = 'grid';
        slideContainer.style.display = 'none';
        gridContainer.style.display = 'block';
        
        console.log('showGridView called');
        
        // Sembunyikan notifikasi jika sedang tampil
        hideAutoNotification();
        
        // Matikan autoplay saat pindah ke grid view
        if (autoplayEnabled) {
            console.log('Disabling autoplay');
            autoplayEnabled = false;
            clearAutoplayTimer();
            autoWasDisabledInGrid = true;
            const btn = document.querySelector('.floating-controls .floating-btn');
            if (btn) btn.textContent = '⏯️ Manual';
        }
        
        populateGridView();
        
        // Scroll to current active item
        scrollToActiveItem();
        
        // Update toggle buttons
        document.querySelectorAll('.toggle-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.toggle-btn')[1].classList.add('active');
        updateSelectionControls();
    }
    
    // Auto notification functions
    function showAutoNotification() {
        console.log('showAutoNotification called');
        if (!autoNotification) return console.error('autoNotification element not found!');

        // Prefer the button that explicitly toggles autoplay (reliable even if layout wraps)
        const autoBtn = document.querySelector('.floating-controls button[onclick*="toggleAutoplay"]') || document.querySelector('.floating-controls .floating-btn');

        // Prepare notification for measurement
        autoNotification.classList.remove('show');
        autoNotification.style.display = 'block';
        autoNotification.style.visibility = 'hidden';
        autoNotification.style.removeProperty('--arrow-right');
        autoNotification.style.removeProperty('--arrow-left');
        autoNotification.style.left = '';
        autoNotification.style.right = '';
        autoNotification.style.top = '';

        if (!autoBtn) {
            // Fallback: show at default position
            autoNotification.style.visibility = 'visible';
            autoNotification.classList.add('show');
            setTimeout(hideAutoNotification, 5000);
            return;
        }

        const btnRect = autoBtn.getBoundingClientRect();
        const notifRect = autoNotification.getBoundingClientRect();
        const notifWidth = notifRect.width || 220;

        // Position notification centered horizontally above/below the button when possible
        let left = Math.round(btnRect.left + (btnRect.width / 2) - (notifWidth / 2));
        left = Math.max(8, Math.min(left, window.innerWidth - notifWidth - 8));
        const top = Math.round(btnRect.bottom + 8);

        autoNotification.style.left = `${left}px`;
        autoNotification.style.top = `${top}px`;
        autoNotification.style.right = 'auto';

        // Compute arrow offset inside the notification box (centered on button center)
        const arrowCenter = (btnRect.left + (btnRect.width / 2)) - left;
        const arrowLeft = Math.max(6, Math.min(notifWidth - 12, Math.round(arrowCenter - 6)));
        autoNotification.style.setProperty('--arrow-left', `${arrowLeft}px`);

        // Reveal with animation
        autoNotification.style.visibility = 'visible';
        // Force reflow
        void autoNotification.offsetWidth;
        autoNotification.classList.add('show');
        // Auto hide after 5 seconds
        setTimeout(hideAutoNotification, 5000);
    }
    
    function hideAutoNotification() {
        if (!autoNotification) return;
        autoNotification.classList.remove('show');
        // Remove inline positioning after animation completes
        setTimeout(() => {
            if (!autoNotification) return;
            autoNotification.style.display = '';
            autoNotification.style.left = '';
            autoNotification.style.top = '';
            autoNotification.style.right = '';
            autoNotification.style.removeProperty('--arrow-left');
            autoNotification.style.removeProperty('--arrow-right');
        }, 320);
    }
    
    function enableAutoFromNotification() {
        autoplayEnabled = true;
        const btn = document.querySelector('.floating-controls .floating-btn');
        if (btn) btn.textContent = '⏸️ Auto';
        hideAutoNotification();
        autoWasDisabledInGrid = false;

        restartAutoplayForCurrentMedia();
    }
    
    // Make notification functions global
    window.enableAutoFromNotification = enableAutoFromNotification;
    
    // Floating controls functions
    function toggleAutoplay() {
        autoplayEnabled = !autoplayEnabled;
        const btn = document.querySelector('.floating-controls .floating-btn');
        btn.textContent = autoplayEnabled ? '⏸️ Auto' : '⏯️ Manual';

        if (!autoplayEnabled) {
            clearAutoplayTimer();
            return;
        }

        restartAutoplayForCurrentMedia();
    }
    
    function toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
        } else {
            document.exitFullscreen();
        }
    }
    
    function shuffleMedia() {
        mediaFiles = mediaFiles.sort(() => Math.random() - 0.5);
        currentIndex = 0;
        if (currentView === 'slide') {
            showMedia(currentIndex);
        } else {
            populateGridView();
        }
    }
    
    // Download helper: create an anchor and click to download the file
    function downloadFile(file) {
        try {
            assertSafePath(file, 'download file');

            const a = document.createElement('a');
            a.href = file;
            // Use last path segment as filename (strip query string)
            const parts = file.split('/');
            let filename = parts.length ? parts[parts.length - 1] : 'media';
            filename = filename.split('?')[0];
            a.download = filename || 'media';
            document.body.appendChild(a);
            a.click();
            a.remove();
        } catch (err) {
            console.error('Error downloading file:', err);
        }
    }

    function downloadCurrentMedia() {
        if (!mediaFiles || mediaFiles.length === 0) return;
        const file = mediaFiles[currentIndex];
        if (file) downloadFile(file);
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1200);
    }

    async function buildAndDownloadZip(filesToBundle, nameSuffix = '') {
        if (!filesToBundle || filesToBundle.length === 0) return;

        const compressionConfig = getBundleCompressionConfig();
        const totalFiles = filesToBundle.length;
        const splitConfig = getBundleSplitConfig(totalFiles);
        let splitActive = splitConfig.shouldSplitImmediately;
        let splitLabel = splitConfig.label;

        if (splitConfig.mode === 'smart' && totalFiles > splitConfig.smartMaxFiles) {
            splitActive = true;
            splitLabel = `Auto Cerdas -> Split ${ZIP_PART_THRESHOLD_MB}MB`;
        }

        setBundleButtonState(true, '📦 Menyiapkan ZIP...');
        updateBundleProgress({
            stage: 'Menyiapkan ZIP',
            detail: 'Memuat engine ZIP browser...',
            percent: 2,
            meta: `Kompresi: ${compressionConfig.label} • Strategi: ${splitLabel}`,
        });

        await ensureJSZipLoaded();

        const suffix = nameSuffix ? `_${nameSuffix}` : '';
        const baseName = sanitizeBundleName(document.title);
        let loadedBytes = 0;
        let totalZipBytes = 0;
        let downloadedPartCount = 0;
        let isMultiPart = false;
        let smartSwitchedToSplit = false;
        const startedAt = Date.now();

        let currentPartFiles = [];
        let currentPartBytes = 0;

        async function flushCurrentPart(forcePartSuffix) {
            if (!currentPartFiles.length) return;

            downloadedPartCount += 1;
            const partIndex = downloadedPartCount;
            const partLabel = forcePartSuffix ? `Part ${partIndex}` : 'ZIP tunggal';

            setBundleButtonState(true, forcePartSuffix ? `📦 Packing ${partLabel}...` : '📦 Packing ZIP...');
            updateBundleProgress({
                stage: forcePartSuffix ? `Menyusun ${partLabel}` : `Menyusun ZIP (${compressionConfig.label})`,
                detail: `Menulis ${currentPartFiles.length} file`,
                percent: 65,
                meta: `${formatBytes(currentPartBytes)} • ${compressionConfig.label} • ${splitLabel}`,
            });

            const zip = new window.JSZip();
            for (let i = 0; i < currentPartFiles.length; i += 1) {
                const item = currentPartFiles[i];
                zip.file(item.name, item.bytes, { binary: true });
            }

            const zipBlob = await zip.generateAsync(
                {
                    type: 'blob',
                    compression: compressionConfig.compression,
                    ...(compressionConfig.compression === 'DEFLATE' ? { compressionOptions: { level: compressionConfig.level } } : {}),
                },
                (meta) => {
                    const internalPercent = Number(meta?.percent || 0);
                    const uiPercent = Math.min(99, 70 + (internalPercent * 0.29));
                    const currentFile = meta?.currentFile
                        ? `Sedang tulis: ${meta.currentFile}`
                        : 'Menyusun central directory...';

                    updateBundleProgress({
                        stage: forcePartSuffix ? `Menyusun ${partLabel}` : `Menyusun ZIP (${compressionConfig.label})`,
                        detail: currentFile,
                        percent: uiPercent,
                        meta: forcePartSuffix
                            ? `${partLabel} • ${internalPercent.toFixed(1)}%`
                            : `Progress internal: ${internalPercent.toFixed(1)}% • ${totalFiles} file • ${compressionConfig.label}`,
                    });
                }
            );

            const partSuffix = forcePartSuffix ? `_part${String(partIndex).padStart(2, '0')}` : '';
            const bundleName = `${baseName}${suffix}${partSuffix}.zip`;
            downloadBlob(zipBlob, bundleName);

            totalZipBytes += zipBlob.size;
            updateBundleProgress({
                stage: forcePartSuffix ? `${partLabel} selesai` : 'Bundle ZIP selesai',
                detail: bundleName,
                percent: forcePartSuffix ? 92 : 100,
                meta: `Ukuran: ${formatBytes(zipBlob.size)} • ${currentPartFiles.length} file`,
            });

            currentPartFiles = [];
            currentPartBytes = 0;
        }

        for (let i = 0; i < filesToBundle.length; i += 1) {
            const file = filesToBundle[i];
            assertSafePath(file, 'bundle file');

            setBundleButtonState(true, `📦 Fetch ${i + 1}/${totalFiles}`);
            updateBundleProgress({
                stage: `Mengambil file ${i + 1}/${totalFiles}`,
                detail: file,
                percent: 5 + (i / totalFiles) * 55,
                meta: `${i + 1}/${totalFiles} file`,
            });

            const res = await fetch(file, { cache: 'no-store' });
            if (!res.ok) {
                throw new Error(`Gagal mengambil file: ${file}`);
            }

            if (splitConfig.mode === 'smart' && !splitActive) {
                const contentLength = Number(res.headers.get('content-length') || 0);
                const projectedBytes = loadedBytes + (contentLength > 0 ? contentLength : 0);
                const shouldSwitchToSplit = (contentLength > 0 && projectedBytes > splitConfig.smartSingleLimitBytes)
                    || totalFiles > splitConfig.smartMaxFiles;

                if (shouldSwitchToSplit) {
                    splitActive = true;
                    smartSwitchedToSplit = true;
                    splitLabel = `Auto Cerdas -> Split ${ZIP_PART_THRESHOLD_MB}MB`;

                    if (currentPartFiles.length > 0) {
                        isMultiPart = true;
                        await flushCurrentPart(true);
                    }
                }
            }

            const fileBuffer = await res.arrayBuffer();
            const bytes = toUint8Array(fileBuffer);

            if (splitConfig.mode === 'smart' && !splitActive) {
                const shouldSwitchToSplitNow = (loadedBytes + bytes.length) > splitConfig.smartSingleLimitBytes
                    || totalFiles > splitConfig.smartMaxFiles;

                if (shouldSwitchToSplitNow) {
                    splitActive = true;
                    smartSwitchedToSplit = true;
                    splitLabel = `Auto Cerdas -> Split ${ZIP_PART_THRESHOLD_MB}MB`;

                    if (currentPartFiles.length > 0) {
                        isMultiPart = true;
                        await flushCurrentPart(true);
                    }
                }
            }

            const nextPartBytes = currentPartBytes + bytes.length;
            if (splitActive && currentPartFiles.length > 0 && nextPartBytes > splitConfig.partThresholdBytes) {
                isMultiPart = true;
                await flushCurrentPart(true);
            }

            currentPartFiles.push({ name: file, bytes });
            currentPartBytes += bytes.length;
            loadedBytes += bytes.length;

            const currentPartNo = downloadedPartCount + 1;

            updateBundleProgress({
                stage: `Buffering ${i + 1}/${totalFiles}`,
                detail: file,
                percent: 5 + ((i + 1) / totalFiles) * 55,
                meta: `${i + 1}/${totalFiles} file • ${formatBytes(loadedBytes)} • ${splitActive ? `Part ${currentPartNo}` : 'Utuh 1 File'} • ${splitLabel}`,
            });
        }

        await flushCurrentPart(isMultiPart || downloadedPartCount > 0);

        const ratio = loadedBytes > 0
            ? ((totalZipBytes / loadedBytes) * 100).toFixed(1)
            : '0.0';
        const totalDurationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
        const finalDetail = downloadedPartCount > 1
            ? `${baseName}${suffix}_partXX.zip`
            : `${baseName}${suffix}.zip`;
        const smartNote = smartSwitchedToSplit ? ' • Auto Cerdas memutuskan split' : '';

        updateBundleProgress({
            stage: downloadedPartCount > 1 ? `Bundle selesai (${downloadedPartCount} part)` : 'Bundle ZIP selesai',
            detail: finalDetail,
            percent: 100,
            meta: `Total: ${formatBytes(totalZipBytes)} • Rasio: ${ratio}% • ${totalDurationSec}s • ${splitLabel}${smartNote}`,
        });

        const doneLabel = downloadedPartCount > 1
            ? `✅ ${downloadedPartCount} Part Terunduh`
            : '✅ ZIP Terunduh';
        setBundleButtonState(false, doneLabel);
        setTimeout(() => setBundleButtonState(false, '📦 Download All (.zip)'), 1800);
        hideBundleProgress(3200);
    }

    // Build bundle on browser side as ZIP (STORE) for maximum compatibility and speed
    async function downloadAll() {
        if (!mediaFiles || mediaFiles.length === 0) return;

        try {
            await buildAndDownloadZip(mediaFiles, '');
        } catch (err) {
            console.error('Error creating browser ZIP bundle:', err);
            alert(`Gagal membuat ZIP: ${err.message}`);
            updateBundleProgress({
                stage: 'Gagal membuat ZIP',
                detail: err.message || 'Terjadi kesalahan',
                percent: 0,
                meta: 'Periksa console untuk detail.',
            });
            setBundleButtonState(false, '📦 Download All (.zip)');
        }
    }

    async function downloadSelected() {
        const selectedFiles = getSelectedFilesInCurrentOrder();
        if (!selectedFiles.length) {
            alert('Belum ada media yang dipilih di Grid View.');
            return;
        }

        try {
            await buildAndDownloadZip(selectedFiles, 'selected');
        } catch (err) {
            console.error('Error creating selected ZIP bundle:', err);
            alert(`Gagal membuat ZIP selected: ${err.message}`);
            setBundleButtonState(false, '📦 Download All (.zip)');
        }
    }

    
    // Make functions global so they can be called from HTML
    window.showSlideView = showSlideView;
    window.showGridView = showGridView;
    window.toggleAutoplay = toggleAutoplay;
    window.toggleFullscreen = toggleFullscreen;
    window.shuffleMedia = shuffleMedia;
    window.toggleGridSelectMode = toggleGridSelectMode;
    window.downloadSelected = downloadSelected;
    window.downloadCurrentMedia = downloadCurrentMedia;
    window.downloadAll = downloadAll;

    // Event handlers
    if (prevBtn) {
        prevBtn.onclick = prevMedia;
    }
    if (nextBtn) {
        nextBtn.onclick = nextMedia;
    }
    
    // Keyboard controls
    document.addEventListener('keydown', (e) => {
        if (currentView === 'slide') {
            switch(e.key) {
                case 'ArrowLeft':
                    prevMedia();
                    break;
                case 'ArrowRight':
                case ' ':
                    e.preventDefault();
                    nextMedia();
                    break;
                case 'f':
                    toggleFullscreen();
                    break;
                case 'g':
                    showGridView();
                    break;
                case 's':
                    showSlideView();
                    break;
            }
        } else if (currentView === 'grid' && e.key === 's') {
            showSlideView();
        }
    });

    window.addEventListener('beforeunload', () => {
        clearAutoplayTimer();
        if (bundleProgressHideTimer) {
            clearTimeout(bundleProgressHideTimer);
            bundleProgressHideTimer = null;
        }
        if (gridImageObserver) {
            gridImageObserver.disconnect();
        }
        if (activePannellumViewer) {
            try {
                activePannellumViewer.destroy();
            } catch (err) {
                console.warn('Failed to dispose PhotoSphere viewer on unload:', err);
            }
            activePannellumViewer = null;
        }
    });

    // Ambil media.json dan mulai
    Promise.all([
        fetch('media.json').then(res => res.json()),
        fetch('not-priority.json').then(res => res.json()).catch(() => []),
        fetch('priority.json').then(res => res.json()).catch(() => [])
    ])
    .then(([media, notPriority, priority]) => {
        allMediaFiles = media;
        notPriorityFiles = notPriority;
        priorityFiles = priority;
        filterMedia();
        
        if (mediaContainer) {
            showMedia(currentIndex);
            populateGridView(); // Pre-populate grid for faster switching
            updateSelectionControls();
            requestWakeLock(); // Request wake lock to keep screen awake
        } else {
            console.error('HTML tidak memiliki element dengan id "media-container"');
        }
    })
    .catch(error => {
        console.error('Error loading media files:', error);
    });
} else {
    // Halaman ini bukan media player, skip script ini
    console.log('Script media player tidak dijalankan - bukan halaman media player');
}
