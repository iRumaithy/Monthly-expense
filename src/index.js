import { DurableObject } from "cloudflare:workers";
const VERSION='6.0.0';
function syncHeaders(extra={}){return {'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra}}
function normalizeRoomCode(v){return String(v||'').toUpperCase().replace(/[^A-Z2-9]/g,'').slice(0,12)}
function formatRoomCode(v){const s=normalizeRoomCode(v);return (s.match(/.{1,4}/g)||[s]).join('-')}
function newRoomCode(){const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',bytes=new Uint8Array(12);crypto.getRandomValues(bytes);return [...bytes].map(b=>alphabet[b%alphabet.length]).join('')}
function roomStub(env,code){const c=normalizeRoomCode(code);if(c.length!==12)throw new Error('Invalid sync code');return env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(c))}
function isoGreater(a,b){return String(a||'')>String(b||'')}

export class SyncRoom extends DurableObject{
  async meta(){return await this.ctx.storage.get('meta')}
  broadcast(msg,except=null){const text=JSON.stringify(msg);for(const ws of this.ctx.getWebSockets()){if(ws===except)continue;try{ws.send(text)}catch(e){}}}
  async fetch(request){
    const u=new URL(request.url),p=u.pathname;
    if(p==='/room/create'&&request.method==='POST'){
      let m=await this.meta();if(!m){m={createdAt:new Date().toISOString()};await this.ctx.storage.put('meta',m)}return new Response(JSON.stringify({ok:true,...m}),{headers:syncHeaders()})
    }
    const m=await this.meta();if(!m)return new Response(JSON.stringify({ok:false,error:'Sync group not found'}),{status:404,headers:syncHeaders()});
    if(p==='/room/info')return new Response(JSON.stringify({ok:true,createdAt:m.createdAt}),{headers:syncHeaders()});
    if(p==='/room/state'&&request.method==='GET'){
      const [rr,dd,bb,ee]=await Promise.all([this.ctx.storage.list({prefix:'receipt:'}),this.ctx.storage.list({prefix:'deleted:'}),this.ctx.storage.list({prefix:'budget:'}),this.ctx.storage.list({prefix:'evidence-meta:'})]);
      return new Response(JSON.stringify({ok:true,receipts:[...rr.values()],deleted:[...dd.values()],budgets:[...bb.entries()].map(([k,v])=>({month:k.slice(7),...v})),evidence:[...ee.entries()].map(([k,v])=>({id:k.slice(14),...v}))}),{headers:syncHeaders()})
    }
    if(p==='/room/op'&&request.method==='POST'){
      const b=await request.json(),clientId=String(b.clientId||''),now=new Date().toISOString();
      if(b.type==='upsert'&&b.receipt?.id){const r=b.receipt,id=String(r.id),old=await this.ctx.storage.get(`receipt:${id}`),del=await this.ctx.storage.get(`deleted:${id}`);if((!old||isoGreater(r.updatedAt,old.updatedAt))&&(!del||isoGreater(r.updatedAt,del.updatedAt))){await this.ctx.storage.put(`receipt:${id}`,r);await this.ctx.storage.delete(`deleted:${id}`);this.broadcast({type:'upsert',receipt:r,clientId})}}
      else if(b.type==='delete'&&b.id){const id=String(b.id),ts=String(b.updatedAt||now),old=await this.ctx.storage.get(`receipt:${id}`),del=await this.ctx.storage.get(`deleted:${id}`);if((!old||!isoGreater(old.updatedAt,ts))&&(!del||isoGreater(ts,del.updatedAt))){await this.ctx.storage.delete([`receipt:${id}`,`evidence:${id}`,`evidence-meta:${id}`]);await this.ctx.storage.put(`deleted:${id}`,{id,updatedAt:ts});this.broadcast({type:'delete',id,updatedAt:ts,clientId})}}
      else if(b.type==='budget'&&/^\d{4}-\d{2}$/.test(String(b.month||''))){const month=String(b.month),v={value:Number(b.value)||0,updatedAt:String(b.updatedAt||now)},old=await this.ctx.storage.get(`budget:${month}`);if(!old||isoGreater(v.updatedAt,old.updatedAt)){await this.ctx.storage.put(`budget:${month}`,v);this.broadcast({type:'budget',month,...v,clientId})}}
      return new Response(JSON.stringify({ok:true}),{headers:syncHeaders()})
    }
    if(p.startsWith('/room/evidence/')){
      const id=decodeURIComponent(p.slice('/room/evidence/'.length)).replace(/[^A-Za-z0-9_-]/g,'').slice(0,80);if(!id)return new Response('Bad id',{status:400});
      if(request.method==='PUT'){const buf=await request.arrayBuffer();if(buf.byteLength>1900000)return new Response(JSON.stringify({ok:false,error:'Evidence image too large'}),{status:413,headers:syncHeaders()});const type=request.headers.get('content-type')||'image/jpeg',updatedAt=new Date().toISOString();await this.ctx.storage.put(`evidence:${id}`,buf);await this.ctx.storage.put(`evidence-meta:${id}`,{updatedAt,type,size:buf.byteLength});this.broadcast({type:'evidence',id,updatedAt});return new Response(JSON.stringify({ok:true}),{headers:syncHeaders()})}
      if(request.method==='GET'){const [buf,meta]=await Promise.all([this.ctx.storage.get(`evidence:${id}`),this.ctx.storage.get(`evidence-meta:${id}`)]);if(!buf)return new Response('Not found',{status:404});return new Response(buf,{headers:{'content-type':meta?.type||'image/jpeg','cache-control':'private, no-store'}})}
      if(request.method==='DELETE'){await this.ctx.storage.delete([`evidence:${id}`,`evidence-meta:${id}`]);this.broadcast({type:'evidence-delete',id});return new Response(JSON.stringify({ok:true}),{headers:syncHeaders()})}
    }
    if(p==='/room/ws'&&request.headers.get('Upgrade')==='websocket'){
      const pair=new WebSocketPair(),client=pair[0],server=pair[1];this.ctx.acceptWebSocket(server);return new Response(null,{status:101,webSocket:client})
    }
    return new Response(JSON.stringify({ok:false,error:'Not found'}),{status:404,headers:syncHeaders()})
  }
  webSocketMessage(ws,message){if(String(message)==='ping'){try{ws.send(JSON.stringify({type:'pong',ts:Date.now()}))}catch(e){}}}
  webSocketClose(){}
  webSocketError(){}
}

async function handleSyncRequest(request,env,url){
  try{
    if(url.pathname==='/api/sync/create'&&request.method==='POST'){const code=newRoomCode(),stub=roomStub(env,code);const inner=new Request('https://room/room/create',{method:'POST'});const r=await stub.fetch(inner);if(!r.ok)return r;return new Response(JSON.stringify({ok:true,code:formatRoomCode(code)}),{headers:syncHeaders()})}
    if(url.pathname==='/api/sync/join'&&request.method==='POST'){const b=await request.json(),code=normalizeRoomCode(b?.code),stub=roomStub(env,code),r=await stub.fetch('https://room/room/info');if(!r.ok)return new Response(JSON.stringify({ok:false,error:'Sync group not found'}),{status:404,headers:syncHeaders()});return new Response(JSON.stringify({ok:true,code:formatRoomCode(code)}),{headers:syncHeaders()})}
    const code=normalizeRoomCode(url.searchParams.get('code'));if(code.length!==12)return new Response(JSON.stringify({ok:false,error:'Invalid sync code'}),{status:400,headers:syncHeaders()});const stub=roomStub(env,code);
    if(url.pathname==='/api/sync/state')return stub.fetch(new Request('https://room/room/state',{method:'GET',headers:request.headers}));
    if(url.pathname==='/api/sync/op'){const body=await request.text();return stub.fetch(new Request('https://room/room/op',{method:request.method,headers:request.headers,body}))};
    if(url.pathname.startsWith('/api/sync/evidence/')){const id=url.pathname.slice('/api/sync/evidence/'.length);const init={method:request.method,headers:request.headers};if(request.method==='PUT')init.body=await request.arrayBuffer();return stub.fetch(new Request(`https://room/room/evidence/${encodeURIComponent(id)}`,init))}
    if(url.pathname==='/api/sync/ws'){return stub.fetch(new Request('https://room/room/ws',request))}
    return new Response(JSON.stringify({ok:false,error:'Unknown sync endpoint'}),{status:404,headers:syncHeaders()})
  }catch(e){return new Response(JSON.stringify({ok:false,error:e?.message||'Sync failed'}),{status:500,headers:syncHeaders()})}
}

function json(body,status=200){return new Response(JSON.stringify(body),{status,headers:syncHeaders()})}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname.startsWith('/api/sync/'))return await handleSyncRequest(request,env,url);
    if(url.pathname==='/api/health')return json({ok:true,engine:'Manual entry + receipt evidence + Durable Object Sync',sync:'Durable Objects WebSocket',version:VERSION});
    if(url.pathname==='/api/receipt'||url.pathname==='/api/receipt-text'||url.pathname==='/api/license')return json({ok:false,error:'Smart receipt reading has been permanently removed. Images are stored only as receipt evidence.',version:VERSION},410);
    return env.ASSETS.fetch(request)
  }
};
