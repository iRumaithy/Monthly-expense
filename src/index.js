const MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const VERSION = '4.4.1';

const PROMPT = `You are a literal OCR evidence extractor for UAE receipts and tax invoices of ANY layout.

The supplied composite contains:
- LEFT: the COMPLETE receipt for overall context.
- RIGHT TOP / MIDDLE / BOTTOM: three overlapping enlarged detail views covering the receipt from top to bottom.
These detail panels are ONLY for magnification. Do not assume merchant/date/items/totals are in a fixed panel.

Your job is NOT to decide the final accounting fields. Transcribe the evidence so the Worker can decide locally.
Return ONLY these plain protocol lines. No JSON, markdown, bullets, commentary, or code fences.

HEADER|prominent English organization / trade / outlet line
HEADER|another prominent English organization / trade / outlet line
DATE_LINE|printed label|date exactly as printed
MONEY|printed label|amount
PERCENT|printed label|percentage number
COUNT_LINE|printed label|number
ITEM|English item text|Arabic item text|quantity|unit price|line total

GENERAL RULES:
1. Work with ANY receipt layout: narrow, wide, long, short, Arabic, English, bilingual, pharmacy, laundry, restaurant, supermarket, garage, clinic, etc.
2. Transcribe evidence literally. Do not translate, summarize, spell-correct, normalize dates, or infer missing numbers.
3. Remove visual markdown-like decoration from your OUTPUT. Never add **, *, _, #, or backticks.
4. If the same text appears twice because panels overlap, output it ONCE.

HEADER RULES:
5. Emit every prominent English business/organization/outlet name near the receipt header as HEADER, in visual top-to-bottom order.
6. Include both parent/legal entity and customer-facing outlet if both exist. The Worker will choose the actual store.
7. Exclude address-only lines, phone, TRN, TAX INVOICE, invoice/order/customer number, payment provider and QR labels from HEADER.

DATE RULES:
8. Emit every meaningful printed date as DATE_LINE with its printed label, for example:
   DATE_LINE|Date|31-07-2026
   DATE_LINE|Delv.Date|02-08-2026
9. Preserve the date EXACTLY in printed order. Never swap day and month.
10. Do not convert 02-08-2026 to 2026-02-08.

MONEY / COUNT RULES:
11. Emit every labeled monetary summary as MONEY, not only fields you recognize. Examples of labels: Excl.VAT, VAT 5%, Grand Total, Total, Gross, G.Amt, Tax, Adv, Bal.Amt, Net W/Out Tax, Service Fees, Discount, Outstanding Balance.
12. If a percent is printed, emit PERCENT too, e.g. PERCENT|VAT|5.
13. Emit printed counters as COUNT_LINE with their exact label: Total item, No. of Items, T.Pcs, Total Qty, etc. Do NOT decide whether it means rows or pieces.

ITEM RULES:
14. Emit ONE ITEM line for EVERY DISTINCT purchasable row.
15. Keep English and Arabic item names literally. If one language is absent, leave that field empty.
16. quantity / unit price / line total must belong to the SAME row.
17. If only one money column exists, put it in line total and leave unit price empty.
18. Never create ITEM rows from VAT, totals, balance, advance, payment method, dates, TRN, customer/order numbers, table headings, booked-by or terms & conditions.
19. If any value is unreadable, leave that field empty rather than guessing.`;

