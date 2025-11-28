const CACHE_NAME = 'clover-media-v1';

// Install Event
self.addEventListener('install', (event) => {
    self.skipWaiting(); // Activate worker immediately
});

// Activate Event
self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim()); // Become available to all pages
});

// Fetch Event
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // We only want to cache the media files from Hugging Face
    // These files are immutable (unique IDs), so we can use a "Cache First" strategy.
    if (url.hostname === 'huggingface.co' && url.pathname.includes('/resolve/')) {
        event.respondWith(
            caches.open(CACHE_NAME).then(async (cache) => {
                // 1. Try to find it in the cache
                const cachedResponse = await cache.match(event.request);
                if (cachedResponse) {
                    return cachedResponse;
                }

                // 2. If not in cache, fetch from network
                try {
                    const networkResponse = await fetch(event.request);
                    
                    // 3. Save to cache for next time
                    // Note: We cache opaque responses (no-cors) as well if necessary
                    cache.put(event.request, networkResponse.clone());
                    
                    return networkResponse;
                } catch (error) {
                    // Network failed
                    console.error('Fetch failed for media:', error);
                    throw error;
                }
            })
        );
    }
});