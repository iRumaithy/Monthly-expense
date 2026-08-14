const CACHE='monthly-expense-v5.0.1-ocr';
const CORE=['/','/index.html'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).catch(()=>{}));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('monthly-expense-v')&&k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url),cacheable=u.origin===self.location.origin||/cdn\.jsdelivr\.net$|esm\.sh$|paddle-model-ecology\.bj\.bcebos\.com$/.test(u.hostname);if(!cacheable)return;
  e.respondWith(caches.open(CACHE).then(async c=>{const hit=await c.match(r);if(hit)return hit;try{const res=await fetch(r);if(res.ok||res.type==='opaque')c.put(r,res.clone()).catch(()=>{});return res}catch(err){if(hit)return hit;throw err}}))
});