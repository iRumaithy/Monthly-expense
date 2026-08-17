import { DurableObject } from "cloudflare:workers";

const VERSION='7.0.3';

function syncHeaders(extra={}){return {'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra}}
function json(body,status=200,extra={}){return new Response(JSON.stringify(body),{status,headers:syncHeaders(extra)})}
function normalizeRoomCode(v){return String(v||'').toUpperCase().replace(/[^A-Z2-9]/g,'').slice(0,12)}
function formatRoomCode(v){const s=normalizeRoomCode(v);return (s.match(/.{1,4}/g)||[s]).join('-')}
function newRoomCode(){const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',bytes=new Uint8Array(12);crypto.getRandomValues(bytes);return [...bytes].map(b=>alphabet[b%alphabet.length]).join('')}
function roomStub(env,code){const c=normalizeRoomCode(code);if(c.length!==12)throw new Error('Invalid sync code');return env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(c))}
function accountRoomStub(env,accountId){const id=String(accountId||'').replace(/[^A-Za-z0-9_-]/g,'');if(!id)throw new Error('Invalid account');return env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(`account:${id}`))}
function authDirectoryStub(env){return env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName('__monthly_expense_auth_v700__'))}
function isoGreater(a,b){return String(a||'')>String(b||'')}

// === v7.0.0 Optional account authentication ===
const AUTH_COOKIE='me_session';
// Long-lived first-party session. Normal refresh/reopen does not sign the user out.
const AUTH_SESSION_MAX_AGE=315360000; // 10 years
const AUTH_SESSION_MS=AUTH_SESSION_MAX_AGE*1000;
const AUTH_PBKDF2_ITERATIONS=100000;