function headers(extra={}){return {'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra}}
function txt(v){return v==null?'':String(v).replace(/\r/g,'').trim()}
function stripMarks(v){return txt(v).replace(/[*_#`~]+/g,' ').replace(/[“”<>]+/g,' ').replace(/\s+/g,' ').trim()}
function num(v){
  if(v===null||v===undefined||v==='')return null;
  const s=String(v).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/٫/g,'.').replace(/٬/g,'').replace(/[^0-9.\-]/g,'');
  const n=Number(s);return Number.isFinite(n)?n:null
}
function r2(v){const n=num(v);return n==null?null:Math.round((n+Number.EPSILON)*100)/100}
function validDate(v){
  let s=txt(v).replace(/[,]+/g,' ').replace(/\s+/g,' ').trim();if(!s)return null;
  let y,m,d,q;
  const numeric=s.match(/(?:^|\b)(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})(?:\b|$)/);
  if(numeric){
    const a=+numeric[1],b=+numeric[2],c=+numeric[3];
    if(String(numeric[1]).length===4){y=a;m=b;d=c}else if(String(numeric[3]).length===4){d=a;m=b;y=c}
  }
  if(!y){
    const mons={jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12};
    if((q=s.match(/(?:^|\b)(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})(?:\b|$)/))){d=+q[1];m=mons[q[2].toLowerCase()];y=+q[3]}
    else if((q=s.match(/(?:^|\b)([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{4})(?:\b|$)/))){m=mons[q[1].toLowerCase()];d=+q[2];y=+q[3]}
  }
  if(!y||!m||!d)return null;const z=new Date(Date.UTC(y,m-1,d));
  if(y<2000||y>2100||z.getUTCFullYear()!==y||z.getUTCMonth()!==m-1||z.getUTCDate()!==d)return null;
  return `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`
}
function merchant(v){
  let s=stripMarks(v).replace(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]+/g,' ').replace(/\s+/g,' ').trim();
  s=s.replace(/^(?:HEADER|STORE|MERCHANT|BUSINESS)\s*(?:\||:|=|-)?\s*/i,'').trim();
  s=s.replace(/\b(?:TAX\s*INVOICE|INVOICE|RECEIPT|JOB\s*ORDER|TRN|MOB(?:ILE)?|TEL(?:EPHONE)?|BILL\s*NO)\b.*$/i,'').trim();
  return /[A-Za-z]{3}/.test(s)?s:null
}
function merchantKey(v){return stripMarks(v).toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim()}
function merchantScore(name,index=0){
  const s=merchant(name);if(!s)return -999;let score=10+Math.max(0,12-index*2);
  if(/\b(pharmacy|laundry|laundromat|dry\s*clean|restaurant|cafe|coffee|bakery|supermarket|hypermarket|grocery|market|salon|barber|clinic|hospital|optical|boutique|store|shop|mart|garage|workshop|tailor|cafeteria|roastery|medical\s+(?:center|centre)|car\s*wash)\b/i.test(s))score+=95;
  else if(/\b(trading|services|electronics|furniture|fashion|jewellery|jewelry|flowers|florist|stationery|typing|printing|rent\s*a\s*car)\b/i.test(s))score+=35;
  if(/\b(branch|sole\s+proprietorship|establishment)\b/i.test(s))score+=12;
  if(/\bfacilit(?:y|ies)\s+management\b/i.test(s))score-=125;
  if(/\b(property|properties|real\s*estate)\s+management\b/i.test(s))score-=75;
  if(/\b(holding|holdings|investment|investments|management)\b/i.test(s))score-=42;
  if(/\b(municipality|building|street|road|mall|payment|payments|bank|visa|mastercard)\b/i.test(s))score-=50;
  if(/\b(tax\s*invoice|invoice|receipt|trn|customer|cashier|bill\s*no|order\s*no)\b/i.test(s))score-=100;
  if(s.length>=5&&s.length<=100)score+=6;return score
}
function chooseMerchant(candidates){
  const all=[],seen=new Set();
  for(const v of candidates||[]){const s=merchant(v),k=merchantKey(s);if(!s||!k||seen.has(k))continue;seen.add(k);all.push(s)}
  let best=null,bestScore=-999;all.forEach((s,i)=>{const sc=merchantScore(s,i);if(sc>bestScore){best=s;bestScore=sc}});return best
}
function dateLabelScore(label){
  const s=stripMarks(label).toLowerCase();let score=0;
  if(/invoice\s*date|transaction\s*date|bill\s*date/.test(s))score+=100;
  else if(/^date$|^date\s*:/.test(s))score+=90;
  else if(/date/.test(s))score+=55;
  if(/delivery|delv|due|expiry|expire|print|pickup|return/.test(s))score-=130;
  if(/time/.test(s))score-=80;return score
}
function chooseDate(candidates){
  let best=null,bestScore=-999;
  (candidates||[]).forEach((x,i)=>{const d=validDate(x.value);if(!d)return;const sc=dateLabelScore(x.label)-i*.1;if(sc>bestScore){best=d;bestScore=sc}});
  return best
}
function moneyLabel(label){return stripMarks(label).toLowerCase().replace(/\s+/g,' ').trim()}
function classifyMoney(cands){
  const rows=(cands||[]).filter(x=>x.amount!=null).map((x,i)=>({...x,label:moneyLabel(x.label),i}));
  const avoid=/balance|bal\.?\s*amt|outstanding|change|cash|card|visa|online|discount\s*point|service\s*fee|discount/;
  function best(test,bonus=0){
    let b=null,bs=-999;for(const x of rows){let s=bonus-iSafe(x.i);if(test(x))s+=100;if(avoid.test(x.label))s-=120;if(s>bs){b=x;bs=s}}return b
  }
  function iSafe(i){return Math.min(10,i*.2)}
  let sub=null,tax=null,total=null,rate=null;
  for(const x of rows){
    const l=x.label;
    if(rate==null){const p=l.match(/(?:vat|tax)[^0-9]{0,5}(\d+(?:\.\d+)?)\s*%/);if(p)rate=num(p[1])}
    if(!sub&&/(excl\.?\s*vat|net\s*w\/?out\s*tax|net\s*without\s*tax|subtotal|sub\s*total|g\.?\s*amt|net\s*amount)/.test(l))sub=x.amount;
    if(!tax&&/(vat\s*amount|^tax$|^vat(?:\s*\d+(?:\.\d+)?\s*%)?$)/.test(l))tax=x.amount;
  }
  const grand=rows.filter(x=>/(grand\s*total|gross|amount\s*due|final\s*total|total\s*payable|net\s*payable)/.test(x.label)&&!avoid.test(x.label));
  if(grand.length)total=grand[0].amount;
  if(total==null){const exact=rows.filter(x=>/^total$/.test(x.label));if(exact.length)total=exact[0].amount}
  if(total==null&&sub!=null&&tax!=null){const target=r2(sub+tax);const close=rows.find(x=>!avoid.test(x.label)&&Math.abs(x.amount-target)<=.06&&/(adv|paid|total)/.test(x.label));if(close)total=close.amount}
  if(total==null){const adv=rows.find(x=>/^adv(?:ance)?$/.test(x.label)&&!avoid.test(x.label));if(adv)total=adv.amount}
  if(rate==null){for(const x of (cands||[])){if(x.percent!=null&&/(vat|tax)/i.test(x.label)){rate=x.percent;break}}}
  return {subtotal:sub,tax,total,rate}
}
function summaryName(s){return /^(?:vat|tax|subtotal|sub\s*total|excl\.?\s*vat|grand\s*total|gross|g\.?\s*amt|total|balance|bal\.?\s*amt|outstanding|amount\s*due|total\s*item|t\.?\s*pcs|cash|card|change|trn|invoice|job\s*order|ضريبة|الإجمالي|الاجمالي|المجموع)/i.test(stripMarks(s))}
function cleanItem(v){return stripMarks(v).replace(/^[|:;,\-\s]+|[|:;,\-\s]+$/g,'').replace(/\s+/g,' ').trim()}
function nameKey(v){return cleanItem(v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim()}
function tokenSim(a,b){
  const A=new Set(nameKey(a).split(' ').filter(x=>x.length>1)),B=new Set(nameKey(b).split(' ').filter(x=>x.length>1));if(!A.size||!B.size)return 0;
  let hit=0;for(const x of A)if(B.has(x))hit++;return hit/Math.max(A.size,B.size)
}
function sameMoney(a,b,t=.04){return a!=null&&b!=null&&Math.abs(Number(a)-Number(b))<=t}
function dedupeItems(rows){
  const out=[];for(const row of rows||[]){if(!row?.name||summaryName(row.name))continue;let idx=-1;
    for(let i=0;i<out.length;i++){const x=out[i],q=Number(x.quantity||1)===Number(row.quantity||1),money=sameMoney(x.line_total,row.line_total)||sameMoney(x.unit_price,row.unit_price),sim=Math.max(tokenSim(x.name,row.name),tokenSim(x.name_en||'',row.name_en||''));if(q&&money&&sim>=.50){idx=i;break}}
    if(idx<0){out.push({...row});continue}const x=out[idx];if(!x.name_en&&row.name_en)x.name_en=row.name_en;if(!x.name_ar&&row.name_ar)x.name_ar=row.name_ar;if(x.unit_price==null&&row.unit_price!=null)x.unit_price=row.unit_price;if(x.line_total==null&&row.line_total!=null)x.line_total=row.line_total;x.name=x.name_en&&x.name_ar?`${x.name_en} — ${x.name_ar}`:(x.name_en||x.name_ar||x.name)
  }return out
}
function responseText(result){
  if(typeof result==='string')return result;const c=[result?.response,result?.answer,result?.result,result?.choices?.[0]?.message?.content,result?.choices?.[0]?.text];
  for(const v of c){if(typeof v==='string'&&v.trim())return v;if(Array.isArray(v)){const t=v.map(x=>typeof x==='string'?x:(x?.text||x?.content||'')).join('\n').trim();if(t)return t}}return ''
}
function parseProtocol(rawText){
  const raw=txt(rawText).replace(/```(?:text|txt)?/gi,'').replace(/```/g,'');
  const lines=raw.split(/\n+/).map(x=>stripMarks(x)).filter(Boolean);
  const headersOut=[],dates=[],money=[],counts=[],items=[];
  for(const line of lines){
    const p=line.split('|').map(x=>x.trim()),key=(p[0]||'').toUpperCase().replace(/\s+/g,'_');
    if(key==='HEADER'){const h=merchant(p.slice(1).join('|'));if(h)headersOut.push(h);continue}
    if(key==='DATE_LINE'){dates.push({label:p[1]||'',value:p.slice(2).join('|')});continue}
    if(key==='MONEY'){const a=r2(p.slice(2).join('|'));if(a!=null)money.push({label:p[1]||'',amount:a});continue}
    if(key==='PERCENT'){const q=num(p.slice(2).join('|'));if(q!=null)money.push({label:p[1]||'',percent:q});continue}
    if(key==='COUNT_LINE'){const q=num(p.slice(2).join('|'));if(q!=null)counts.push({label:p[1]||'',value:Math.round(q)});continue}
    if(key==='ITEM'){
      const en=cleanItem(p[1]),ar=cleanItem(p[2]);let qty=num(p[3]),unit=r2(p[4]),total=r2(p[5]);
      if(!Number.isFinite(qty)||qty<=0||qty>999)qty=1;const name=en&&ar?`${en} — ${ar}`:(en||ar);if(!name||summaryName(name))continue;
      if(total==null&&unit!=null)total=r2(unit*qty);if(unit==null&&total!=null&&qty)unit=r2(total/qty);
      items.push({name,name_en:en||null,name_ar:ar||null,quantity:qty,unit_price:unit,line_total:total});continue
    }
  }
  const fin=classifyMoney(money),deduped=dedupeItems(items),quantitySum=Math.round(deduped.reduce((s,x)=>s+(Number(x.quantity)||0),0)*100)/100;
  let rowCount=null,pieces=null;
  for(const c of counts){const l=stripMarks(c.label).toLowerCase();if(/t\.?\s*pcs|pieces|total\s*qty|total\s*quantity|qty\s*total/.test(l)){pieces=c.value;continue}if(/total\s*item|no\.?\s*of\s*items|number\s*of\s*items|#\s*items|items\s*count/.test(l)){rowCount=c.value;continue}}
  if(pieces==null){const c=counts.find(x=>Math.abs(x.value-quantitySum)<.01&&x.value!==deduped.length);if(c)pieces=c.value}
  if(rowCount==null){const c=counts.find(x=>x.value===deduped.length&&!/pcs|pieces|qty|quantity/i.test(x.label));if(c)rowCount=c.value}
  return {out:{store:chooseMerchant(headersOut),date:chooseDate(dates),count:rowCount,pieces,rate:fin.rate,subtotal:fin.subtotal,tax:fin.tax,total:fin.total,items:deduped,warnings:[],headers:headersOut,dates,money,counts},lines,raw}
}
function validate(parsed){
  const r=parsed.out,warnings=[];const itemSum=r2(r.items.reduce((s,x)=>s+(x.line_total??0),0)),quantitySum=Math.round(r.items.reduce((s,x)=>s+(Number(x.quantity)||0),0)*100)/100;
  if(r.count!=null&&r.count!==r.items.length)warnings.push(`Printed item-row count is ${r.count}, but ${r.items.length} rows were extracted`);
  if(r.pieces!=null&&Math.abs(r.pieces-quantitySum)>.01)warnings.push(`Printed pieces are ${r.pieces}, but quantity sum is ${quantitySum}`);
  if(r.subtotal!=null&&r.tax!=null&&r.total!=null&&Math.abs(r.subtotal+r.tax-r.total)>.07)warnings.push('Subtotal + VAT does not match total');
  if(r.rate!=null&&r.rate>0&&r.rate<30&&r.subtotal!=null&&r.tax!=null&&Math.abs(r.subtotal*r.rate/100-r.tax)>.07)warnings.push('VAT amount does not match VAT rate');
  const matchSub=r.items.length&&r.subtotal!=null&&Math.abs(itemSum-r.subtotal)<=.20,matchTotal=r.items.length&&r.total!=null&&Math.abs(itemSum-r.total)<=.20;
  if(r.items.length&&r.total!=null&&!matchSub&&!matchTotal)warnings.push('Item row sum does not match labeled totals');
  if(r.total!=null&&r.rate!=null&&r.rate>0&&r.rate<30){const ds=r2(r.total/(1+r.rate/100)),dt=r2(r.total-ds);const bad=r.subtotal==null||r.tax==null||Math.abs((r.subtotal+r.tax)-r.total)>.07;if(bad&&(r.subtotal==null||Math.abs(r.subtotal-ds)<=.18)&&(r.tax==null||Math.abs(r.tax-dt)<=.18)){r.subtotal=ds;r.tax=dt;warnings.push('Financial fields reconciled from total and VAT rate')}}
  const rowOk=r.count==null||r.count===r.items.length,piecesOk=r.pieces==null||Math.abs(r.pieces-quantitySum)<.01,financeOk=r.total!=null&&!warnings.some(x=>/Subtotal \+ VAT does not match/i.test(x)),arithmetic=matchSub||matchTotal;
  const pricedRows=r.items.filter(x=>x.line_total!=null).length,allRowsPriced=r.items.length>0&&pricedRows===r.items.length;
  const itemMoneyOk=!allRowsPriced||r.total==null||arithmetic;
  const accepted=r.items.length>0&&financeOk&&piecesOk&&itemMoneyOk&&(rowOk||arithmetic),complete=accepted&&!!r.store&&!!r.date;
  if(accepted&&!r.store)warnings.push('Merchant name needs manual review');if(accepted&&!r.date)warnings.push('Invoice date needs manual review');
  let score=0;if(r.store)score+=18;if(r.date)score+=14;if(r.items.length)score+=34;if(r.total!=null)score+=18;if(r.subtotal!=null)score+=6;if(r.tax!=null)score+=5;if(rowOk||piecesOk)score+=5;score=Math.min(100,score);
  return {receipt:{merchant_name_en:r.store,date:r.date,printed_item_count:r.count,printed_piece_count:r.pieces,vat_rate_percent:r.rate,currency:'AED',subtotal:r.subtotal,tax:r.tax,total:r.total,items:r.items,confidence:{merchant:r.store?0.88:0,date:r.date?0.88:0,items:r.items.length?0.86:0,totals:r.total!=null?0.92:0},warnings:[...new Set(warnings)].slice(0,14),item_sum:itemSum,quantity_sum:quantitySum},score,accepted,complete,fields:[r.store,r.date,r.subtotal,r.tax,r.total,r.items.length].filter(v=>v!==null&&v!==undefined&&v!=='').length}
}
function validImage(v){return typeof v==='string'&&v.startsWith('data:image/')&&v.length<7_000_000}
async function readReceipt(env,image){
  const result=await env.AI.run(MODEL,{prompt:PROMPT,image,max_tokens:1400,temperature:0,stream:false});
  const raw=responseText(result);if(!raw)throw new Error('Vision model returned no text');const parsed=parseProtocol(raw),checked=validate(parsed);checked.transcript_lines=parsed.lines.length;checked.transcript_preview=parsed.raw.slice(0,1500);return checked
}
export default {async fetch(request,env){
  const url=new URL(request.url);
  if(url.pathname==='/api/health')return new Response(JSON.stringify({ok:true,engine:'Cloudflare Workers AI • Universal Evidence OCR',model:MODEL,version:VERSION,base:'4.4.0'}),{headers:headers()});
  if(url.pathname==='/api/receipt'){
    if(request.method!=='POST')return new Response(JSON.stringify({ok:false,error:'Method not allowed'}),{status:405,headers:headers()});
    const started=Date.now(),scanId=crypto.randomUUID().slice(0,8);try{const body=await request.json(),image=body?.image;if(!validImage(image))return new Response(JSON.stringify({ok:false,error:'One composite receipt image is required'}),{status:400,headers:headers()});const result=await readReceipt(env,image);return new Response(JSON.stringify({ok:true,...result,meta:{engine:'Cloudflare Workers AI • Universal Evidence OCR',model:MODEL,version:VERSION,base:'4.4.0',scan_id:scanId,elapsed_ms:Date.now()-started,images:1,inference_calls:1}}),{headers:headers()})}catch(e){console.error('receipt-reader',e);const msg=e?.message||'Receipt analysis failed',retriable=/load failed|timeout|timed out|out of capacity|3040|3007|3008|temporar|aborted/i.test(msg);return new Response(JSON.stringify({ok:false,error:msg,retriable,meta:{version:VERSION,scan_id:scanId,elapsed_ms:Date.now()-started}}),{status:500,headers:headers()})}
  }
  if(url.pathname==='/api/license'){const h=`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:-apple-system,Arial;padding:32px;line-height:1.8"><h2>رخصة Meta Llama</h2><p>الإصدار ${VERSION} مبني على محرك 4.4.0 نفسه. إذا سبق أن وافقت على الرخصة فلا تحتاج الموافقة مرة أخرى.</p><p><a href="https://ai.cloudflare.com/" target="_blank">فتح Workers AI</a></p><p><a href="/">العودة للموقع</a></p></body></html>`;return new Response(h,{headers:{'content-type':'text/html; charset=utf-8'}})}
  return env.ASSETS.fetch(request)
}};
