const CACHE='monthly-expense-v7-0-6-auto-vat';
const SHELL_KEY='/__monthly_expense_app_shell__';
const STATIC_CORE=['/manifest.webmanifest','/icon-192.png','/icon-512.png','/icon-maskable-512.png','/apple-touch-icon.png'];
const PATCH_VERSION='7.0.6';

function isSameOrigin(url){return url.origin===self.location.origin}

function patchAppHtml(html){
  if(!html||typeof html!=='string')return html;

  html=html
    .replace(/data-version="7\.0\.5"/g,'data-version="7.0.6"')
    .replace("const APP_VERSION='7.0.5';","const APP_VERSION='7.0.6';")
    .replace("const CURRENT_APP_VERSION='7.0.5';","const CURRENT_APP_VERSION='7.0.6';")
    .replace("versionFooter:'الإصدار 7.0.5 — إصلاح استجابة الأزرار + مزامنة تلقائية'","versionFooter:'الإصدار 7.0.6 — حساب ضريبة 5% تلقائيًا من المبلغ قبل الضريبة'")
    .replace("versionFooter:'Version 7.0.5 — button stability + automatic account sync'","versionFooter:'Version 7.0.6 — automatic 5% VAT from subtotal'")
    .replace('الإصدار 7.0.5 — إصلاح استجابة الأزرار + مزامنة تلقائية','الإصدار 7.0.6 — حساب ضريبة 5% تلقائيًا من المبلغ قبل الضريبة')
    .replace("if(v&&v!==CURRENT_APP_VERSION)show(null,v)","if(v&&String(v).localeCompare(String(CURRENT_APP_VERSION),undefined,{numeric:true,sensitivity:'base'})>0)show(null,v)")
    .replace("'أدخل المبلغ قبل الضريبة والضريبة ليُحسب الإجمالي تلقائيًا.'","'أدخل المبلغ قبل الضريبة وستُحسب الضريبة 5% والإجمالي النهائي تلقائيًا.'")
    .replace("'Enter the subtotal and tax to calculate the final total automatically.'","'Enter the subtotal and the 5% VAT and final total will be calculated automatically.'");

  const changelogNeedle='const CHANGELOG_ENTRIES=[';
  if(html.includes(changelogNeedle)&&!html.includes("{version:'7.0.6'")){
    html=html.replace(changelogNeedle,`${changelogNeedle}\n  {version:'7.0.6',ar:'حساب ضريبة القيمة المضافة 5% تلقائيًا فور إدخال المبلغ قبل الضريبة، مع تحديث الإجمالي النهائي مباشرة وإبقاء الضريبة قابلة للتعديل اليدوي عند الحاجة.',en:'Automatically calculates 5% VAT as soon as the subtotal is entered, updates the final total immediately, and keeps the tax field manually editable when needed.'},`)
  }

  if(!html.includes('id="monthlyExpenseAutoVat706"')){
    const autoVatScript=`
<script id="monthlyExpenseAutoVat706">
(()=>{
  const VAT_RATE=0.05;
  function bindAutoVat(){
    const subtotal=document.getElementById('subtotal');
    const tax=document.getElementById('tax');
    const total=document.getElementById('finalTotal');
    if(!subtotal||!tax||!total||subtotal.dataset.autoVat706==='1')return;
    subtotal.dataset.autoVat706='1';
    subtotal.addEventListener('input',()=>{
      const raw=String(subtotal.value??'').trim();
      if(raw===''){
        tax.value='';
        total.value='';
        try{calcTotals()}catch(_){}
        try{scheduleDraftSave()}catch(_){}
        return;
      }
      const base=Math.max(0,Number(raw)||0);
      const vat=Math.round((base*VAT_RATE+Number.EPSILON)*100)/100;
      tax.value=vat.toFixed(2);
      total.value=(Math.round(((base+vat)+Number.EPSILON)*100)/100).toFixed(2);
      try{syncFinalTotalFromInputs()}catch(_){}
      try{calcTotals()}catch(_){}
      try{scheduleDraftSave()}catch(_){}
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bindAutoVat,{once:true});else bindAutoVat();
})();
<\/script>`;
    html=html.replace(/<\/body>/i,`${autoVatScript}\n</body>`)
  }

  return html
}

async function normalizedResponse(res){
  const headers=new Headers(res.headers);
  const contentType=headers.get('content-type')||'';
  let body;
  if(/text\/html/i.test(contentType)){
    const html=await res.text();
    body=new TextEncoder().encode(patchAppHtml(html));
  }else{
    body=await res.arrayBuffer();
  }
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('location');
  headers.set('cache-control','no-store');
  return new Response(body,{status:200,statusText:'OK',headers});
}

async function fetchFreshShell(){
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
        port?.postMessage({ok:true,version:PATCH_VERSION})
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
  if(isSameOrigin(u)&&u.pathname.startsWith('/api/'))return;
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
