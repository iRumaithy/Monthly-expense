const VERSION = '6.2.0';
const SCHEMA_VERSION = 'receipt-v6.2.0';
const GEMMA = '@cf/google/gemma-4-26b-a4b-it';
const LLAMA = '@cf/meta/llama-4-scout-17b-16e-instruct';
const PROTOCOL = 'receipt-evidence-v2';
const CAPABILITIES = ['adaptive-consensus','cross-family','cross-view','targeted-verification','field-level-consensus','strict-items','partial-verified-fields','local-merge-safe'];

const BASE_PROMPT = `You are a literal OCR reader for UAE receipts and tax invoices. Read ONLY pixels visible in the supplied receipt image. Never infer, autocomplete, normalize, translate, spell-correct, or guess a merchant/product name.

Return ONLY lines in this protocol, in visual order, with no markdown and no commentary:
STORE|exact customer-facing merchant/trade name printed on the receipt
DATE|YYYY-MM-DD
COUNT|printed number of distinct purchase rows, or blank if not explicitly printed
PIECES|printed total pieces/quantity, or blank if not explicitly printed
SUBTOTAL|amount before VAT, or blank
VAT|tax/VAT money amount, or blank
TOTAL|final payable/gross/net amount, or blank
ITEM|exact item/service description|quantity|unit price|line total

Rules:
1. STORE is the seller/business name. Never use customer, building/facility, delivery location, address, branch address, phone, TRN, invoice heading, or item text as STORE.
2. Preserve item and merchant spelling character-for-character. Do not repair medicine/brand/service names from memory.
3. Read EVERY purchase/service row. Wrapped description lines belong to the same row. Do not include totals, VAT, payment, greeting, terms, dates, order numbers, or customer information as items.
4. Quantity comes only from the Qty/Quantity/Pcs cell for that row. 10MG, 500ML, sizes, codes, and model numbers inside descriptions are not quantities.
5. If Rate/Unit Price and Amount/Line Total are both printed, copy both. If only one amount exists, put it in line total and leave unit price blank.
6. DATE is transaction/invoice/order date, not expected delivery, due, expiry, or print time.
7. Copy monetary values from pixels. Do not invent values just to make arithmetic work.
8. Re-check STORE and every ITEM description against pixels before returning.`;

