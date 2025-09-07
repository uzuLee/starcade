
const CACHE = 'lux-games-v1'
const ASSETS = [
  '/', '/index.html', '/favicon.svg'
]

self.addEventListener('install', (e)=>{
  e.waitUntil(caches.open(CACHE).then(c=> c.addAll(ASSETS)).then(()=> self.skipWaiting()))
})
self.addEventListener('activate', (e)=>{
  e.waitUntil(caches.keys().then(keys=> Promise.all(keys.map(k=> k===CACHE? null : caches.delete(k)))).then(()=> self.clients.claim()))
})
self.addEventListener('fetch', (e)=>{
  const url = new URL(e.request.url)
  if(url.origin===location.origin){
    e.respondWith(caches.match(e.request).then(res=> res || fetch(e.request).then(r=>{
      const copy = r.clone(); caches.open(CACHE).then(c=> c.put(e.request, copy)); return r
    })))
  }
})
