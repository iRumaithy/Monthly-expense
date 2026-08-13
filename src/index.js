const MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const VERSION = '4.5.0';

const PROMPT = `You are a literal OCR transcriber specialized in MANY DIFFERENT UAE receipt and tax-invoice layouts.

The supplied image is a 2x2 UNIVERSAL COMPOSITE made from FOUR OVERLAPPING VERTICAL SLICES of the SAME receipt:
- TOP LEFT = top section
- TOP RIGHT = upper-middle section
- BOTTOM LEFT = lower-middle section
- BOTTOM RIGHT = bottom section
The slices overlap intentionally. Never output the same item twice just because it appears in two slices.

Do NOT return JSON. Return ONLY plain text protocol lines:

HEADER_LINE|prominent English header/business line
HEADER_LINE|another prominent English header/business line
STORE|best customer-facing merchant/trade/store name
DATE_RAW|invoice/transaction date exactly as printed
COUNT|number of DISTINCT ITEM ROWS only if the receipt explicitly labels number of items/rows
PIECES|total pieces / T.Pcs / total quantity only if explicitly printed
VAT_RATE|number
SUBTOTAL|amount before VAT/tax
VAT|tax amount
TOTAL|final payable/gross total
ITEM|English item text|Arabic item text|quantity|unit price|line total
ITEM|English item text|Arabic item text|quantity|unit price|line total

MERCHANT RULES:
1. Transcribe EVERY prominent English business/organization/outlet line near the receipt header as HEADER_LINE, in visual top-to-bottom order.
2. STORE is the CUSTOMER-FACING OUTLET/TRADE NAME that issued the receipt. A parent owner, facilities-management company, landlord, municipality, payment provider or legal administrator is NOT the store when a pharmacy/laundry/shop/restaurant/etc. name is also visible.
3. Example: FACILITIES MANAGEMENT above ALAIN PHARMACY - BRANCH => STORE is ALAIN PHARMACY - BRANCH, but emit both as HEADER_LINE.
4. Exclude address, phone, TRN, TAX INVOICE, customer name, bill number, QR labels and payment-system names from STORE.

DATE RULES:
5. DATE_RAW must be copied EXACTLY as printed. Never swap day and month. 02-08-2026 stays 02-08-2026. Text dates such as 21 Jul 2026 stay in that order.
6. Use transaction/invoice date, not delivery/due/print time.

ITEM RULES:
7. Emit one ITEM line for EVERY DISTINCT purchasable row. If a row appears in overlapping slices, output it ONCE.
8. Copy item names literally; do not translate or spell-correct. Keep English and Arabic in their own fields when visible.
9. quantity and amount must belong to the same row. If only one monetary column exists, put it in line total and leave unit price empty.
10. COUNT means number of item ROWS only. T.Pcs / Total Pieces / Total Qty belongs in PIECES, never COUNT.
11. Exclude VAT, subtotal, totals, balance, advance, booked-by, terms and conditions, dates, TRN, invoice/customer/order numbers and table headings from ITEM rows.

TOTAL RULES:
12. SUBTOTAL labels vary: Excl.VAT, Subtotal, Net W/Out Tax, G.Amt, Net Amount or similar.
13. VAT is tax amount, not percentage.
14. TOTAL is final payable/gross amount. Labels vary: Grand Total, Gross, Total, Amount Due, Adv when it represents the final paid amount. Bal.Amt/Outstanding may be remaining balance and should not replace a clearly printed gross/final total.
15. Read decimals exactly. If unreadable, leave the field empty instead of guessing.
16. No markdown, no commentary, no code fences. Only protocol lines.`;

