const CACHE='monthly-expense-v7-0-5-button-stability';
const SHELL_KEY='/__monthly_expense_app_shell__';
const STATIC_CORE=['/manifest.webmanifest','/icon-192.png','/icon-512.png','/icon-maskable-512.png','/apple-touch-icon.png'];

function isSameOrigin(url){return url.origin===self.location.origin}

async function normalizedResponse(res){
  // Safari rejects a Response returned by a Service Worker when that Response
  // still carries redirect history (Response.redirected === true). Rebuild the
  // response from bytes so the cached/navigation response is redirect-free.
  const body=await res.arrayBuffer();
  const headers=new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('location');
  headers.set('cache-control','no-store');
  return new Response(body,{status:200,statusText:'OK',headers});
}

async function fetchFreshShell(){
  // Fetch the canonical root rather than /index.html because some hosts redirect
  // /index.html -> /. Any redirect that still occurs is removed by normalizedResponse.
  const res=await fetch(`/?__app_shell=${Date.now()}`,{cache:'no-store',redirect:'follow'});
  if(!res.ok)throw new Error(`Shell HTTP ${res.status}`);
  return normalizedResponse(res)
}

async function refreshShell(cache){
  const clean=await fetchFreshShell();
  await cache.put(SHELL_KEY,clean.clone());
  return clean
}

async function cacheStatic(cache){
  for(const path of STATIC_CORE){
    try{
      const res=await fetch(`${path}${path.includes('?')?'&':'?'}__static=${Date.now()}`,{cache:'no-store',redirect:'follow'});
      if(res.ok)await cache.put(path,res.clone())
    }catch(_){ }
  }
}

self.addEventListener('install',e=>{
  // Manual-update policy: do not activate automatically. The currently installed
  // app remains in control until the user explicitly chooses "Update now".
  e.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    await Promise.allSettled([refreshShell(cache),cacheStatic(cache)])
  })())
});

self.addEventListener('message',e=>{
  if(e.data&&e.data.type==='SKIP_WAITING'){self.skipWaiting();return}
  if(e.data&&e.data.type==='REFRESH_APP_SHELL'){
    const port=e.ports&&e.ports[0];
    e.waitUntil((async()=>{
      try{
        const cache=await caches.open(CACHE);
        await refreshShell(cache);
        await cacheStatic(cache);
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
  const r=e.request;if(r.method!=='GET')return;
  const u=new URL(r.url);

  // Always-live routes.
  if(isSameOrigin(u)&&u.pathname.startsWith('/api/'))return;
  // Update/version checks and emergency recovery must bypass the Service Worker.
  if(isSameOrigin(u)&&(u.searchParams.has('__update_check')||u.searchParams.has('__sw_recovery')))return;

  const cacheable=isSameOrigin(u);
  if(!cacheable)return;

  const isNav=r.mode==='navigate'||(isSameOrigin(u)&&(u.pathname==='/'||u.pathname==='/index.html'));
  if(isNav){
    e.respondWith((async()=>{
      const cache=await caches.open(CACHE);
      let shell=await cache.match(SHELL_KEY);
      if(shell)return shell;
      try{
        shell=await refreshShell(cache);
        return shell
      }catch(err){
        // Last-resort network navigation; normalize it too so Safari never receives
        // a redirect-bearing Response from this Service Worker.
        const res=await fetch(r,{cache:'no-store',redirect:'follow'});
        return normalizedResponse(res)
      }
    })());
    return
  }

  e.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    const hit=await cache.match(r);if(hit)return hit;
    try{
      const res=await fetch(r);
      if(res.ok||res.type==='opaque')cache.put(r,res.clone()).catch(()=>{});
      return res
    }catch(err){
      if(hit)return hit;
      throw err
    }
  })())
});
