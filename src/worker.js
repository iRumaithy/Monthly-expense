const VERSION = '5.10.0';
const SCHEMA_VERSION = 'receipt-v5.10.0';
const GEMMA = '@cf/google/gemma-4-26b-a4b-it';
const LLAMA = '@cf/meta/llama-4-scout-17b-16e-instruct';

const BASE_PROMPT = `You are a literal OCR reader for UAE receipts and tax invoices. Read ONLY pixels visible in the supplied receipt image. Never infer, autocomplete, normalize, translate, or guess a merchant/product name.

Return ONLY lines in this protocol, in visual order, with no markdown and no commentary:
STORE|exact customer-facing merchant/trade name printed on the receipt
DATE|YYYY-MM-DD
COUNT|printed number of distinct purchase rows, or blank if not explicitly printed
PIECES|printed total pieces/quantity, or blank if not explicitly printed
SUBTOTAL|amount before VAT, or blank
VAT|tax/VAT money amount, or blank
TOTAL|final payable/gross/net amount, or blank
ITEM|exact item/service description|quantity|unit price|line total

Critical rules:
1. STORE is the prominent seller/business name or logo text. Never use the customer name, building/facility name, delivery location, address, branch address, phone, TRN, invoice heading, or an item name as STORE. A legal company name is acceptable only when it is visibly presented as the seller and no clearer trade name exists.
2. Preserve spelling character-for-character. Do not spell-correct medicine, brand, laundry service, or product names. If a character is unreadable, keep the readable surrounding text and do not invent characters.
3. Read EVERY purchase/service row. Wrapped description lines belong to the same row. Do not include subtotal, VAT, total, payment, balance, greeting, terms, date, order number, or customer information as items.
4. Quantity comes ONLY from the Qty/Quantity/Pcs column in that row. Numbers such as 10MG, 500ML, sizes, codes and model numbers inside descriptions are not quantities. If there is no explicit quantity cell, use 1.
5. If a row has both Rate/Unit Price and Amount/Line Total, copy both. If only one money column exists, put the printed amount in line total and leave unit price blank.
6. DATE is transaction/invoice/order date. Never use expected delivery date, due date, expiry date, or print time.
7. Copy monetary values literally. Do not calculate missing values merely to make totals reconcile.
8. Re-check STORE and every ITEM description a second time against the pixels before returning.`;

const VERIFY_PROMPT = `Perform a completely independent second OCR read. This image may contain the full receipt plus enlarged overlapping views of the SAME receipt. Do not count duplicated text/rows twice; use the enlarged views only to verify exact characters. Do not rely on any previous answer. ${BASE_PROMPT}`;