function headers(extra={}) {
  return {'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra};
}
function txt(v){return v==null?'':String(v).replace(/\r/g,'').trim()}
function num(v){
  if(v===null||v===undefined||v==='')return null;
  const s=String(v)
    .replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/٫/g,'.').replace(/٬/g,'')
    .replace(/[^0-9.\-]/g,'');
  const n=Number(s); return Number.isFinite(n)?n:null;
}
function r2(v){const n=num(v);return n==null?null:Math.round((n+Number.EPSILON)*100)/100}
function clamp(v){const n=Number(v);return Number.isFinite(n)?Math.max(0,Math.min(1,n)):0}
function validDate(v){
  let s=txt(v).trim();
  if(!s)return null;
  let y,m,d,match;
  if((match=s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))){
    y=+match[1];m=+match[2];d=+match[3];
  }else if((match=s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))){
    d=+match[1];m=+match[2];y=+match[3];
  }else{
    const months={jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12};
    match=s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    if(match){d=+match[1];m=months[match[2].toLowerCase()];y=+match[3];}
  }
  if(!y||!m||!d)return null;
  const z=new Date(Date.UTC(y,m-1,d));
  if(y<2000||y>2100||z.getUTCFullYear()!==y||z.getUTCMonth()!==m-1||z.getUTCDate()!==d)return null;
  return `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function merchant(v){
  let s=txt(v).replace(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]+/g,' ').replace(/\s+/g,' ').trim();
  s=s.replace(/\b(?:TAX\s*INVOICE|INVOICE|RECEIPT|JOB\s*ORDER|TRN|MOB(?:ILE)?|TEL(?:EPHONE)?)\b.*$/i,'').trim();
  return /[A-Za-z]{3}/.test(s)?s:null;
}

function merchantKey(v){
  return txt(v).toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
}
function nameKey(v){
  return txt(v).toLowerCase()
    .replace(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g,' ')
    .replace(/\b(?:men|women|man|woman|male|female)\b/g,' ')
    .replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
}
function tokenSimilarity(a,b){
  const A=new Set(nameKey(a).split(' ').filter(x=>x.length>1)),B=new Set(nameKey(b).split(' ').filter(x=>x.length>1));
  if(!A.size||!B.size)return 0;let hit=0;for(const x of A)if(B.has(x))hit++;
  return hit/Math.max(A.size,B.size);
}
function sameMoney(a,b,tol=.03){
  return a!=null&&b!=null&&Math.abs(Number(a)-Number(b))<=tol;
}
function mergeDuplicateItems(rows){
  const out=[];
  for(const row of rows||[]){
    if(!row?.name)continue;
    let found=-1;
    for(let i=0;i<out.length;i++){
      const x=out[i];
      const qsame=Number(x.quantity||1)===Number(row.quantity||1);
      const moneySame=(sameMoney(x.line_total,row.line_total,.04)||sameMoney(x.unit_price,row.unit_price,.04));
      const sim=Math.max(tokenSimilarity(x.name_en||x.name,row.name_en||row.name),tokenSimilarity(x.name,row.name));
      const complement=(!x.name_en&&row.name_en)||(!x.name_ar&&row.name_ar);
      if(qsame&&moneySame&&(sim>=.55||complement)){found=i;break}
    }
    if(found<0){out.push({...row});continue}
    const x=out[found];
    if(!x.name_en&&row.name_en)x.name_en=row.name_en;
    if(!x.name_ar&&row.name_ar)x.name_ar=row.name_ar;
    if(!x.unit_price&&row.unit_price)x.unit_price=row.unit_price;
    if(!x.line_total&&row.line_total)x.line_total=row.line_total;
    x.name=x.name_en&&x.name_ar?`${x.name_en} — ${x.name_ar}`:(x.name_en||x.name_ar||x.name);
  }
  return out;
}
function merchantCandidateScore(name,index=0,preferred=false){
  const s=txt(name),k=merchantKey(s); if(!k||!/^[\s\S]*[a-z]{2}/i.test(k))return -999;
  let score=10 + Math.min(12,index*3);
  if(preferred)score+=18;

  // Strong customer-facing business signals.
  if(/\b(pharmacy|laundry|laundromat|dry\s*clean|restaurant|cafe|coffee|bakery|supermarket|hypermarket|grocery|market|salon|barber|clinic|hospital|optical|boutique|store|shop|mart|garage|workshop|tailor|cafeteria|roastery|medical\s+center|medical\s+centre)\b/i.test(s))score+=72;
  else if(/\b(trading|services|medical|dental|electronics|furniture|fashion|jewellery|jewelry|flowers|florist|stationery|typing|printing|car\s*wash|rent\s*a\s*car)\b/i.test(s))score+=28;

  if(/\bbranch\b/i.test(s))score+=9;
  if(/\b(sole\s+proprietorship|establishment)\b/i.test(s))score+=5;

  // Strong signals that a line is a parent/legal/administrative entity rather than the outlet.
  if(/\bfacilit(?:y|ies)\s+management\b/i.test(s))score-=110;
  if(/\b(property|properties|real\s*estate)\s+management\b/i.test(s))score-=48;
  if(/\b(holding|holdings|investment|investments)\b/i.test(s))score-=42;
  if(/\bmanagement\b/i.test(s))score-=24;
  if(/\b(head\s*office|corporate|parent\s*company)\b/i.test(s))score-=28;
  if(/\b(municipality|building|street|road|mall)\b/i.test(s))score-=35;
  if(/\b(tax\s*invoice|invoice|receipt|trn|customer|cashier|bill\s*no|order\s*no)\b/i.test(s))score-=80;

  // Legal suffixes are neutral, not evidence of being the storefront.
  if(s.length>=5&&s.length<=100)score+=5;
  return score;
}
function chooseMerchant(preferred,candidates){
  const all=[];
  const push=(v,pref=false)=>{
    const s=merchant(v);if(!s)return;
    const key=merchantKey(s);
    if(all.some(x=>x.key===key)){if(pref)all.find(x=>x.key===key).preferred=true;return}
    all.push({name:s,key,preferred:pref,index:all.length});
  };
  push(preferred,true);
  for(const c of candidates||[])push(c,false);
  if(!all.length)return null;
  for(const x of all)x.score=merchantCandidateScore(x.name,x.index,x.preferred);
  all.sort((a,b)=>b.score-a.score);
  return all[0].name;
}

function summaryName(s){
  return /^(?:vat|tax|subtotal|sub\s*total|excl\.?\s*vat|grand\s*total|total|balance|outstanding|amount\s*due|total\s*item|cash|card|change|trn|invoice|job\s*order|ضريبة|الإجمالي|الاجمالي|المجموع)/i.test(txt(s));
}
function responseText(result){
  if(typeof result==='string')return result;
  const candidates=[
    result?.response, result?.answer, result?.result,
    result?.choices?.[0]?.message?.content,
    result?.choices?.[0]?.text
  ];
  for(const c of candidates){
    if(typeof c==='string'&&c.trim())return c;
    if(Array.isArray(c)){
      const t=c.map(x=>typeof x==='string'?x:(x?.text||x?.content||'')).join('\n').trim();
      if(t)return t;
    }
  }
  return '';
}
function cleanLine(s){
  return String(s||'').replace(/^[-*•\s]+/,'').replace(/^`+|`+$/g,'').trim();
}
function parseProtocol(rawText){
  const raw=txt(rawText).replace(/```(?:text|txt)?/gi,'').replace(/```/g,'');
  const out={store:null,storeCandidates:[],headerLines:[],date:null,count:null,pieceCount:null,rate:null,subtotal:null,tax:null,total:null,items:[],warnings:[]};
  const lines=raw.split(/\n+/).map(cleanLine).filter(Boolean);

  for(const line of lines){
    const p=line.split('|').map(x=>x.trim()), key=(p[0]||'').toUpperCase().replace(/\s+/g,'_');
    if(key==='HEADER_LINE'){const h=merchant(p.slice(1).join('|'));if(h)out.headerLines.push(h);continue}
    if(key==='STORE'){out.store=merchant(p.slice(1).join('|'));continue}
    if(key==='STORE_CANDIDATE'){const c=merchant(p.slice(1).join('|'));if(c)out.storeCandidates.push(c);continue}
    if(key==='DATE_RAW'||key==='DATE'){out.date=validDate(p[1]);continue}
    if(key==='COUNT'){const n=num(p[1]);out.count=n!=null&&n>0?Math.round(n):null;continue}
    if(key==='PIECES'){const n=num(p[1]);out.pieceCount=n!=null&&n>0?Math.round(n):null;continue}
    if(key==='VAT_RATE'){const n=num(p[1]);out.rate=n!=null&&n>=0?n:null;continue}
    if(key==='SUBTOTAL'){out.subtotal=r2(p[1]);continue}
    if(key==='VAT'){out.tax=r2(p[1]);continue}
    if(key==='TOTAL'){out.total=r2(p[1]);continue}
    if(key==='ITEM'){
      const en=txt(p[1]), ar=txt(p[2]);
      let qty=num(p[3]), unit=r2(p[4]), total=r2(p[5]);
      if(!Number.isFinite(qty)||qty<=0||qty>999)qty=1;
      const name=en&&ar?`${en} — ${ar}`:(en||ar);
      if(!name||summaryName(name))continue;
      if(total==null&&unit!=null)total=r2(unit*qty);
      if(unit==null&&total!=null&&qty)unit=r2(total/qty);
      out.items.push({name,name_en:en||null,name_ar:ar||null,quantity:qty,unit_price:unit,line_total:total});
    }
  }

  // Conservative label fallbacks if the model slightly misses the protocol delimiter.
  if(!out.store){
    const m=raw.match(/(?:^|\n)\s*(?:STORE|MERCHANT|BUSINESS)\s*(?:\||:|=|-)\s*([^\n]+)/im);
    if(m)out.store=merchant(m[1]);
  }
  if(!out.store){
    const biz=lines.find(x=>/(laundr[yv]|laundromat|restaurant|caf[eé]|coffee|bakery|supermarket|hypermarket|grocery|market|pharmacy|salon|barber|trading|services|automatic|clinic|hospital|optical|shop|store)/i.test(x)&&!/(near|mall|invoice|receipt|tax|trn|phone|mob)/i.test(x));
    if(biz)out.store=merchant(biz.replace(/^(?:STORE|MERCHANT|BUSINESS)\s*(?:\||:|=|-)?\s*/i,''));
  }
  for(const line of lines){
    if(/^(?:STORE_CANDIDATE|HEADER_LINE)\s*\|/i.test(line))continue;
    if(/\b(?:pharmacy|laundry|laundromat|restaurant|cafe|coffee|bakery|supermarket|hypermarket|grocery|market|salon|barber|clinic|hospital|optical|boutique|store|shop|trading|facilities management|holding|management)\b/i.test(line)
      && !/\b(?:tax invoice|invoice|receipt|trn|telephone|mobile|customer|bill no|order no)\b/i.test(line)){
      const c=merchant(line.replace(/^(?:STORE|MERCHANT|BUSINESS|HEADER_LINE)\s*(?:\||:|=|-)?\s*/i,''));
      if(c)out.storeCandidates.push(c);
    }
  }
  if(!out.date){
    const m=raw.match(/(?:^|\n)\s*(?:DATE_RAW|DATE|INVOICE_DATE|INVOICE DATE)\s*(?:\||:|=|-)\s*([^\n]+)/im);
    if(m)out.date=validDate(m[1]);
  }
  if(out.count==null){
    const m=raw.match(/(?:COUNT|TOTAL\s*ITEMS?)\s*(?:\||:|=|-)\s*(\d+)/i);
    if(m)out.count=num(m[1]);
  }
  if(out.rate==null){
    const m=raw.match(/(?:VAT_RATE|VAT\s*RATE|VAT)\s*(?:\||:|=|-)?\s*(\d+(?:\.\d+)?)\s*%/i);
    if(m)out.rate=num(m[1]);
  }
  if(out.total==null){
    const m=raw.match(/(?:GRAND\s*TOTAL|TOTAL)\s*[:=|\-]?\s*(\d+(?:[.,]\d{1,2})?)/i);
    if(m)out.total=r2(m[1]);
  }
  if(out.tax==null){
    const m=raw.match(/\bVAT(?!_RATE)(?:\s*\d+(?:\.\d+)?\s*%)?\s*[:=|\-]?\s*(\d+(?:[.,]\d{1,2})?)/i);
    if(m)out.tax=r2(m[1]);
  }
  if(out.subtotal==null){
    const m=raw.match(/(?:SUBTOTAL|EXCL\.?\s*VAT)\s*[:=|\-]?\s*(\d+(?:[.,]\d{1,2})?)/i);
    if(m)out.subtotal=r2(m[1]);
  }

  out.store=chooseMerchant(out.store,[...out.headerLines,...out.storeCandidates]);
  return {out,lines,raw};
}
function validate(parsed){
  const r=parsed.out, warnings=[...r.warnings];

  // Merge duplicates caused by overlapping tiles or bilingual duplicate rows.
  r.items=mergeDuplicateItems(r.items).filter(x=>{
    const price=x.line_total??x.unit_price;
    if(price==null||Number(price)<0)return false;
    if(summaryName(x.name))return false;
    if(/terms?\s*(?:and|&)\s*conditions?|booked\s*by|advance\s*balance|store\s*timing|change\s*back|customer\s*name|cashier|thank\s*you/i.test(x.name))return false;
    return true;
  });

  const quantitySum=Math.round(r.items.reduce((s,x)=>s+(Number(x.quantity)||0),0)*100)/100;
  const itemSum=r2(r.items.reduce((s,x)=>s+(x.line_total??0),0));
  let pieceCount=r.pieceCount??null;

  // If the model mistakenly placed T.Pcs / total quantity in COUNT, recover automatically.
  if(r.count!=null&&r.count!==r.items.length){
    if(Math.abs(r.count-quantitySum)<.01){
      pieceCount=pieceCount??r.count;
      r.count=null;
      warnings.push('Printed count interpreted as total pieces/quantity, not item-row count');
    }else{
      warnings.push(`Printed item-row count is ${r.count}, but ${r.items.length} rows were extracted`);
    }
  }

  if(r.subtotal!=null&&r.tax!=null&&r.total!=null&&Math.abs(r.subtotal+r.tax-r.total)>.06)
    warnings.push('Subtotal + VAT does not match Grand Total');
  if(r.rate!=null&&r.rate>0&&r.rate<30&&r.subtotal!=null&&r.tax!=null&&Math.abs(r.subtotal*r.rate/100-r.tax)>.06)
    warnings.push('VAT amount does not match printed VAT rate');

  const itemMatchesSubtotal=r.items.length&&r.subtotal!=null&&Math.abs(itemSum-r.subtotal)<=.18;
  const itemMatchesTotal=r.items.length&&r.total!=null&&Math.abs(itemSum-r.total)<=.18;
  if(r.items.length&&r.total!=null&&!itemMatchesSubtotal&&!itemMatchesTotal)
    warnings.push('Item row sum does not match labeled totals');

  // Exact financial reconciliation only when Grand Total and printed VAT rate support it.
  if(r.total!=null&&r.rate!=null&&r.rate>0&&r.rate<30){
    const ds=r2(r.total/(1+r.rate/100)),dt=r2(r.total-ds);
    const bad=r.subtotal==null||r.tax==null||Math.abs((r.subtotal+r.tax)-r.total)>.05||Math.abs(r.subtotal*r.rate/100-r.tax)>.05;
    if(bad&&(r.subtotal==null||Math.abs(r.subtotal-ds)<=.15)&&(r.tax==null||Math.abs(r.tax-dt)<=.15)){
      r.subtotal=ds;r.tax=dt;warnings.push('Financial fields reconciled from Grand Total and printed VAT rate');
    }
  }

  const fields=[r.store,r.date,r.subtotal,r.tax,r.total,r.count??pieceCount].filter(v=>v!==null&&v!==undefined&&v!=='').length;
  let score=0;
  if(r.store)score+=18;if(r.date)score+=14;if(r.items.length)score+=34;if(r.total!=null)score+=18;
  if(r.subtotal!=null)score+=6;if(r.tax!=null)score+=5;
  if(r.count!=null&&r.count===r.items.length)score+=5;
  if(pieceCount!=null&&Math.abs(pieceCount-quantitySum)<.01)score+=5;
  score=Math.min(100,score);

  const rowCountOk=(r.count==null||r.count===r.items.length);
  const arithmeticEvidence=itemMatchesSubtotal||itemMatchesTotal;
  const financeOk=r.total!=null&&!warnings.some(x=>/Subtotal \+ VAT does not match/i.test(x));
  // A printed row count is only one validation signal. Correct financial row sum can prove the rows even when COUNT is absent/misclassified.
  const accepted=r.items.length>0&&financeOk&&(rowCountOk||arithmeticEvidence);
  const complete=accepted&&!!r.store&&!!r.date;
  if(accepted&&!r.store)warnings.push('Merchant name needs manual review');
  if(accepted&&!r.date)warnings.push('Invoice date needs manual review');

  return {
    receipt:{
      merchant_name_en:r.store,date:r.date,printed_item_count:r.count,printed_piece_count:pieceCount,vat_rate_percent:r.rate,
      currency:'AED',subtotal:r.subtotal,tax:r.tax,total:r.total,items:r.items,
      confidence:{merchant:r.store?.length?0.84:0,date:r.date?0.86:0,items:r.items.length?0.84:0,totals:r.total!=null?0.9:0},
      warnings:[...new Set(warnings)].slice(0,14),item_sum:itemSum,quantity_sum:quantitySum
    },
    score,accepted,complete,fields
  };
}
function validImage(v){return typeof v==='string'&&v.startsWith('data:image/')&&v.length<7_000_000}

async function readReceipt(env,image){
  const result=await env.AI.run(MODEL,{
    prompt:PROMPT,
    image,
    max_tokens:1000,
    temperature:0,
    stream:false
  });
  const raw=responseText(result);
  if(!raw)throw new Error('Vision model returned no text');
  const parsed=parseProtocol(raw);
  const checked=validate(parsed);
  checked.transcript_lines=parsed.lines.length;
  checked.transcript_preview=parsed.raw.slice(0,1200);
  return checked;
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/api/health'){
      return new Response(JSON.stringify({ok:true,engine:'Cloudflare Workers AI • Universal Tile Receipt OCR',model:MODEL,version:VERSION}),{headers:headers()});
    }
    if(url.pathname==='/api/receipt'){
      if(request.method!=='POST')return new Response(JSON.stringify({ok:false,error:'Method not allowed'}),{status:405,headers:headers()});
      const started=Date.now(),scanId=crypto.randomUUID().slice(0,8);
      try{
        const body=await request.json(),image=body?.image;
        if(!validImage(image))return new Response(JSON.stringify({ok:false,error:'One composite receipt image is required'}),{status:400,headers:headers()});
        const result=await readReceipt(env,image);
        return new Response(JSON.stringify({
          ok:true,...result,
          meta:{engine:'Cloudflare Workers AI • Universal Tile Receipt OCR',model:MODEL,version:VERSION,scan_id:scanId,elapsed_ms:Date.now()-started,images:1,inference_calls:1}
        }),{headers:headers()});
      }catch(e){
        console.error('receipt-reader',e);
        const msg=e?.message||'Receipt analysis failed';
        const retriable=/load failed|timeout|timed out|out of capacity|3040|3007|3008|temporar|aborted/i.test(msg);
        return new Response(JSON.stringify({ok:false,error:msg,retriable,meta:{version:VERSION,scan_id:scanId,elapsed_ms:Date.now()-started}}),{status:500,headers:headers()});
      }
    }
    if(url.pathname==='/api/license'){
      const html=`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Llama License</title><body style="font-family:-apple-system,Arial;padding:32px;line-height:1.8;max-width:720px;margin:auto"><h2>رخصة Meta Llama</h2><p>إذا سبق أن وافقت على رخصة Meta لنفس حساب Cloudflare فلا تحتاج الموافقة مرة أخرى.</p><p><a href="https://ai.cloudflare.com/" target="_blank">فتح Workers AI</a></p><p><a href="/">العودة للموقع</a></p></body></html>`;
      return new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}});
    }
    return env.ASSETS.fetch(request);
  }
};