const DETAIL_PROMPT = `This image contains the same receipt with enlarged overlapping areas. Read it independently. Enlarged regions are evidence, not duplicate receipts. Do not count repeated text twice. ${BASE_PROMPT}`;

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
function validDate(v){const s=text(v),m=s.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);if(!m)return null;const y=+m[1],mo=+m[2],d=+m[3];if(y<2000||y>2100||mo<1||mo>12||d<1||d>31)return null;return `${m[1]}-${m[2]}-${m[3]}`}
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
function moneyNear(a,b){a=Number(a);b=Number(b);if(!Number.isFinite(a)||!Number.isFinite(b))return false;return Math.abs(a-b)<=Math.max(.04,Math.max(Math.abs(a),Math.abs(b))*.002)}
function norm(v){return text(v).toUpperCase().replace(/&/g,' AND ').replace(/\b(?:L\.?L\.?C\.?|LLC|SOLE PROPRIETORSHIP|ESTABLISHMENT)\b/g,' ').replace(/[^A-Z0-9\u0600-\u06FF]+/g,' ').replace(/\s+/g,' ').trim()}
function tightNorm(v){return text(v).toUpperCase().replace(/[^A-Z0-9\u0600-\u06FF]+/g,'')}
function lev(a,b){a=norm(a);b=norm(b);const m=a.length,n=b.length;if(!m||!n)return Math.max(m,n);let prev=Array.from({length:n+1},(_,i)=>i);for(let i=1;i<=m;i++){const cur=[i];for(let j=1;j<=n;j++)cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));prev=cur}return prev[n]}
function sim(a,b){const A=norm(a),B=norm(b),d=Math.max(A.length,B.length);return d?Math.max(0,1-lev(A,B)/d):0}
function rowMoney(it){const l=num(it?.line_total);if(l!=null)return l;const u=num(it?.unit_price),q=Number(it?.quantity||1);return u!=null?Math.round(u*q*100)/100:null}
function itemSuspicious(it){const n=cleanName(it?.name),letters=(n.match(/[A-Za-z\u0600-\u06FF]/g)||[]).length;if(letters<2)return true;const q=Number(it?.quantity||1);if(!Number.isFinite(q)||q<=0||q>100)return true;const u=num(it?.unit_price),l=rowMoney(it);if(u!=null&&l!=null&&Math.abs(u*q-l)>Math.max(.08,Math.abs(l)*.008))return true;return false}
function family(engine){const e=String(engine||'').toLowerCase();if(e.includes('gemma'))return'gemma';if(e.includes('llama'))return'llama';return e.split('-')[0]||'unknown'}
function isTargetEngine(engine){return /target/i.test(String(engine||''))}
function validateCandidate(receipt,engine){
  const r=JSON.parse(JSON.stringify(receipt||{}));r.items=Array.isArray(r.items)?r.items.filter(x=>x&&cleanName(x.name)&&!summaryName(x.name)):[ ];
  if(r.merchant_name_en&&placeholderMerchant(r.merchant_name_en))r.merchant_name_en=null;
  const warnings=[],itemSum=Math.round(r.items.reduce((s,x)=>s+(rowMoney(x)||0),0)*100)/100,qtySum=Math.round(r.items.reduce((s,x)=>s+(Number(x.quantity)||1),0)*100)/100;
  const financeOk=r.total!=null&&(r.subtotal==null||r.tax==null||moneyNear(Number(r.subtotal)+Number(r.tax),r.total));
  const targets=[r.subtotal,r.total].filter(v=>v!=null).map(Number),rowsOk=r.items.length>0&&targets.some(t=>Math.abs(itemSum-t)<=Math.max(.10,Math.abs(t)*.006));
  const countOk=r.printed_item_count==null||Number(r.printed_item_count)===r.items.length,piecesOk=r.printed_piece_count==null||Math.abs(Number(r.printed_piece_count)-qtySum)<.001,itemTextOk=!r.items.some(itemSuspicious);
  if(!financeOk)warnings.push('financial totals conflict');if(!rowsOk)warnings.push('item rows do not reconcile');if(!countOk)warnings.push('printed item count conflict');if(!piecesOk)warnings.push('printed piece count conflict');if(!itemTextOk)warnings.push('suspicious item row');
  const accepted=!!(r.items.length&&r.total!=null&&financeOk&&rowsOk&&countOk&&piecesOk&&itemTextOk),complete=accepted&&!!r.merchant_name_en&&!!r.date;
  const quality=(complete?35:0)+(accepted?28:0)+(r.merchant_name_en?8:0)+(r.date?7:0)+Math.min(12,r.items.length*3)+(r.total!=null?8:0)-warnings.length*6;
  return{receipt:r,accepted,complete,quality,warnings,engine,item_sum:itemSum}
}
function numericRowsAgree(a,b){
  const A=a?.receipt?.items||[],B=b?.receipt?.items||[];if(!A.length||A.length!==B.length)return false;
  for(let i=0;i<A.length;i++){
    const x=A[i],y=B[i];if(Math.abs(Number(x.quantity||1)-Number(y.quantity||1))>.001)return false;
    if(!moneyNear(rowMoney(x),rowMoney(y)))return false;
    const ux=num(x.unit_price),uy=num(y.unit_price);if(ux!=null&&uy!=null&&!moneyNear(ux,uy))return false;
  }
  return true
}
function candidateFitness(c){return Number(c?.quality||0)+(c?.accepted?20:0)+(c?.complete?15:0)+(isTargetEngine(c?.engine)?8:0)}
function bestNumericPair(cands){
  let best=null;
  for(let i=0;i<cands.length;i++)for(let j=i+1;j<cands.length;j++){
    const a=cands[i],b=cands[j];if(family(a.engine)===family(b.engine)||!numericRowsAgree(a,b))continue;
    const A=a.receipt?.items||[],B=b.receipt?.items||[];let nameScore=0;for(let k=0;k<A.length;k++)nameScore+=sim(A[k].name,B[k].name);nameScore/=Math.max(1,A.length);
    const rank=1000+A.length*70+nameScore*100+candidateFitness(a)+candidateFitness(b);if(!best||rank>best.rank)best={a,b,rank,nameScore}
  }
  return best
}
function scalarConsensus(cands,getter,type='text'){
  const entries=cands.map(c=>({c,value:getter(c?.receipt||{})})).filter(x=>x.value!==null&&x.value!==undefined&&x.value!=='');if(!entries.length)return{ok:false,value:null,support:[]};
  const groups=[];
  for(const e of entries){let g=null;for(const q of groups){const match=type==='money'?moneyNear(q.rep.value,e.value):String(q.rep.value)===String(e.value);if(match){g=q;break}}if(!g){g={rep:e,items:[]};groups.push(g)}g.items.push(e)}
  for(const g of groups){g.families=new Set(g.items.map(x=>family(x.c.engine)));g.targets=g.items.filter(x=>isTargetEngine(x.c.engine)).length;g.rank=g.families.size*100+g.items.length*20+g.targets*12+g.items.reduce((s,x)=>s+candidateFitness(x.c),0)/Math.max(1,g.items.length)}
  groups.sort((a,b)=>b.rank-a.rank);const g=groups[0];const ok=g.families.size>=2&&g.items.length>=2;
  return{ok,value:ok?g.rep.value:null,support:g.items.map(x=>x.c.engine),count:g.items.length,target_support:g.targets}
}
function exactTextConsensus(values){
  const entries=values.filter(x=>cleanName(x.value)).map(x=>({...x,key:tightNorm(x.value)})).filter(x=>x.key);if(!entries.length)return{ok:false,value:null,support:[]};
  const groups=new Map();for(const e of entries){if(!groups.has(e.key))groups.set(e.key,[]);groups.get(e.key).push(e)}
  const ranked=[...groups.entries()].map(([key,items])=>{const fam=new Set(items.map(x=>family(x.engine))),targetFam=new Set(items.filter(x=>isTargetEngine(x.engine)).map(x=>family(x.engine))),targets=items.filter(x=>isTargetEngine(x.engine)).length;return{key,items,fam,targetFam,targets,rank:fam.size*100+items.length*25+targetFam.size*70+targets*20}}).sort((a,b)=>b.rank-a.rank);
  const top=ranked[0];if(!top)return{ok:false,value:null,support:[]};
  const g=ranked.find(x=>x.fam.size>=2&&(x.targetFam.size>=2||x.items.length>=3));
  if(!g)return{ok:false,value:null,support:top.items.map(x=>x.engine)};
  const preferred=g.items.find(x=>isTargetEngine(x.engine))||g.items.sort((a,b)=>String(b.value).length-String(a.value).length)[0];
  return{ok:true,value:cleanName(preferred.value),support:g.items.map(x=>x.engine),count:g.items.length,target_support:g.targets}
}
function candidateRowsMatchingSkeleton(c,skeleton){if(!c||!skeleton)return false;const A=c.receipt?.items||[],B=skeleton.receipt?.items||[];if(A.length!==B.length)return false;for(let i=0;i<A.length;i++){if(Math.abs(Number(A[i].quantity||1)-Number(B[i].quantity||1))>.001||!moneyNear(rowMoney(A[i]),rowMoney(B[i])))return false}return true}
function itemConsensus(cands,pair){
  if(!pair)return{ok:false,items:[],support:[],unresolved:[]};const skeleton=candidateFitness(pair.a)>=candidateFitness(pair.b)?pair.a:pair.b,base=skeleton.receipt.items||[],aligned=cands.filter(c=>candidateRowsMatchingSkeleton(c,skeleton));
  const out=[],unresolved=[];
  for(let i=0;i<base.length;i++){
    const nameVote=exactTextConsensus(aligned.map(c=>({value:c.receipt.items[i]?.name,engine:c.engine})));
    if(!nameVote.ok){unresolved.push(i);continue}
    const row=base[i],q=Number(row.quantity||1),line=rowMoney(row);let unit=num(row.unit_price);if(unit==null&&line!=null&&q>0)unit=Math.round(line/q*100)/100;
    out.push({name:nameVote.value,quantity:q,unit_price:unit,line_total:line,_support:nameVote.support})
  }
  return{ok:out.length===base.length&&base.length>0,items:out,support:aligned.map(c=>c.engine),unresolved,aligned}
}
function merchantConsensus(cands){return exactTextConsensus(cands.map(c=>({value:c.receipt?.merchant_name_en,engine:c.engine})))}
function buildTargetPrompt(cands){
  const merchants=[...new Set(cands.map(c=>cleanName(c.receipt?.merchant_name_en)).filter(Boolean))].slice(0,8);
  const pair=bestNumericPair(cands);let rows=[];
  if(pair){const base=pair.a.receipt.items||[],aligned=cands.filter(c=>candidateRowsMatchingSkeleton(c,pair.a));rows=base.map((r,i)=>({row:i+1,qty:Number(r.quantity||1),line:rowMoney(r),names:[...new Set(aligned.map(c=>cleanName(c.receipt.items[i]?.name)).filter(Boolean))].slice(0,8)}))}
  const hypothesis=`\nOCR hypotheses below may be WRONG. They are only pointers to where disagreement exists. Read the pixels yourself and ignore any hypothesis that does not match.\nMerchant hypotheses: ${JSON.stringify(merchants)}\nRow hypotheses anchored by printed quantity and line amount: ${JSON.stringify(rows)}`;
  return `Forensic verification pass. Use the enlarged image to resolve exact characters, especially merchant and item descriptions. Do a fresh full receipt read and return the normal STORE/DATE/COUNT/PIECES/SUBTOTAL/VAT/TOTAL/ITEM protocol. ${hypothesis}\n${BASE_PROMPT}`
}
function finalize(cands){
  const merchant=merchantConsensus(cands),date=scalarConsensus(cands,r=>r.date,'date'),subtotal=scalarConsensus(cands,r=>r.subtotal,'money'),tax=scalarConsensus(cands,r=>r.tax,'money'),total=scalarConsensus(cands,r=>r.total,'money');
  const pair=bestNumericPair(cands),items=itemConsensus(cands,pair);
  const canonical=pair?(candidateFitness(pair.a)>=candidateFitness(pair.b)?pair.a:pair.b):cands.sort((a,b)=>candidateFitness(b)-candidateFitness(a))[0];
  const CA=canonical?.receipt||{};
  const sameCount=pair&&pair.a.receipt.printed_item_count!=null&&pair.b.receipt.printed_item_count!=null&&Number(pair.a.receipt.printed_item_count)===Number(pair.b.receipt.printed_item_count);
  const samePieces=pair&&pair.a.receipt.printed_piece_count!=null&&pair.b.receipt.printed_piece_count!=null&&Number(pair.a.receipt.printed_piece_count)===Number(pair.b.receipt.printed_piece_count);
  const receipt={merchant_name_en:merchant.ok?merchant.value:null,date:date.ok?date.value:null,printed_item_count:(items.ok&&sameCount)?Number(pair.a.receipt.printed_item_count):null,printed_piece_count:(items.ok&&samePieces)?Number(pair.a.receipt.printed_piece_count):null,subtotal:subtotal.ok?Number(subtotal.value):null,tax:tax.ok?Number(tax.value):null,total:total.ok?Number(total.value):null,items:items.ok?items.items:[],warnings:[]};
  const verified_fields={merchant:merchant.ok,date:date.ok,subtotal:subtotal.ok,tax:tax.ok,total:total.ok,items:items.ok},review=Object.entries(verified_fields).filter(([,v])=>!v).map(([k])=>k);
  const partial_verified=Object.values(verified_fields).some(Boolean);const rowsTotal=Math.round(receipt.items.reduce((s,x)=>s+(rowMoney(x)||0),0)*100)/100;const rowsReconcile=receipt.items.length>0&&[receipt.subtotal,receipt.total].filter(v=>v!=null).some(v=>Math.abs(rowsTotal-v)<=Math.max(.10,Math.abs(v)*.006));
  const accepted=!!(merchant.ok&&date.ok&&total.ok&&items.ok&&rowsReconcile);
  if(!merchant.ok)receipt.warnings.push('Merchant spelling was not independently confirmed.');if(!items.ok)receipt.warnings.push('One or more item descriptions were not independently confirmed.');if(!accepted)receipt.warnings.push(`Only independently verified fields were retained. Review: ${review.join(', ')||'multiple fields'}`);
  const score=(merchant.ok?20:0)+(date.ok?10:0)+(total.ok?16:0)+(subtotal.ok?4:0)+(tax.ok?4:0)+(items.ok?46:0);
  return{accepted,complete:accepted,partial_verified,score:accepted?99:Math.min(94,score),receipt,verified_fields,consensus:{verified:accepted,partial_verified,policy:'field-level evidence + targeted spelling verification',review_fields:review,merchant_support:merchant.support||[],date_support:date.support||[],total_support:total.support||[],item_table_support:items.support||[],item_name_unresolved_rows:items.unresolved||[],agreement_score:score,candidates:cands.map(c=>({engine:c.engine,family:family(c.engine),accepted:c.accepted,complete:c.complete,quality:c.quality,merchant:c.receipt?.merchant_name_en||null,date:c.receipt?.date||null,item_count:c.receipt?.items?.length||0,total:c.receipt?.total??null,warnings:c.warnings}))}}
}
async function runVision(env,model,image,prompt,engine){
  const messages=[{role:'system',content:'You are a literal OCR engine. Never infer or repair text that is not visible.'},{role:'user',content:prompt}];
  const result=await env.AI.run(model,{messages,image,max_tokens:1900,temperature:0,top_p:.05,stream:false});const raw=responseText(result);if(!raw)throw new Error(`${engine} returned no OCR text`);return validateCandidate(parseProtocol(raw),engine)
}
async function readAdaptive(env,image,imageAlt){
  const alt=imageAlt||image;let calls=0;
  const first=await Promise.allSettled([
    runVision(env,GEMMA,image,BASE_PROMPT,'gemma4-full'),
    runVision(env,LLAMA,image,BASE_PROMPT,'llama4-full'),
    runVision(env,GEMMA,alt,DETAIL_PROMPT,'gemma4-detail'),
    runVision(env,LLAMA,alt,DETAIL_PROMPT,'llama4-detail')
  ]);calls+=4;
  let cands=first.filter(x=>x.status==='fulfilled').map(x=>x.value);if(cands.length<2)throw new Error('Not enough independent OCR readers returned a result');
  const targetPrompt=buildTargetPrompt(cands);
  const second=await Promise.allSettled([
    runVision(env,GEMMA,alt,targetPrompt,'gemma4-target'),
    runVision(env,LLAMA,alt,targetPrompt,'llama4-target')
  ]);calls+=2;cands=cands.concat(second.filter(x=>x.status==='fulfilled').map(x=>x.value));
  const result=finalize(cands);return{...result,inference_calls:calls,models_used:[GEMMA,LLAMA],targeted_verification:true}
}
function validImage(v){return typeof v==='string'&&v.startsWith('data:image/')&&v.length<7_000_000}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:headers({'access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type'})});
    if(url.pathname==='/api/health')return new Response(JSON.stringify({ok:true,engine:'Adaptive field-level receipt verification',version:VERSION,schema_version:SCHEMA_VERSION,protocol:PROTOCOL,capabilities:CAPABILITIES,frontend_compat:'adaptive',models:[GEMMA,LLAMA],primary:GEMMA,verifier:LLAMA,vision_reads_per_scan:6,text_policy:'merchant/item spellings require exact repeated evidence; targeted verification resolves disagreements',modes:['adaptive','consensus'],endpoints:['/api/health','/api/receipt']}),{headers:headers()});
    if(url.pathname==='/api/receipt'){
      if(request.method!=='POST')return new Response(JSON.stringify({ok:false,error:'Method not allowed'}),{status:405,headers:headers()});
      const started=Date.now(),scanId=crypto.randomUUID().slice(0,8);
      try{
        const body=await request.json(),image=body?.image,imageAlt=body?.image_alt,clientVersion=text(body?.client_version),clientSchema=text(body?.schema_version);
        if(!validImage(image))return new Response(JSON.stringify({ok:false,error:'One complete receipt image is required'}),{status:400,headers:headers()});
        const result=await readAdaptive(env,image,validImage(imageAlt)?imageAlt:null);
        return new Response(JSON.stringify({ok:true,...result,meta:{engine:'Cloudflare Workers AI • adaptive field-level consensus',version:VERSION,schema_version:SCHEMA_VERSION,client_version:clientVersion||null,client_schema_version:clientSchema||null,contract_match:(!clientSchema||clientSchema===SCHEMA_VERSION),protocol:PROTOCOL,capabilities:CAPABILITIES,mode:'adaptive',scan_id:scanId,elapsed_ms:Date.now()-started,inference_calls:result.inference_calls,models_used:result.models_used,consensus_verified:!!result?.consensus?.verified,targeted_verification:true}}),{headers:headers()})
      }catch(e){const msg=e?.message||'Receipt analysis failed';return new Response(JSON.stringify({ok:false,error:msg,retriable:/timeout|capacity|temporar|429|abort/i.test(msg),meta:{version:VERSION,schema_version:SCHEMA_VERSION,scan_id:scanId,elapsed_ms:Date.now()-started}}),{status:500,headers:headers()})}
    }
    if(url.pathname==='/api/receipt-text')return new Response(JSON.stringify({ok:false,error:'Text-only structuring is disabled. Use /api/receipt with receipt pixels.'}),{status:409,headers:headers()});
    if(url.pathname==='/api/license')return new Response('No separate license activation endpoint is required by this build.',{headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}});
    return env.ASSETS.fetch(request)
  }
};