function headers(extra={}){return {'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*',...extra}}
function text(v){return String(v??'').replace(/\s+/g,' ').trim()}
function responseText(r){
  if(typeof r==='string')return r;
  const vals=[r?.response,r?.answer,r?.result,r?.choices?.[0]?.message?.content,r?.choices?.[0]?.text];
  for(const v of vals){
    if(typeof v==='string'&&v.trim())return v.trim();
    if(Array.isArray(v)){const s=v.map(x=>typeof x==='string'?x:(x?.text||x?.content||'')).join('\n').trim();if(s)return s}
  }
  return '';
}
function num(v){
  const s=String(v??'').replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/٫/g,'.').replace(/,/g,'').replace(/[^0-9.\-]/g,'');
  if(!s)return null;const n=Number(s);return Number.isFinite(n)?Math.round(n*100)/100:null
}
function validDate(v){const s=text(v);const m=s.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);if(!m)return null;const y=+m[1],mo=+m[2],d=+m[3];if(y<2000||y>2100||mo<1||mo>12||d<1||d>31)return null;return `${m[1]}-${m[2]}-${m[3]}`}
function cleanName(v){return text(v).replace(/^[-–—|:;,.\s]+|[-–—|:;,.\s]+$/g,'').trim()}
function summaryName(v){return /^(?:subtotal|sub\s*total|vat|tax|total|grand\s*total|net\s*amount|gross|amount|balance|cash|card|change|qty|quantity|item|description|service|rate|price|invoice|receipt|trn|date|order|thank|customer)\b/i.test(cleanName(v))}
function placeholderMerchant(v){return /^(?:store|merchant|business|seller|customer|branch|tax invoice|invoice|receipt|unknown|n\/a)$/i.test(cleanName(v))}
function parseProtocol(raw){
  const out={merchant_name_en:null,date:null,printed_item_count:null,printed_piece_count:null,subtotal:null,tax:null,total:null,items:[],warnings:[]};
  for(const rawLine of String(raw||'').split(/\r?\n/)){
    const line=rawLine.replace(/^[-*•\s]+/,'').replace(/^`+|`+$/g,'').trim();if(!line)continue;
    const p=line.split('|'),key=text(p.shift()).toUpperCase();
    if(key==='STORE'){const v=cleanName(p.join('|'));if(v&&!placeholderMerchant(v))out.merchant_name_en=v;continue}
    if(key==='DATE'){out.date=validDate(p.join('|'));continue}
    if(key==='COUNT'){const v=num(p[0]);out.printed_item_count=v>0?Math.round(v):null;continue}
    if(key==='PIECES'){const v=num(p[0]);out.printed_piece_count=v>0?Math.round(v):null;continue}
    if(key==='SUBTOTAL'){out.subtotal=num(p[0]);continue}
    if(key==='VAT'||key==='TAX'){out.tax=num(p[0]);continue}
    if(key==='TOTAL'){out.total=num(p[0]);continue}
    if(key==='ITEM'){
      const name=cleanName(p[0]);if(!name||summaryName(name))continue;
      let quantity=num(p[1]);if(!Number.isFinite(quantity)||quantity<=0||quantity>999)quantity=1;
      let unit=num(p[2]),lineTotal=num(p[3]);if(unit!=null&&unit<=0)unit=null;if(lineTotal!=null&&lineTotal<=0)lineTotal=null;
      if(lineTotal==null&&unit!=null)lineTotal=Math.round(unit*quantity*100)/100;
      out.items.push({name,quantity,unit_price:unit,line_total:lineTotal})
    }
  }
  return out
}
function moneyNear(a,b){a=Number(a);b=Number(b);if(!Number.isFinite(a)||!Number.isFinite(b))return false;return Math.abs(a-b)<=Math.max(.03,Math.max(Math.abs(a),Math.abs(b))*.0015)}
function norm(v){return text(v).toUpperCase().replace(/&/g,' AND ').replace(/\b(?:L\.?L\.?C\.?|LLC|SOLE PROPRIETORSHIP|ESTABLISHMENT)\b/g,' ').replace(/[^A-Z0-9\u0600-\u06FF]+/g,' ').replace(/\s+/g,' ').trim()}
function lev(a,b){a=norm(a);b=norm(b);const m=a.length,n=b.length;if(!m||!n)return Math.max(m,n);let prev=Array.from({length:n+1},(_,i)=>i);for(let i=1;i<=m;i++){const cur=[i];for(let j=1;j<=n;j++)cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));prev=cur}return prev[n]}
function sim(a,b){const A=norm(a),B=norm(b),d=Math.max(A.length,B.length);if(!d)return 0;if(A===B)return 1;if(A.includes(B)&&B.length>=Math.min(8,A.length*.55))return Math.min(.94,B.length/A.length+.18);if(B.includes(A)&&A.length>=Math.min(8,B.length*.55))return Math.min(.94,A.length/B.length+.18);return Math.max(0,1-lev(A,B)/d)}
function rowMoney(it){const l=num(it?.line_total);if(l!=null)return l;const u=num(it?.unit_price),q=Number(it?.quantity||1);return u!=null?Math.round(u*q*100)/100:null}
function itemSuspicious(it){const n=cleanName(it?.name),letters=(n.match(/[A-Za-z\u0600-\u06FF]/g)||[]).length;if(letters<2)return true;const q=Number(it?.quantity||1);if(!Number.isFinite(q)||q<=0||q>100)return true;const u=num(it?.unit_price),l=rowMoney(it);if(u!=null&&l!=null&&Math.abs(u*q-l)>Math.max(.08,Math.abs(l)*.006))return true;return false}
function validateCandidate(receipt,engine){
  const r=JSON.parse(JSON.stringify(receipt||{}));r.items=Array.isArray(r.items)?r.items.filter(x=>x&&cleanName(x.name)&&!summaryName(x.name)):[];
  const warnings=[];if(r.merchant_name_en&&placeholderMerchant(r.merchant_name_en))r.merchant_name_en=null;
  const itemSum=Math.round(r.items.reduce((s,x)=>s+(rowMoney(x)||0),0)*100)/100;
  const qtySum=Math.round(r.items.reduce((s,x)=>s+(Number(x.quantity)||1),0)*100)/100;
  const financeOk=r.total!=null && (r.subtotal==null||r.tax==null||moneyNear(Number(r.subtotal)+Number(r.tax),r.total));
  const targets=[r.subtotal,r.total].filter(v=>v!=null).map(Number);const rowsOk=r.items.length>0&&targets.some(t=>Math.abs(itemSum-t)<=Math.max(.08,Math.abs(t)*.004));
  const countOk=r.printed_item_count==null||Number(r.printed_item_count)===r.items.length;
  const piecesOk=r.printed_piece_count==null||Math.abs(Number(r.printed_piece_count)-qtySum)<.001;
  const itemTextOk=!r.items.some(itemSuspicious);
  if(!financeOk)warnings.push('financial totals conflict');if(!rowsOk)warnings.push('item rows do not reconcile');if(!countOk)warnings.push('printed item count conflict');if(!piecesOk)warnings.push('printed piece count conflict');if(!itemTextOk)warnings.push('suspicious item row');
  const accepted=!!(r.items.length&&r.total!=null&&financeOk&&rowsOk&&countOk&&piecesOk&&itemTextOk);
  const complete=accepted&&!!r.merchant_name_en&&!!r.date;
  let quality=(complete?35:0)+(accepted?30:0)+(r.merchant_name_en?8:0)+(r.date?7:0)+Math.min(12,r.items.length*3)+(r.total!=null?8:0)-warnings.length*8;
  return{receipt:r,accepted,complete,quality,warnings,engine,item_sum:itemSum}
}
function rowsAgree(a,b){
  const A=a?.receipt?.items||[],B=b?.receipt?.items||[];if(!A.length||A.length!==B.length)return{ok:false,score:0};
  let score=0;
  for(let i=0;i<A.length;i++){
    const x=A[i],y=B[i],qx=Number(x.quantity||1),qy=Number(y.quantity||1);if(Math.abs(qx-qy)>.001)return{ok:false,score};
    const lx=rowMoney(x),ly=rowMoney(y);if(!moneyNear(lx,ly))return{ok:false,score};
    const ux=num(x.unit_price),uy=num(y.unit_price);if(ux!=null&&uy!=null&&!moneyNear(ux,uy))return{ok:false,score};
    const nx=norm(x.name),ny=norm(y.name);if(!nx||nx!==ny)return{ok:false,score};score+=1
  }
  return{ok:true,score:score/A.length}
}
function agreement(a,b){
  if(!a||!b)return{ok:false,score:0,reasons:['missing candidate']};const A=a.receipt||{},B=b.receipt||{},reasons=[];
  const merchant=!!A.merchant_name_en&&!!B.merchant_name_en&&norm(A.merchant_name_en)===norm(B.merchant_name_en);
  const date=!!A.date&&!!B.date&&A.date===B.date;
  const total=moneyNear(A.total,B.total);
  const subtotalVerified=A.subtotal!=null&&B.subtotal!=null&&moneyNear(A.subtotal,B.subtotal);
  const taxVerified=A.tax!=null&&B.tax!=null&&moneyNear(A.tax,B.tax);
  const subtotalCompatible=(A.subtotal==null&&B.subtotal==null)||subtotalVerified;
  const taxCompatible=(A.tax==null&&B.tax==null)||taxVerified;
  const rows=rowsAgree(a,b);
  if(!merchant)reasons.push('merchant disagreement');if(!date)reasons.push('date disagreement');if(!total)reasons.push('total disagreement');if(!subtotalCompatible)reasons.push('subtotal disagreement');if(!taxCompatible)reasons.push('tax disagreement');if(!rows.ok)reasons.push('item-table disagreement');
  const score=(merchant?20:0)+(date?12:0)+(total?18:0)+(subtotalVerified?5:0)+(taxVerified?5:0)+(rows.ok?40:0);
  return{ok:merchant&&date&&total&&subtotalCompatible&&taxCompatible&&rows.ok&&a.accepted&&b.accepted,score,reasons,merchant,date,total,subtotalVerified,taxVerified,subtotalCompatible,taxCompatible,rows}
}
function candidateFitness(c){if(!c)return-999;return Number(c.quality||0)+(c.complete?30:0)+(c.accepted?20:0)}
function engineFamily(c){const e=String(c?.engine||'').toLowerCase();if(e.startsWith('gemma'))return'gemma';if(e.startsWith('llama'))return'llama';return e.split('-')[0]||'unknown'}
function choosePair(cands){
  let best=null;for(let i=0;i<cands.length;i++)for(let j=i+1;j<cands.length;j++){
    const a=cands[i],b=cands[j];if(!a||!b||engineFamily(a)===engineFamily(b))continue;
    const ag=agreement(a,b),fit=candidateFitness(a)+candidateFitness(b),rank=ag.score*100+fit;if(!best||rank>best.rank)best={a,b,ag,rank}
  }return best
}
function chooseCanonical(pair){
  if(!pair)return null;const {a,b}=pair;const qa=candidateFitness(a),qb=candidateFitness(b);if(qa!==qb)return qa>qb?a:b;
  const an=(a.receipt?.items||[]).reduce((s,x)=>s+cleanName(x.name).length,0),bn=(b.receipt?.items||[]).reduce((s,x)=>s+cleanName(x.name).length,0);return an>=bn?a:b
}
function serializeDualView(fullPair,detailPair,candidates,extra={}){
  const F=fullPair?.ag||{},D=detailPair?.ag||{};
  const full=chooseCanonical(fullPair),detail=chooseCanonical(detailPair);
  const X=(full&&detail)?agreement(full,detail):{merchant:false,date:false,total:false,subtotalVerified:false,taxVerified:false,rows:{ok:false},score:0};
  const A=full?.receipt||{},B=detail?.receipt||{};

  // Text fields require agreement across model families AND across two independent image views.
  const merchant=!!(F.merchant&&D.merchant&&X.merchant);
  const items=!!(F.rows?.ok&&D.rows?.ok&&X.rows?.ok);

  // Numeric/date fields still require independent cross-family agreement on the full receipt.
  // If the detail view also found the field, it must not contradict the full view.
  const date=!!(F.date&&(!D.date||X.date));
  const total=!!(F.total&&(!D.total||X.total));
  const subtotal=!!(F.subtotalVerified&&(!D.subtotalVerified||X.subtotalVerified));
  const tax=!!(F.taxVerified&&(!D.taxVerified||X.taxVerified));

  const FA=fullPair?.a?.receipt||{},FB=fullPair?.b?.receipt||{};
  const sameCount=FA.printed_item_count!=null&&FB.printed_item_count!=null&&Number(FA.printed_item_count)===Number(FB.printed_item_count);
  const samePieces=FA.printed_piece_count!=null&&FB.printed_piece_count!=null&&Number(FA.printed_piece_count)===Number(FB.printed_piece_count);
  const receipt={
    merchant_name_en:merchant?(A.merchant_name_en||B.merchant_name_en):null,
    date:date?(A.date||null):null,
    printed_item_count:(items&&sameCount)?Number(FA.printed_item_count):null,
    printed_piece_count:(items&&samePieces)?Number(FA.printed_piece_count):null,
    subtotal:subtotal?Number(A.subtotal):null,
    tax:tax?Number(A.tax):null,
    total:total?Number(A.total):null,
    items:items?(A.items||[]):[],
    warnings:[]
  };
  const verified_fields={merchant,date,subtotal,tax,total,items};
  const partial_verified=Object.values(verified_fields).some(Boolean);
  const accepted=!!(merchant&&date&&total&&items&&full?.accepted&&full?.complete);
  const review=[];for(const [k,v] of Object.entries(verified_fields))if(!v)review.push(k);
  const warnings=[];
  if(!merchant)warnings.push('Merchant text did not match across two model families and two image views.');
  if(!items)warnings.push('Item table did not match across two model families and two image views.');
  if(!accepted)warnings.push(`Only independently agreed fields were retained. Review: ${review.join(', ')||'multiple fields'}`);
  receipt.warnings=[...new Set(warnings)];
  const score=(merchant?22:0)+(date?12:0)+(total?18:0)+(subtotal?4:0)+(tax?4:0)+(items?40:0);
  return{accepted,complete:accepted,partial_verified,score:accepted?99:Math.max(0,Math.min(92,score)),receipt,verified_fields,
    consensus:{verified:accepted,partial_verified,policy:'cross-family + cross-view for merchant/items',pair_full:fullPair?[fullPair.a.engine,fullPair.b.engine]:[],pair_detail:detailPair?[detailPair.a.engine,detailPair.b.engine]:[],agreement_score:score,review_fields:review,candidates:candidates.map(c=>({engine:c.engine,accepted:c.accepted,complete:c.complete,quality:c.quality,merchant:c.receipt?.merchant_name_en||null,date:c.receipt?.date||null,item_count:c.receipt?.items?.length||0,total:c.receipt?.total??null,warnings:c.warnings}))},...extra}
}
async function runVision(env,model,image,prompt,engine){
  const messages=[{role:'system',content:'You are a literal OCR engine. Never infer text that is not visible.'},{role:'user',content:prompt}];
  const result=await env.AI.run(model,{messages,image,max_tokens:1800,temperature:0,top_p:.05,stream:false});const raw=responseText(result);if(!raw)throw new Error(`${engine} returned no OCR text`);return validateCandidate(parseProtocol(raw),engine)
}
async function readConsensus(env,image,imageAlt){
  // High-precision mode always uses four reads: two independent model families × two image views.
  // This prevents a plausible but wrong merchant/item string from passing merely because two
  // models made the same mistake on the same downscaled view.
  let calls=0;const alt=imageAlt||image;
  const all=await Promise.allSettled([
    runVision(env,GEMMA,image,BASE_PROMPT,'gemma4-full'),
    runVision(env,LLAMA,image,BASE_PROMPT,'llama4-full'),
    runVision(env,GEMMA,alt,VERIFY_PROMPT,'gemma4-detail'),
    runVision(env,LLAMA,alt,VERIFY_PROMPT,'llama4-detail')
  ]);calls=4;
  const candidates=all.filter(x=>x.status==='fulfilled').map(x=>x.value);
  const byEngine=new Map(candidates.map(c=>[c.engine,c]));
  const gf=byEngine.get('gemma4-full'),lf=byEngine.get('llama4-full'),gd=byEngine.get('gemma4-detail'),ld=byEngine.get('llama4-detail');
  const fullPair=(gf&&lf)?{a:gf,b:lf,ag:agreement(gf,lf)}:null;
  const detailPair=(gd&&ld)?{a:gd,b:ld,ag:agreement(gd,ld)}:null;
  return serializeDualView(fullPair,detailPair,candidates,{inference_calls:calls,models_used:[GEMMA,LLAMA],repair_used:true})
}
function validImage(v){return typeof v==='string'&&v.startsWith('data:image/')&&v.length<7_000_000}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:headers({'access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type'})});
    if(url.pathname==='/api/health')return new Response(JSON.stringify({ok:true,engine:'Strict cross-family + cross-view receipt consensus',version:VERSION,schema_version:SCHEMA_VERSION,frontend_compat:VERSION,models:[GEMMA,LLAMA],primary:GEMMA,verifier:LLAMA,vision_reads_per_scan:4,text_policy:'merchant/items require cross-family and cross-view agreement',modes:['consensus'],endpoints:['/api/health','/api/receipt']}),{headers:headers()});
    if(url.pathname==='/api/receipt'){
      if(request.method!=='POST')return new Response(JSON.stringify({ok:false,error:'Method not allowed'}),{status:405,headers:headers()});
      const started=Date.now(),scanId=crypto.randomUUID().slice(0,8);
      try{
        const body=await request.json(),image=body?.image,imageAlt=body?.image_alt,clientVersion=text(body?.client_version),clientSchema=text(body?.schema_version);
        if(!validImage(image))return new Response(JSON.stringify({ok:false,error:'One complete receipt image is required'}),{status:400,headers:headers()});
        const result=await readConsensus(env,image,validImage(imageAlt)?imageAlt:null);
        return new Response(JSON.stringify({ok:true,...result,meta:{engine:'Cloudflare Workers AI • cross-family + cross-view consensus',version:VERSION,schema_version:SCHEMA_VERSION,client_version:clientVersion||null,client_schema_version:clientSchema||null,contract_match:(!clientVersion||clientVersion===VERSION)&&(!clientSchema||clientSchema===SCHEMA_VERSION),mode:'consensus',scan_id:scanId,elapsed_ms:Date.now()-started,inference_calls:result.inference_calls||2,models_used:result.models_used||[GEMMA,LLAMA],consensus_verified:!!result?.consensus?.verified,repair_used:!!result.repair_used}}),{headers:headers()})
      }catch(e){const msg=e?.message||'Receipt analysis failed';return new Response(JSON.stringify({ok:false,error:msg,retriable:/timeout|capacity|temporar|429|abort/i.test(msg),meta:{version:VERSION,schema_version:SCHEMA_VERSION,scan_id:scanId,elapsed_ms:Date.now()-started}}),{status:500,headers:headers()})}
    }
    if(url.pathname==='/api/receipt-text')return new Response(JSON.stringify({ok:false,error:'Text-only structuring is disabled in strict accuracy mode. Use /api/receipt with the receipt image.'}),{status:409,headers:headers()});
    if(url.pathname==='/api/license')return new Response('No separate license activation endpoint is required by this build.',{headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}});
    return env.ASSETS.fetch(request)
  }
};