function authJson(body,status=200,extra={}){return json(body,status,extra)}
function authB64(bytes){let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function authUnb64(s){s=String(s||'').replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';const raw=atob(s),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out}
function authRandomToken(n=32){const b=new Uint8Array(n);crypto.getRandomValues(b);return authB64(b)}
async function authSha256(v){const b=new TextEncoder().encode(String(v||'')),d=await crypto.subtle.digest('SHA-256',b);return authB64(new Uint8Array(d))}
async function authPasswordHash(password,salt,pepper='',iterations=AUTH_PBKDF2_ITERATIONS){
  const enc=new TextEncoder(),rounds=Math.max(10000,Math.min(100000,Math.round(Number(iterations)||AUTH_PBKDF2_ITERATIONS)));
  const base=await crypto.subtle.importKey('raw',enc.encode(String(password||'')+'\0'+String(pepper||'')),{name:'PBKDF2'},false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:authUnb64(salt),iterations:rounds},base,256);
  return authB64(new Uint8Array(bits))
}
function authSafeEqual(a,b){
  const aa=new TextEncoder().encode(String(a||'')),bb=new TextEncoder().encode(String(b||''));
  if(crypto.subtle?.timingSafeEqual){try{if(aa.length!==bb.length){crypto.subtle.timingSafeEqual(aa,aa);return false}return crypto.subtle.timingSafeEqual(aa,bb)}catch(e){}}
  if(aa.length!==bb.length)return false;let x=0;for(let i=0;i<aa.length;i++)x|=aa[i]^bb[i];return x===0
}
function authNormUsername(v){return String(v||'').trim().toLowerCase()}
function authNormEmail(v){return String(v||'').trim().toLowerCase()}
function authValidUsername(v){return /^[a-zA-Z0-9._-]{3,32}$/.test(String(v||''))}
function authValidEmail(v){return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v||''))&&String(v||'').length<=160}
function authValidPassword(v){const s=String(v||'');return s.length>=10&&s.length<=200&&/[A-Za-z\u0600-\u06FF]/.test(s)&&/\d/.test(s)}
function authCookie(token,maxAge=AUTH_SESSION_MAX_AGE){return `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`}
function authClearCookie(){return `${AUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`}
function authCookieToken(request){const c=request.headers.get('cookie')||'',m=c.match(new RegExp('(?:^|;\\s*)'+AUTH_COOKIE+'=([^;]+)'));return m?decodeURIComponent(m[1]):''}
function authMutationAllowed(request){const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)return false;return request.headers.get('x-monthly-expense-app')==='1'}
async function authInternal(env,path,body={}){
  const r=await authDirectoryStub(env).fetch(new Request(`https://auth${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
  let j=null;try{j=await r.json()}catch(e){}
  return{response:r,body:j}
}
async function ensureAccountRoom(env,accountId){if(!accountId)return;await accountRoomStub(env,accountId).fetch(new Request('https://room/room/create',{method:'POST'}))}
async function authRequire(request,env,{write=false,admin=false,owner=false}={}){
  const token=authCookieToken(request);if(!token)return{ok:false,response:authJson({ok:false,error:'AUTH_REQUIRED'},401)};
  const {body}=await authInternal(env,'/auth/session',{token});
  if(!body?.ok)return{ok:false,response:authJson({ok:false,error:'AUTH_REQUIRED'},401,{'set-cookie':authClearCookie()})};
  const session=body.session,user=body.user;
  if(admin&&user?.role!=='super_admin')return{ok:false,response:authJson({ok:false,error:'FORBIDDEN'},403)};
  if(owner&&session?.access!=='owner')return{ok:false,response:authJson({ok:false,error:'OWNER_REQUIRED'},403)};
  if(write&&(session?.access==='viewer'||user?.mustChangePassword))return{ok:false,response:authJson({ok:false,error:user?.mustChangePassword?'PASSWORD_CHANGE_REQUIRED':'READ_ONLY'},403)};
  return{ok:true,token,session,user,refreshCookie:!!body.refreshCookie}
}
function authWithCookie(response,token){const h=new Headers(response.headers);h.append('set-cookie',authCookie(token));return new Response(response.body,{status:response.status,statusText:response.statusText,headers:h})}

async function handleAuthRequest(request,env,url){
  const p=url.pathname;
  if(!env.OWNER_BOOTSTRAP_TOKEN&&p==='/api/auth/bootstrap-owner')return authJson({ok:false,error:'OWNER_BOOTSTRAP_TOKEN_NOT_CONFIGURED'},503);
  if(!env.AUTH_PEPPER&&['/api/auth/bootstrap-owner','/api/auth/register','/api/auth/login','/api/auth/change-password'].includes(p))return authJson({ok:false,error:'AUTH_PEPPER_NOT_CONFIGURED'},503);
  if(p==='/api/auth/status'&&request.method==='GET'){const {body}=await authInternal(env,'/auth/status');return authJson({ok:true,...(body||{}),config:{ownerBootstrapConfigured:!!env.OWNER_BOOTSTRAP_TOKEN,authPepperConfigured:!!env.AUTH_PEPPER}})}
  if(p==='/api/auth/me'&&request.method==='GET'){
    const token=authCookieToken(request);
    if(!token){const {body}=await authInternal(env,'/auth/status');return authJson({ok:true,authenticated:false,...(body||{})})}
    const {body}=await authInternal(env,'/auth/session',{token});
    if(!body?.ok)return authJson({ok:true,authenticated:false},200,{'set-cookie':authClearCookie()});
    const res=authJson({ok:true,authenticated:true,user:body.user,session:body.session,bootstrapRequired:false});
    return body.refreshCookie?authWithCookie(res,token):res
  }
  if(['/api/auth/register','/api/auth/login','/api/auth/bootstrap-owner','/api/auth/forgot','/api/auth/link-device'].includes(p)&&request.method==='POST'){
    if(!authMutationAllowed(request))return authJson({ok:false,error:'BAD_REQUEST_ORIGIN'},403);
    const b=await request.json().catch(()=>({}));let path='';
    if(p==='/api/auth/register')path='/auth/register';
    if(p==='/api/auth/login')path='/auth/login';
    if(p==='/api/auth/forgot')path='/auth/forgot';
    if(p==='/api/auth/link-device')path='/auth/invite/redeem';
    if(p==='/api/auth/bootstrap-owner'){
      const expected=String(env.OWNER_BOOTSTRAP_TOKEN||''),provided=String(b.bootstrapToken||'');
      if(!expected||!authSafeEqual(expected,provided))return authJson({ok:false,error:'INVALID_BOOTSTRAP_TOKEN'},403);
      path='/auth/register';b.superAdmin=true;b.bootstrapAllowed=true
    }
    const {response,body}=await authInternal(env,path,{...b,pepper:String(env.AUTH_PEPPER||''),ip:request.headers.get('cf-connecting-ip')||''});
    if(!response.ok||!body?.ok)return authJson(body||{ok:false,error:'AUTH_FAILED'},response.status||400);
    // Account data room is created lazily on the first /api/account/* request.
    // Do not make login/bootstrap depend on a second Durable Object call.
    if(body.token){const out=authJson({...body,token:undefined});return authWithCookie(out,body.token)}
    return authJson(body)
  }
  if(p==='/api/auth/logout'&&request.method==='POST'){
    if(!authMutationAllowed(request))return authJson({ok:false,error:'BAD_REQUEST_ORIGIN'},403);
    const token=authCookieToken(request);if(token)await authInternal(env,'/auth/logout',{token});
    return authJson({ok:true},200,{'set-cookie':authClearCookie()})
  }
  if(p==='/api/auth/change-password'&&request.method==='POST'){
    if(!authMutationAllowed(request))return authJson({ok:false,error:'BAD_REQUEST_ORIGIN'},403);
    const token=authCookieToken(request);if(!token)return authJson({ok:false,error:'AUTH_REQUIRED'},401);
    const b=await request.json().catch(()=>({}));
    const {response,body}=await authInternal(env,'/auth/change-password',{token,currentPassword:b.currentPassword,newPassword:b.newPassword,pepper:String(env.AUTH_PEPPER||'')});
    return authJson(body||{ok:false},response.status)
  }
  return authJson({ok:false,error:'NOT_FOUND'},404)
}

async function handleAdminRequest(request,env,url){
  if(!authMutationAllowed(request)&&request.method!=='GET')return authJson({ok:false,error:'BAD_REQUEST_ORIGIN'},403);
  if(url.pathname==='/api/admin/reset-password'&&!env.AUTH_PEPPER)return authJson({ok:false,error:'AUTH_PEPPER_NOT_CONFIGURED'},503);
  const a=await authRequire(request,env,{admin:true});if(!a.ok)return a.response;const p=url.pathname;
  if(p==='/api/admin/users'&&request.method==='GET'){const {response,body}=await authInternal(env,'/auth/admin/users',{token:a.token});return authJson(body||{ok:false},response.status)}
  if(p==='/api/admin/reset-password'&&request.method==='POST'){const b=await request.json().catch(()=>({}));const {response,body}=await authInternal(env,'/auth/admin/reset',{token:a.token,userId:b.userId,pepper:String(env.AUTH_PEPPER||'')});return authJson(body||{ok:false},response.status)}
  if(p==='/api/admin/user-status'&&request.method==='POST'){const b=await request.json().catch(()=>({}));const {response,body}=await authInternal(env,'/auth/admin/status',{token:a.token,userId:b.userId,status:b.status});return authJson(body||{ok:false},response.status)}
  if(p==='/api/admin/logout-user'&&request.method==='POST'){const b=await request.json().catch(()=>({}));const {response,body}=await authInternal(env,'/auth/admin/logout-user',{token:a.token,userId:b.userId});return authJson(body||{ok:false},response.status)}
  return authJson({ok:false,error:'NOT_FOUND'},404)
}

async function handleAccountRequest(request,env,url){
  const p=url.pathname;
  if(p==='/api/account/invite'&&request.method==='POST'){
    if(!authMutationAllowed(request))return authJson({ok:false,error:'BAD_REQUEST_ORIGIN'},403);
    const a=await authRequire(request,env,{owner:true});if(!a.ok)return a.response;
    const b=await request.json().catch(()=>({}));const {response,body}=await authInternal(env,'/auth/invite/create',{token:a.token,permission:b.permission,deviceLabel:b.deviceLabel});return authJson(body||{ok:false},response.status)
  }
  if(p==='/api/account/devices'&&request.method==='GET'){
    const a=await authRequire(request,env,{owner:true});if(!a.ok)return a.response;
    const {response,body}=await authInternal(env,'/auth/devices',{token:a.token});return authJson(body||{ok:false},response.status)
  }
  if(p==='/api/account/revoke-device'&&request.method==='POST'){
    if(!authMutationAllowed(request))return authJson({ok:false,error:'BAD_REQUEST_ORIGIN'},403);
    const a=await authRequire(request,env,{owner:true});if(!a.ok)return a.response;
    const b=await request.json().catch(()=>({}));const {response,body}=await authInternal(env,'/auth/device/revoke',{token:a.token,sessionId:b.sessionId});return authJson(body||{ok:false},response.status)
  }
  const isWs=request.headers.get('upgrade')?.toLowerCase()==='websocket';
  const write=request.method!=='GET'&&!isWs;
  const a=await authRequire(request,env,{write});if(!a.ok)return a.response;
  const stub=accountRoomStub(env,a.session.accountId);await ensureAccountRoom(env,a.session.accountId);
  if(p==='/api/account/state'&&request.method==='GET')return stub.fetch(new Request('https://room/room/state',{method:'GET',headers:request.headers}));
  if(p==='/api/account/op'&&request.method==='POST'){const body=await request.text();return stub.fetch(new Request('https://room/room/op',{method:'POST',headers:request.headers,body}))}
  if(p.startsWith('/api/account/evidence/')){const id=p.slice('/api/account/evidence/'.length),init={method:request.method,headers:request.headers};if(request.method==='PUT')init.body=await request.arrayBuffer();return stub.fetch(new Request(`https://room/room/evidence/${encodeURIComponent(id)}`,init))}
  if(p==='/api/account/ws'&&isWs)return stub.fetch(new Request('https://room/room/ws',request));
  return authJson({ok:false,error:'NOT_FOUND'},404)
}

export class SyncRoom extends DurableObject{
  constructor(ctx,env){super(ctx,env);this.env=env}
  async meta(){return await this.ctx.storage.get('meta')}

  // Auth directory methods. These keys exist only inside the fixed auth-directory instance.
  async authAudit(type,details={}){try{const key=`auth:audit:${new Date().toISOString()}:${crypto.randomUUID()}`;await this.ctx.storage.put(key,{type,at:new Date().toISOString(),...details})}catch(e){}}
  async authGetSession(token,{touch=true}={}){
    if(!token)return null;const hash=await authSha256(token),key=`auth:session:${hash}`,s=await this.ctx.storage.get(key);if(!s||s.revokedAt||Number(s.expiresAt||0)<Date.now())return null;
    let user=null;if(s.userId){user=await this.ctx.storage.get(`auth:user:${s.userId}`);if(!user||user.status!=='active')return null}
    let refreshCookie=false;if(touch&&Date.now()-Number(s.lastSeenAt||0)>30*86400000){s.lastSeenAt=Date.now();s.expiresAt=Date.now()+AUTH_SESSION_MS;await this.ctx.storage.put(key,s);refreshCookie=true}
    return{hash,key,session:s,user,refreshCookie}
  }
  async authCreateSession({user=null,accountId,access='owner',kind='user',deviceLabel=''}){
    const token=authRandomToken(32),hash=await authSha256(token),id=crypto.randomUUID(),now=Date.now(),s={id,userId:user?.id||null,accountId,access,kind,deviceLabel:String(deviceLabel||'').slice(0,80),createdAt:now,lastSeenAt:now,expiresAt:now+AUTH_SESSION_MS};
    await this.ctx.storage.put(`auth:session:${hash}`,s);await this.ctx.storage.put(`auth:session-id:${id}`,hash);return{token,session:s}
  }
  async authRevokeSessionRecord(s,hash){if(!s)return;await this.ctx.storage.delete([`auth:session:${hash}`,`auth:session-id:${s.id}`])}
  async authRevokeUserSessions(userId){const user=await this.ctx.storage.get(`auth:user:${userId}`),all=await this.ctx.storage.list({prefix:'auth:session:'}),keys=[];for(const [k,s] of all.entries())if(s?.userId===userId||(user?.accountId&&s?.accountId===user.accountId)){keys.push(k,`auth:session-id:${s.id}`)}if(keys.length)await this.ctx.storage.delete(keys)}
  async authPublicUser(u){return u?{id:u.id,username:u.username,email:u.email,role:u.role,status:u.status,accountId:u.accountId,access:'owner',mustChangePassword:!!u.mustChangePassword,createdAt:u.createdAt,lastLoginAt:u.lastLoginAt||null}:null}
  async authFetch(request,u){
    const p=u.pathname,b=await request.json().catch(()=>({})),pepper=String(b.pepper||this.env?.AUTH_PEPPER||'');
    if(p==='/auth/status'){const meta=await this.ctx.storage.get('auth:meta'),users=await this.ctx.storage.list({prefix:'auth:user:'});return authJson({ok:true,ownerReady:!!meta?.ownerUserId,userCount:users.size,bootstrapRequired:!meta?.ownerUserId})}
    if(p==='/auth/register'){
      const meta=(await this.ctx.storage.get('auth:meta'))||{},superAdmin=!!b.superAdmin;
      if(superAdmin&&meta.ownerUserId)return authJson({ok:false,error:'OWNER_ALREADY_EXISTS'},409);
      if(superAdmin&&!b.bootstrapAllowed)return authJson({ok:false,error:'BOOTSTRAP_REQUIRED'},403);
      if(!superAdmin&&!meta.ownerUserId)return authJson({ok:false,error:'OWNER_SETUP_REQUIRED'},409);
      const username=String(b.username||'').trim(),un=authNormUsername(username),email=String(b.email||'').trim(),em=authNormEmail(email),password=String(b.password||'');
      if(!authValidUsername(username))return authJson({ok:false,error:'INVALID_USERNAME'},400);
      if(!authValidEmail(email))return authJson({ok:false,error:'INVALID_EMAIL'},400);
      if(!authValidPassword(password))return authJson({ok:false,error:'WEAK_PASSWORD'},400);
      if(await this.ctx.storage.get(`auth:username:${un}`))return authJson({ok:false,error:'USERNAME_EXISTS'},409);
      if(await this.ctx.storage.get(`auth:email:${em}`))return authJson({ok:false,error:'EMAIL_EXISTS'},409);
      const id=crypto.randomUUID(),accountId=crypto.randomUUID(),salt=authRandomToken(18),passwordHash=await authPasswordHash(password,salt,pepper),now=Date.now();
      const user={id,username,email,emailNormalized:em,usernameNormalized:un,role:superAdmin?'super_admin':'user',status:'active',accountId,passwordSalt:salt,passwordHash,passwordIterations:AUTH_PBKDF2_ITERATIONS,mustChangePassword:false,createdAt:now,lastLoginAt:now};
      // Keep auth directory writes deterministic on both SQLite- and legacy-backed Durable Objects.
      await this.ctx.storage.put(`auth:user:${id}`,user);
      await this.ctx.storage.put(`auth:username:${un}`,id);
      await this.ctx.storage.put(`auth:email:${em}`,id);
      if(superAdmin){meta.ownerUserId=id;meta.createdAt=meta.createdAt||now;await this.ctx.storage.put('auth:meta',meta)}
      const created=await this.authCreateSession({user,accountId,access:'owner',kind:'user',deviceLabel:b.deviceLabel});
      await this.authAudit(superAdmin?'owner-bootstrap':'register',{userId:id});
      return authJson({ok:true,token:created.token,user:await this.authPublicUser(user),session:created.session,accountId})
    }
    if(p==='/auth/login'){
      const login=String(b.login||'').trim(),idx=login.includes('@')?`auth:email:${authNormEmail(login)}`:`auth:username:${authNormUsername(login)}`,id=await this.ctx.storage.get(idx);
      if(!id)return authJson({ok:false,error:'INVALID_CREDENTIALS'},401);
      const user=await this.ctx.storage.get(`auth:user:${id}`);
      if(!user||user.status!=='active')return authJson({ok:false,error:user?.status==='suspended'?'ACCOUNT_SUSPENDED':'INVALID_CREDENTIALS'},403);
      if(user.lockUntil&&user.lockUntil>Date.now())return authJson({ok:false,error:'TRY_LATER'},429);
      const h=await authPasswordHash(String(b.password||''),user.passwordSalt,pepper,user.passwordIterations||AUTH_PBKDF2_ITERATIONS);
      if(!authSafeEqual(h,user.passwordHash)){
        user.failedLoginCount=Number(user.failedLoginCount||0)+1;
        if(user.failedLoginCount>=8){user.lockUntil=Date.now()+15*60*1000;user.failedLoginCount=0}
        await this.ctx.storage.put(`auth:user:${id}`,user);return authJson({ok:false,error:'INVALID_CREDENTIALS'},401)
      }
      user.failedLoginCount=0;user.lockUntil=0;user.lastLoginAt=Date.now();await this.ctx.storage.put(`auth:user:${id}`,user);
      const created=await this.authCreateSession({user,accountId:user.accountId,access:'owner',kind:'user',deviceLabel:b.deviceLabel});await this.authAudit('login',{userId:id});
      return authJson({ok:true,token:created.token,user:await this.authPublicUser(user),session:created.session,accountId:user.accountId})
    }
    if(p==='/auth/session'){const found=await this.authGetSession(String(b.token||''));if(!found)return authJson({ok:false,error:'AUTH_REQUIRED'},401);return authJson({ok:true,session:found.session,user:await this.authPublicUser(found.user),refreshCookie:found.refreshCookie})}
    if(p==='/auth/logout'){const found=await this.authGetSession(String(b.token||''),{touch:false});if(found)await this.authRevokeSessionRecord(found.session,found.hash);return authJson({ok:true})}
    if(p==='/auth/change-password'){
      const found=await this.authGetSession(String(b.token||''));if(!found?.user)return authJson({ok:false,error:'AUTH_REQUIRED'},401);
      if(!authValidPassword(b.newPassword))return authJson({ok:false,error:'WEAK_PASSWORD'},400);
      const old=await authPasswordHash(String(b.currentPassword||''),found.user.passwordSalt,pepper,found.user.passwordIterations||AUTH_PBKDF2_ITERATIONS);if(!authSafeEqual(old,found.user.passwordHash))return authJson({ok:false,error:'INVALID_CREDENTIALS'},401);
      const salt=authRandomToken(18);found.user.passwordSalt=salt;found.user.passwordHash=await authPasswordHash(String(b.newPassword),salt,pepper,AUTH_PBKDF2_ITERATIONS);found.user.passwordIterations=AUTH_PBKDF2_ITERATIONS;found.user.mustChangePassword=false;
      await this.ctx.storage.put(`auth:user:${found.user.id}`,found.user);await this.authAudit('password-change',{userId:found.user.id});return authJson({ok:true})
    }
    if(p==='/auth/forgot'){
      const login=String(b.login||'').trim(),idx=login.includes('@')?`auth:email:${authNormEmail(login)}`:`auth:username:${authNormUsername(login)}`,id=await this.ctx.storage.get(idx);
      if(id){await this.ctx.storage.put(`auth:reset:${id}`,{userId:id,requestedAt:Date.now(),ip:String(b.ip||'').slice(0,80)});await this.authAudit('reset-request',{userId:id})}
      return authJson({ok:true})
    }
    if(p==='/auth/invite/create'){
      const found=await this.authGetSession(String(b.token||''));if(!found||found.session.access!=='owner'||found.session.kind!=='user')return authJson({ok:false,error:'OWNER_REQUIRED'},403);
      const permission=b.permission==='editor'?'editor':'viewer',code=authRandomToken(9).replace(/[-_]/g,'A').slice(0,10).toUpperCase(),expiresAt=Date.now()+15*60*1000;
      await this.ctx.storage.put(`auth:invite:${code}`,{code,accountId:found.session.accountId,permission,createdBy:found.user?.id||null,createdAt:Date.now(),expiresAt,usedAt:null});
      return authJson({ok:true,code,permission,expiresAt})
    }
    if(p==='/auth/invite/redeem'){
      const code=String(b.code||'').toUpperCase().replace(/[^A-Z0-9]/g,''),key=`auth:invite:${code}`,inv=await this.ctx.storage.get(key);
      if(!inv||inv.usedAt||inv.expiresAt<Date.now())return authJson({ok:false,error:'INVALID_LINK_CODE'},404);
      inv.usedAt=Date.now();await this.ctx.storage.put(key,inv);
      const created=await this.authCreateSession({accountId:inv.accountId,access:inv.permission,kind:'device',deviceLabel:b.deviceLabel});await this.authAudit('device-link',{accountId:inv.accountId,permission:inv.permission});
      return authJson({ok:true,token:created.token,session:created.session,accountId:inv.accountId,user:null})
    }
    if(p==='/auth/devices'){
      const found=await this.authGetSession(String(b.token||''));if(!found||found.session.access!=='owner')return authJson({ok:false,error:'OWNER_REQUIRED'},403);
      const all=await this.ctx.storage.list({prefix:'auth:session:'}),devices=[];
      for(const s of all.values())if(s?.accountId===found.session.accountId&&s.expiresAt>Date.now())devices.push({id:s.id,kind:s.kind,access:s.access,deviceLabel:s.deviceLabel||'',createdAt:s.createdAt,lastSeenAt:s.lastSeenAt,current:s.id===found.session.id});
      devices.sort((a,b)=>b.lastSeenAt-a.lastSeenAt);return authJson({ok:true,devices})
    }
    if(p==='/auth/device/revoke'){
      const found=await this.authGetSession(String(b.token||''));if(!found||found.session.access!=='owner')return authJson({ok:false,error:'OWNER_REQUIRED'},403);
      const hash=await this.ctx.storage.get(`auth:session-id:${String(b.sessionId||'')}`),s=hash?await this.ctx.storage.get(`auth:session:${hash}`):null;
      if(!s||s.accountId!==found.session.accountId)return authJson({ok:false,error:'NOT_FOUND'},404);
      if(s.id===found.session.id)return authJson({ok:false,error:'CANNOT_REVOKE_CURRENT'},400);
      await this.authRevokeSessionRecord(s,hash);await this.authAudit('device-revoke',{accountId:s.accountId,sessionId:s.id});return authJson({ok:true})
    }
    const adminFound=await this.authGetSession(String(b.token||''));if(p.startsWith('/auth/admin/')&&adminFound?.user?.role!=='super_admin')return authJson({ok:false,error:'FORBIDDEN'},403);
    if(p==='/auth/admin/users'){
      const users=[...((await this.ctx.storage.list({prefix:'auth:user:'})).values())],sessions=[...((await this.ctx.storage.list({prefix:'auth:session:'})).values())],resets=await this.ctx.storage.list({prefix:'auth:reset:'});const out=[];
      for(const u0 of users){const devices=sessions.filter(s=>s.accountId===u0.accountId&&s.expiresAt>Date.now()).map(s=>({id:s.id,kind:s.kind,access:s.access,deviceLabel:s.deviceLabel||'',lastSeenAt:s.lastSeenAt,createdAt:s.createdAt})).sort((a,b)=>b.lastSeenAt-a.lastSeenAt);out.push({...await this.authPublicUser(u0),activeSessions:devices.length,devices,resetRequested:resets.has(`auth:reset:${u0.id}`)})}
      out.sort((a,b)=>Number(b.createdAt)-Number(a.createdAt));return authJson({ok:true,users:out,count:out.length})
    }
    if(p==='/auth/admin/reset'){
      const id=String(b.userId||''),user=await this.ctx.storage.get(`auth:user:${id}`);if(!user)return authJson({ok:false,error:'NOT_FOUND'},404);
      const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#',bytes=new Uint8Array(14);crypto.getRandomValues(bytes);const temporaryPassword=`T9!${[...bytes].map(x=>alphabet[x%alphabet.length]).join('')}`;
      const salt=authRandomToken(18);user.passwordSalt=salt;user.passwordHash=await authPasswordHash(temporaryPassword,salt,pepper,AUTH_PBKDF2_ITERATIONS);user.passwordIterations=AUTH_PBKDF2_ITERATIONS;user.mustChangePassword=true;user.failedLoginCount=0;user.lockUntil=0;
      await this.ctx.storage.put(`auth:user:${id}`,user);await this.ctx.storage.delete(`auth:reset:${id}`);await this.authRevokeUserSessions(id);await this.authAudit('admin-reset',{userId:id,adminId:adminFound.user.id});
      return authJson({ok:true,temporaryPassword})
    }
    if(p==='/auth/admin/status'){
      const id=String(b.userId||''),user=await this.ctx.storage.get(`auth:user:${id}`);if(!user)return authJson({ok:false,error:'NOT_FOUND'},404);
      if(user.role==='super_admin'&&b.status!=='active')return authJson({ok:false,error:'CANNOT_SUSPEND_OWNER'},400);
      user.status=b.status==='suspended'?'suspended':'active';await this.ctx.storage.put(`auth:user:${id}`,user);if(user.status==='suspended')await this.authRevokeUserSessions(id);await this.authAudit('admin-status',{userId:id,status:user.status,adminId:adminFound.user.id});return authJson({ok:true,status:user.status})
    }
    if(p==='/auth/admin/logout-user'){
      const id=String(b.userId||''),user=await this.ctx.storage.get(`auth:user:${id}`);if(!user)return authJson({ok:false,error:'NOT_FOUND'},404);
      if(user.role==='super_admin'&&id===adminFound.user.id)return authJson({ok:false,error:'CANNOT_REVOKE_CURRENT'},400);
      await this.authRevokeUserSessions(id);await this.authAudit('admin-logout-all',{userId:id,adminId:adminFound.user.id});return authJson({ok:true})
    }
    return authJson({ok:false,error:'NOT_FOUND'},404)
  }

  broadcast(msg,except=null){const text=JSON.stringify(msg);for(const ws of this.ctx.getWebSockets()){if(ws===except)continue;try{ws.send(text)}catch(e){}}}
  async fetch(request){
    const u=new URL(request.url),p=u.pathname;
    if(p.startsWith('/auth/')){try{return await this.authFetch(request,u)}catch(e){console.error('Auth directory error',p,e);return authJson({ok:false,error:'AUTH_RUNTIME_ERROR',detail:String(e?.message||e||'Unknown auth runtime error').slice(0,220),phase:p},500)}}
    if(p==='/room/create'&&request.method==='POST'){
      let m=await this.meta();if(!m){m={createdAt:new Date().toISOString()};await this.ctx.storage.put('meta',m)}return json({ok:true,...m})
    }
    const m=await this.meta();if(!m)return json({ok:false,error:'Sync group not found'},404);
    if(p==='/room/info')return json({ok:true,createdAt:m.createdAt});
    if(p==='/room/state'&&request.method==='GET'){
      const [rr,dd,bb,ee]=await Promise.all([this.ctx.storage.list({prefix:'receipt:'}),this.ctx.storage.list({prefix:'deleted:'}),this.ctx.storage.list({prefix:'budget:'}),this.ctx.storage.list({prefix:'evidence-meta:'})]);
      return json({ok:true,receipts:[...rr.values()],deleted:[...dd.values()],budgets:[...bb.entries()].map(([k,v])=>({month:k.slice(7),...v})),evidence:[...ee.entries()].map(([k,v])=>({id:k.slice(14),...v}))})
    }
    if(p==='/room/op'&&request.method==='POST'){
      const b=await request.json(),clientId=String(b.clientId||''),now=new Date().toISOString();
      if(b.type==='upsert'&&b.receipt?.id){const r=b.receipt,id=String(r.id),old=await this.ctx.storage.get(`receipt:${id}`),del=await this.ctx.storage.get(`deleted:${id}`);if((!old||isoGreater(r.updatedAt,old.updatedAt))&&(!del||isoGreater(r.updatedAt,del.updatedAt))){await this.ctx.storage.put(`receipt:${id}`,r);await this.ctx.storage.delete(`deleted:${id}`);this.broadcast({type:'upsert',receipt:r,clientId})}}
      else if(b.type==='delete'&&b.id){const id=String(b.id),ts=String(b.updatedAt||now),old=await this.ctx.storage.get(`receipt:${id}`),del=await this.ctx.storage.get(`deleted:${id}`);if((!old||!isoGreater(old.updatedAt,ts))&&(!del||isoGreater(ts,del.updatedAt))){await this.ctx.storage.delete([`receipt:${id}`,`evidence:${id}`,`evidence-meta:${id}`]);await this.ctx.storage.put(`deleted:${id}`,{id,updatedAt:ts});this.broadcast({type:'delete',id,updatedAt:ts,clientId})}}
      else if(b.type==='budget'&&/^\d{4}-\d{2}$/.test(String(b.month||''))){const month=String(b.month),v={value:Number(b.value)||0,updatedAt:String(b.updatedAt||now)},old=await this.ctx.storage.get(`budget:${month}`);if(!old||isoGreater(v.updatedAt,old.updatedAt)){await this.ctx.storage.put(`budget:${month}`,v);this.broadcast({type:'budget',month,...v,clientId})}}
      return json({ok:true})
    }
    if(p.startsWith('/room/evidence/')){
      const id=decodeURIComponent(p.slice('/room/evidence/'.length)).replace(/[^A-Za-z0-9_-]/g,'').slice(0,80);if(!id)return new Response('Bad id',{status:400});
      if(request.method==='PUT'){
        const buf=await request.arrayBuffer();if(buf.byteLength>1900000)return json({ok:false,error:'Evidence image too large'},413);
        const type=request.headers.get('content-type')||'image/jpeg',updatedAt=new Date().toISOString();
        await this.ctx.storage.put(`evidence:${id}`,buf);await this.ctx.storage.put(`evidence-meta:${id}`,{updatedAt,type,size:buf.byteLength});this.broadcast({type:'evidence',id,updatedAt});return json({ok:true})
      }
      if(request.method==='GET'){const [buf,meta]=await Promise.all([this.ctx.storage.get(`evidence:${id}`),this.ctx.storage.get(`evidence-meta:${id}`)]);if(!buf)return new Response('Not found',{status:404});return new Response(buf,{headers:{'content-type':meta?.type||'image/jpeg','cache-control':'private, no-store'}})}
      if(request.method==='DELETE'){await this.ctx.storage.delete([`evidence:${id}`,`evidence-meta:${id}`]);this.broadcast({type:'evidence-delete',id});return json({ok:true})}
    }
    if(p==='/room/ws'&&request.headers.get('Upgrade')?.toLowerCase()==='websocket'){
      const pair=new WebSocketPair(),client=pair[0],server=pair[1];this.ctx.acceptWebSocket(server);return new Response(null,{status:101,webSocket:client})
    }
    return json({ok:false,error:'Not found'},404)
  }
  webSocketMessage(ws,message){if(String(message)==='ping'){try{ws.send(JSON.stringify({type:'pong',ts:Date.now()}))}catch(e){}}}
  webSocketClose(){}
  webSocketError(){}
}

async function handleSyncRequest(request,env,url){
  try{
    if(url.pathname==='/api/sync/create'&&request.method==='POST'){const code=newRoomCode(),stub=roomStub(env,code);const r=await stub.fetch(new Request('https://room/room/create',{method:'POST'}));if(!r.ok)return r;return json({ok:true,code:formatRoomCode(code)})}
    if(url.pathname==='/api/sync/join'&&request.method==='POST'){const b=await request.json(),code=normalizeRoomCode(b?.code),stub=roomStub(env,code),r=await stub.fetch('https://room/room/info');if(!r.ok)return json({ok:false,error:'Sync group not found'},404);return json({ok:true,code:formatRoomCode(code)})}
    const code=normalizeRoomCode(url.searchParams.get('code'));if(code.length!==12)return json({ok:false,error:'Invalid sync code'},400);const stub=roomStub(env,code);
    if(url.pathname==='/api/sync/state')return stub.fetch(new Request('https://room/room/state',{method:'GET',headers:request.headers}));
    if(url.pathname==='/api/sync/op'){const body=await request.text();return stub.fetch(new Request('https://room/room/op',{method:request.method,headers:request.headers,body}))}
    if(url.pathname.startsWith('/api/sync/evidence/')){const id=url.pathname.slice('/api/sync/evidence/'.length);const init={method:request.method,headers:request.headers};if(request.method==='PUT')init.body=await request.arrayBuffer();return stub.fetch(new Request(`https://room/room/evidence/${encodeURIComponent(id)}`,init))}
    if(url.pathname==='/api/sync/ws')return stub.fetch(new Request('https://room/room/ws',request));
    return json({ok:false,error:'Unknown sync endpoint'},404)
  }catch(e){return json({ok:false,error:e?.message||'Sync failed'},500)}
}

export default {
  async fetch(request,env){
    try{
      const url=new URL(request.url);
      if(url.pathname.startsWith('/api/auth/'))return await handleAuthRequest(request,env,url);
      if(url.pathname.startsWith('/api/admin/'))return await handleAdminRequest(request,env,url);
      if(url.pathname.startsWith('/api/account/'))return await handleAccountRequest(request,env,url);
      if(url.pathname.startsWith('/api/sync/'))return await handleSyncRequest(request,env,url);
      if(url.pathname==='/api/health')return json({ok:true,engine:'Manual entry + receipt evidence + Durable Object Sync',sync:'Durable Objects WebSocket + Optional Account Sessions',auth:'Optional account + owner-only user administration',passwordHash:`PBKDF2-SHA256/${AUTH_PBKDF2_ITERATIONS}`,version:VERSION,base:'6.0.2'});
      if(url.pathname==='/api/receipt'||url.pathname==='/api/receipt-text'||url.pathname==='/api/license')return json({ok:false,error:'Smart receipt reading has been permanently removed. Images are stored only as receipt evidence.',version:VERSION},410);
      return env.ASSETS.fetch(request)
    }catch(e){
      console.error('Monthly Expense request error',e);
      return authJson({ok:false,error:'SERVER_ERROR',detail:String(e?.message||e||'Unknown server error').slice(0,180),version:VERSION},500)
    }
  }
};
