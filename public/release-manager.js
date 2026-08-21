(()=>{
  'use strict';
  const APP_VERSION=String(window.__APP_RELEASE_VERSION__||'7.1.0');
  const API='/api/update';
  let lastStatus=null, ws=null, reconnectTimer=null, updateBanner=null, ownerBanner=null, notifBtn=null;

  const $=s=>document.querySelector(s);
  function semverCmp(a,b){
    const aa=String(a||'0').split('.').map(n=>Number(n)||0),bb=String(b||'0').split('.').map(n=>Number(n)||0);
    for(let i=0;i<Math.max(aa.length,bb.length);i++){const x=aa[i]||0,y=bb[i]||0;if(x!==y)return x>y?1:-1}
    return 0
  }
  function appFetch(path,opts={}){
    const headers=new Headers(opts.headers||{});headers.set('x-monthly-expense-app','1');
    return fetch(path,{credentials:'include',cache:'no-store',...opts,headers})
  }
  function toast(msg){
    try{if(typeof window.toast==='function'){window.toast(msg);return}}catch(_){}
    let el=document.getElementById('releaseToast');
    if(!el){el=document.createElement('div');el.id='releaseToast';Object.assign(el.style,{position:'fixed',left:'50%',bottom:'24px',transform:'translateX(-50%)',background:'#17324d',color:'#fff',padding:'11px 16px',borderRadius:'12px',zIndex:'100000',fontWeight:'800',boxShadow:'0 10px 30px rgba(0,0,0,.22)',maxWidth:'90vw',textAlign:'center'});document.body.appendChild(el)}
    el.textContent=msg;el.style.display='block';clearTimeout(el._t);el._t=setTimeout(()=>el.style.display='none',3200)
  }
  function ensureStyles(){
    if(document.getElementById('releaseManagerStyles'))return;
    const s=document.createElement('style');s.id='releaseManagerStyles';s.textContent=`
      .release-gate-banner{position:sticky;top:8px;z-index:9990;margin:10px auto 14px;max-width:1180px;border-radius:18px;padding:13px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;box-shadow:0 12px 30px rgba(20,40,60,.14);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Tahoma,Arial,sans-serif}
      .release-gate-banner.owner{background:#fff3d8;border:1px solid #e7c97e;color:#5d4512}.release-gate-banner.user{background:#eaf3fb;border:1px solid #b8d4ea;color:#17324d}
      .release-gate-copy{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}.release-gate-copy strong{font-size:14px}.release-gate-copy small{font-size:11px;opacity:.78;line-height:1.55}
      .release-gate-actions{display:flex;gap:8px;flex-wrap:wrap}.release-gate-actions button{border:0;border-radius:12px;padding:9px 12px;font:inherit;font-weight:900;cursor:pointer}.release-primary{background:#17324d;color:#fff}.release-soft{background:rgba(255,255,255,.72);color:inherit;border:1px solid rgba(0,0,0,.08)!important}
      .release-notif-btn{border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.12);color:#fff;border-radius:12px;padding:9px 11px;font-weight:850;cursor:pointer;white-space:nowrap}.release-notif-btn.on{background:#dff1e7;color:#23664f;border-color:#b9ddca}.release-notif-btn.off{background:#f4e6e3;color:#8c3d37;border-color:#e7c7c3}
      @media(max-width:600px){.release-gate-banner{margin:8px 10px 12px}.release-gate-actions{width:100%}.release-gate-actions button{flex:1}}
    `;document.head.appendChild(s)
  }
  function mountBanner(kind,version,notes){
    ensureStyles();
    if(kind==='owner'){
      if(ownerBanner)ownerBanner.remove();
      const el=document.createElement('div');el.className='release-gate-banner owner';
      el.innerHTML=`<div class="release-gate-copy"><strong>🧪 نسخة تجريبية للمالك فقط — الإصدار ${escapeHtml(version)}</strong><small>${escapeHtml(notes||'جرّب جميع الوظائف. لن يصل هذا الإصدار للمستخدمين قبل اعتمادك.')}</small></div><div class="release-gate-actions"><button class="release-soft" data-act="keep">إبقاء قيد التجربة</button><button class="release-primary" data-act="approve">اعتماد وإرسال للمستخدمين</button></div>`;
      document.body.prepend(el);ownerBanner=el;
      el.querySelector('[data-act="keep"]').onclick=()=>toast('سيبقى الإصدار متاحًا لك فقط حتى تقوم باعتماده.');
      el.querySelector('[data-act="approve"]').onclick=async()=>{
        if(!confirm(`اعتماد الإصدار ${version} وإرساله لجميع المستخدمين الآن؟`))return;
        const btn=el.querySelector('[data-act="approve"]');btn.disabled=true;btn.textContent='جارٍ الاعتماد…';
        try{
          const r=await appFetch(`${API}/approve`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});const j=await r.json().catch(()=>({}));
          if(!r.ok||!j.ok)throw new Error(j.error||`HTTP ${r.status}`);
          toast(`تم اعتماد الإصدار ${j.version||version}. تم إرسال إشعار التحديث للمستخدمين.`);
          el.remove();ownerBanner=null;lastStatus=null;setTimeout(checkStatus,500)
        }catch(e){toast(`تعذر الاعتماد: ${e.message||e}`);btn.disabled=false;btn.textContent='اعتماد وإرسال للمستخدمين'}
      };
      return
    }
    if(updateBanner)updateBanner.remove();
    const el=document.createElement('div');el.className='release-gate-banner user';
    el.innerHTML=`<div class="release-gate-copy"><strong>⬆️ تحديث جديد متوفر — الإصدار ${escapeHtml(version)}</strong><small>${escapeHtml(notes||'تم اعتماد هذا الإصدار من مالك التطبيق. يمكنك أخذ نسخة احتياطية ثم التحديث.')}</small></div><div class="release-gate-actions"><button class="release-soft" data-act="backup">نسخة احتياطية</button><button class="release-primary" data-act="update">تحديث الآن</button></div>`;
    document.body.prepend(el);updateBanner=el;
    el.querySelector('[data-act="backup"]').onclick=()=>{const b=document.getElementById('backupBtn');if(b)b.click();else toast('استخدم زر النسخة الاحتياطية من أعلى الصفحة.')};
    el.querySelector('[data-act="update"]').onclick=()=>applyUpdate(version,el.querySelector('[data-act="update"]'))
  }
  function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}

  async function waitForWorker(reg,timeout=20000){
    if(reg.waiting)return reg.waiting;
    return new Promise(resolve=>{
      let done=false;const finish=w=>{if(done)return;done=true;clearTimeout(t);resolve(w||null)};const t=setTimeout(()=>finish(null),timeout);
      const watch=w=>{if(!w)return;w.addEventListener('statechange',()=>{if(w.state==='installed')finish(w)})};
      if(reg.installing)watch(reg.installing);
      reg.addEventListener('updatefound',()=>watch(reg.installing),{once:true})
    })
  }
  async function applyUpdate(version,btn){
    if(btn){btn.disabled=true;btn.textContent='جارٍ التحديث…'}
    try{
      if(!('serviceWorker' in navigator)){location.reload();return}
      let reg=await navigator.serviceWorker.getRegistration('/');
      if(!reg)reg=await navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'});
      await reg.update();
      const worker=await waitForWorker(reg);
      const target=reg.waiting||worker;
      if(target){
        let reloaded=false;
        navigator.serviceWorker.addEventListener('controllerchange',()=>{if(!reloaded){reloaded=true;location.reload()}},{once:true});
        target.postMessage({type:'SKIP_WAITING'});
        setTimeout(()=>{if(!reloaded)location.reload()},5000)
      }else location.reload()
    }catch(e){toast(`تعذر التحديث: ${e.message||e}`);if(btn){btn.disabled=false;btn.textContent='تحديث الآن'}}
  }

  function isStandalone(){return window.matchMedia?.('(display-mode: standalone)').matches===true||window.navigator.standalone===true}
  function isIOS(){return /iphone|ipad|ipod/i.test(navigator.userAgent||'')}
  function b64ToBytes(v){const s=String(v||'').replace(/-/g,'+').replace(/_/g,'/');const pad='='.repeat((4-s.length%4)%4);const raw=atob(s+pad);return Uint8Array.from(raw,c=>c.charCodeAt(0))}
  async function pushSupported(){return 'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window}
  async function ensurePushSubscription(interactive=false){
    if(!(await pushSupported())){if(interactive)toast('هذا الجهاز أو المتصفح لا يدعم إشعارات الويب.');return false}
    if(isIOS()&&!isStandalone()){
      if(interactive)alert('على iPhone يجب أولًا إضافة الموقع إلى الشاشة الرئيسية، ثم فتحه كتطبيق والضغط على زر تفعيل الإشعارات.');
      return false
    }
    let permission=Notification.permission;
    if(permission==='default'&&interactive)permission=await Notification.requestPermission();
    if(permission!=='granted'){if(interactive)toast(permission==='denied'?'الإشعارات محظورة من إعدادات الجهاز.':'لم يتم السماح بالإشعارات.');return false}
    try{
      let reg=await navigator.serviceWorker.getRegistration('/');
      if(!reg)reg=await navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'});
      const keyRes=await fetch(`${API}/push-key`,{cache:'no-store',credentials:'include'});const keyJson=await keyRes.json();
      if(!keyRes.ok||!keyJson.publicKey)throw new Error('PUSH_KEY_UNAVAILABLE');
      let sub=await reg.pushManager.getSubscription();
      if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64ToBytes(keyJson.publicKey)});
      const r=await appFetch(`${API}/subscribe`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({subscription:sub.toJSON()})});
      if(!r.ok)throw new Error(`HTTP ${r.status}`);
      if(interactive)toast('تم تفعيل إشعارات التحديث خارج التطبيق.');paintNotificationButton();return true
    }catch(e){console.warn('Push subscription failed',e);if(interactive)toast('تعذر تفعيل الإشعارات على هذا الجهاز.');return false}
  }
  async function paintNotificationButton(){
    if(!notifBtn)return;
    if(!(await pushSupported())){notifBtn.textContent='🔕 الإشعارات غير مدعومة';notifBtn.className='release-notif-btn off';notifBtn.disabled=true;return}
    const p=Notification.permission;
    if(p==='granted'){notifBtn.textContent='🔔 إشعارات التحديث مفعلة';notifBtn.className='release-notif-btn on'}
    else if(p==='denied'){notifBtn.textContent='🔕 الإشعارات محظورة';notifBtn.className='release-notif-btn off'}
    else{notifBtn.textContent='🔔 تفعيل إشعارات التحديث';notifBtn.className='release-notif-btn'}
  }
  function mountNotificationButton(){
    ensureStyles();
    const host=document.querySelector('.hero-actions')||document.querySelector('.hero')||document.body;
    if(document.getElementById('releaseNotificationBtn'))return;
    const b=document.createElement('button');b.type='button';b.id='releaseNotificationBtn';b.className='release-notif-btn';b.onclick=()=>ensurePushSubscription(true);host.appendChild(b);notifBtn=b;paintNotificationButton();
    if('Notification' in window&&Notification.permission==='granted')ensurePushSubscription(false)
  }

  function installAutoVat5(){
    const bind=()=>{
      const subtotal=document.getElementById('subtotal'),tax=document.getElementById('tax'),total=document.getElementById('finalTotal');
      if(!subtotal||!tax||!total||subtotal.dataset.autoVat710==='1')return;
      subtotal.dataset.autoVat710='1';
      subtotal.addEventListener('input',()=>{
        const raw=String(subtotal.value??'').trim();
        if(raw===''){tax.value='';total.value='';try{window.calcTotals?.()}catch(_){};try{window.scheduleDraftSave?.()}catch(_){};return}
        const base=Math.max(0,Number(raw)||0),vat=Math.round((base*.05+Number.EPSILON)*100)/100;
        tax.value=vat.toFixed(2);total.value=(Math.round(((base+vat)+Number.EPSILON)*100)/100).toFixed(2);
        try{window.syncFinalTotalFromInputs?.()}catch(_){};try{window.calcTotals?.()}catch(_){};try{window.scheduleDraftSave?.()}catch(_){}
      })
    };
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind()
  }

  async function checkStatus(){
    try{
      const r=await fetch(`${API}/status?current=${encodeURIComponent(APP_VERSION)}`,{cache:'no-store',credentials:'include'});const s=await r.json();
      if(!r.ok||!s.ok)return;lastStatus=s;
      if(s.channel==='owner_testing'&&s.candidateVersion===APP_VERSION){
        mountBanner('owner',s.candidateVersion,s.candidateNotes?.ar||'');
      }else if(semverCmp(s.availableVersion,APP_VERSION)>0){
        mountBanner('user',s.availableVersion,s.candidateNotes?.ar||'تم اعتماد هذا التحديث من المالك.');
      }else{
        if(updateBanner){updateBanner.remove();updateBanner=null}
        if(ownerBanner&&s.channel!=='owner_testing'){ownerBanner.remove();ownerBanner=null}
      }
    }catch(e){console.warn('Release status check failed',e)}
  }
  function connectUpdateSocket(){
    clearTimeout(reconnectTimer);
    if(ws){try{ws.close()}catch(_){};ws=null}
    if(!navigator.onLine)return;
    try{
      const proto=location.protocol==='https:'?'wss:':'ws:';ws=new WebSocket(`${proto}//${location.host}/api/update/ws`);
      ws.onopen=()=>{try{ws.send('ping')}catch(_){}};
      ws.onmessage=e=>{
        if(e.data==='pong')return;
        try{const m=JSON.parse(e.data);if(m.type==='release-approved'&&semverCmp(m.version,APP_VERSION)>0)mountBanner('user',m.version,m.notes?.ar||'تم اعتماد التحديث من المالك.')}catch(_){}
      };
      ws.onclose=()=>{ws=null;reconnectTimer=setTimeout(connectUpdateSocket,4000)};
      ws.onerror=()=>{try{ws.close()}catch(_){}}
    }catch(_){reconnectTimer=setTimeout(connectUpdateSocket,5000)}
  }

  function boot(){
    installAutoVat5();mountNotificationButton();checkStatus();connectUpdateSocket();
    setInterval(checkStatus,60000);
    window.addEventListener('online',()=>{checkStatus();connectUpdateSocket()});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkStatus()});
    navigator.serviceWorker?.addEventListener?.('message',e=>{if(e.data?.type==='OPEN_UPDATE')checkStatus()})
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
