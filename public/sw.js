const CACHE='monthly-expense-v5-8-0-manual-update';
const CORE=['/','/index.html','/manifest.webmanifest','/icon-192.png','/icon-512.png','/icon-maskable-512.png','/apple-touch-icon.png'];

self.addEventListener('install',e=>{
  // Deliberately DO NOT skipWaiting. The current app remains active until the user
  // explicitly presses "Update now" after having the opportunity to save a backup.
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).catch(()=>{}))
});

self.addEventListener('message',e=>{
  if(e.data&&e.data.type==='SKIP_WAITING'){self.skipWaiting();return}
  if(e.data&&e.data.type==='REFRESH_APP_SHELL'){
    const port=e.ports&&e.ports[0];
    e.waitUntil((async()=>{
      try{
        const c=await caches.open(CACHE);
        for(const path of CORE){
          const res=await fetch(`${path}${path.includes('?')?'&':'?'}__shell_refresh=${Date.now()}`,{cache:'no-store'});
          if(res.ok)await c.put(path,res.clone())
        }
        port?.postMessage({ok:true})
      }catch(err){port?.postMessage({ok:false,error:String(err?.message||err)})}
    })())
  }
});

self.addEventListener('activate',e=>{
  e.waitUntil(Promise.all([
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('monthly-expense-v')&&k!==CACHE).map(k=>caches.delete(k)))),
    self.clients.claim()
  ]))
});

self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);
  // API responses (OCR, sync, evidence, health) are always live and never cached.
  if(u.origin===self.location.origin&&u.pathname.startsWith('/api/'))return;
  // The page polls the network copy of index.html only to detect a new app version.
  if(u.origin===self.location.origin&&u.searchParams.has('__update_check'))return;

  const cacheable=u.origin===self.location.origin||/cdn\.jsdelivr\.net$|unpkg\.com$|esm\.sh$|huggingface\.co$|paddle-model-ecology\.bj\.bcebos\.com$|tessdata\.projectnaptha\.com$/.test(u.hostname);
  if(!cacheable)return;

  const isNav=r.mode==='navigate'||(u.origin===self.location.origin&&(u.pathname==='/'||u.pathname==='/index.html'));
  if(isNav){
    // App shell is cache-first on purpose. A newly deployed HTML file cannot silently
    // replace the user's current version while the new service worker is waiting.
    e.respondWith(caches.open(CACHE).then(async c=>{
      const shell=await c.match('/index.html')||await c.match('/');
      if(shell)return shell;
      return fetch(r,{cache:'no-store'})
    }));return
  }

  e.respondWith(caches.open(CACHE).then(async c=>{
    const hit=await c.match(r);if(hit)return hit;
    try{const res=await fetch(r);if(res.ok||res.type==='opaque')c.put(r,res.clone()).catch(()=>{});return res}
    catch(err){if(hit)return hit;throw err}
  }))
});
