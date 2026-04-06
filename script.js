
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
    
    const mediaContainer = document.getElementById('media-container');
    const filenameDiv = document.getElementById('filename');
    const prevBtn = document.getElementById('prev');
    const nextBtn = document.getElementById('next');
    const slideContainer = document.getElementById('slide-container');
    const gridContainer = document.getElementById('grid-container');
    const gridView = document.getElementById('grid-view');
    const autoNotification = document.getElementById('auto-notification');

    // IntersectionObserver for lazy-loading grid images
    const gridObserverOptions = { root: null, rootMargin: '300px', threshold: 0.01 };
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
    
    console.log('Elements loaded:');
    console.log('- slideContainer:', slideContainer);
    console.log('- gridContainer:', gridContainer);
    console.log('- autoNotification:', autoNotification);

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

    function showMedia(index) {
        if (mediaFiles.length === 0) return;
        if (!mediaContainer) {
            console.error('Element dengan id "media-container" tidak ditemukan');
            return;
        }
        
        currentIndex = index;
        const file = mediaFiles[index];
        
        // Update active grid item if grid is populated
        updateActiveGridItem();
        
        // Show skeleton loader
        mediaContainer.innerHTML = '<div class="skeleton-loader"></div>';
        
        if (filenameDiv) {
            filenameDiv.textContent = `${index + 1}/${mediaFiles.length} - ${file}`;
        }
        
        if (file.match(/\.(jpg|jpeg|png|webp)$/i)) {
            const img = document.createElement('img');
            img.src = file;
            img.onload = () => {
                mediaContainer.innerHTML = '';
                mediaContainer.appendChild(img);
                if (autoplayEnabled) {
                    setTimeout(nextMedia, 3000);
                }
            };
            img.onerror = () => {
                mediaContainer.innerHTML = '<div style="color:#fff;">Error loading image</div>';
            };
        } else if (file.match(/\.(mp4|webm|mov)$/i)) {
            const video = document.createElement('video');
            video.src = file;
            video.controls = true;
            video.autoplay = autoplayEnabled;
            video.onloadeddata = () => {
                mediaContainer.innerHTML = '';
                mediaContainer.appendChild(video);
            };
            video.onerror = () => {
                mediaContainer.innerHTML = '<div style="color:#fff;">Error loading video</div>';
            };
            video.onended = () => {
                if (autoplayEnabled) {
                    nextMedia();
                }
            };
        } else {
            mediaContainer.innerHTML = '<div style="color:#fff;">Format tidak didukung: ' + file + '</div>';
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
            
            // Highlight current item
            if (index === currentIndex) {
                gridItem.classList.add('active');
            }
            
            gridItem.onclick = () => {
                showSlideView();
                showMedia(index);
            };
            
            if (file.match(/\.(jpg|jpeg|png|webp)$/i)) {
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

                // Observe the image for lazy loading
                try {
                    gridImageObserver.observe(img);
                } catch (e) {
                    // Fallback: set src immediately if observer fails
                    img.src = file;
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
    }
    
    // Auto notification functions
    function showAutoNotification() {
        console.log('showAutoNotification called');
        console.log('autoNotification element:', autoNotification);
        if (autoNotification) {
            autoNotification.classList.add('show');
            console.log('Notification shown');
            // Auto hide after 5 seconds
            setTimeout(() => {
                hideAutoNotification();
            }, 5000);
        } else {
            console.error('autoNotification element not found!');
        }
    }
    
    function hideAutoNotification() {
        if (autoNotification) {
            autoNotification.classList.remove('show');
        }
    }
    
    function enableAutoFromNotification() {
        autoplayEnabled = true;
        const btn = document.querySelector('.floating-controls .floating-btn');
        if (btn) btn.textContent = '⏸️ Auto';
        hideAutoNotification();
        autoWasDisabledInGrid = false;
        
        // Start autoplay immediately if viewing an image
        const currentMedia = mediaContainer.querySelector('img');
        if (currentMedia) {
            setTimeout(nextMedia, 3000);
        }
    }
    
    // Make notification functions global
    window.enableAutoFromNotification = enableAutoFromNotification;
    
    // Floating controls functions
    function toggleAutoplay() {
        autoplayEnabled = !autoplayEnabled;
        const btn = document.querySelector('.floating-controls .floating-btn');
        btn.textContent = autoplayEnabled ? '⏸️ Auto' : '⏯️ Manual';
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

    // Download all media files sequentially with a small delay to reduce browser blocking
    function downloadAll() {
        if (!mediaFiles || mediaFiles.length === 0) return;
        // Use a small interval between downloads to avoid some browser restrictions
        const delay = 250; // ms
        mediaFiles.forEach((file, idx) => {
            setTimeout(() => {
                downloadFile(file);
            }, idx * delay);
        });
    }

    
    // Make functions global so they can be called from HTML
    window.showSlideView = showSlideView;
    window.showGridView = showGridView;
    window.toggleAutoplay = toggleAutoplay;
    window.toggleFullscreen = toggleFullscreen;
    window.shuffleMedia = shuffleMedia;
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
