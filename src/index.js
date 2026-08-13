const MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const VERSION = '4.3.3';

const PROMPT = `You are a literal OCR transcriber for UAE receipts. Read the supplied composite image.

The composite contains three FULL-WIDTH horizontal panels from the SAME receipt:
- TOP: merchant/header and invoice date. Read STORE and DATE carefully.
- MIDDLE: item table. Read every purchase row.
- BOTTOM: totals/VAT area.

Do NOT return JSON. Return ONLY plain text lines using this exact protocol:

STORE|English merchant name
DATE|YYYY-MM-DD
COUNT|number
VAT_RATE|number
SUBTOTAL|number
VAT|number
TOTAL|number
ITEM|English item text|Arabic item text|quantity|unit price|line total
ITEM|English item text|Arabic item text|quantity|unit price|line total

Rules:
1. Emit ONE ITEM line for EVERY visible purchasable row. If "Total item: 3" is visible, there must be exactly 3 ITEM lines.
2. Copy item names literally. Never translate or spell-correct. Use an empty field if one language is absent.
3. Never include VAT, totals, balance, dates, TRN, order number or headings as items.
4. DATE is the invoice/transaction Date, not Delivery Date or Print Time.
5. STORE is only the English business name, excluding address/phone/TRN/TAX INVOICE/JOB ORDER.
6. Read decimal amounts character by character. 12.00, 0.60 and 12.60 are different.
7. If a value is unreadable, leave that field empty rather than guessing.
8. No markdown, no commentary, no code fence. Only protocol lines.`;

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
  const out={store:null,date:null,count:null,rate:null,subtotal:null,tax:null,total:null,items:[],warnings:[]};
  const lines=raw.split(/\n+/).map(cleanLine).filter(Boolean);

  for(const line of lines){
    const p=line.split('|').map(x=>x.trim()), key=(p[0]||'').toUpperCase().replace(/\s+/g,'_');
    if(key==='STORE'){out.store=merchant(p.slice(1).join('|'));continue}
    if(key==='DATE'){out.date=validDate(p[1]);continue}
    if(key==='COUNT'){const n=num(p[1]);out.count=n!=null&&n>0?Math.round(n):null;continue}
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
    const biz=lines.find(x=>/(laundr[yv]|laundromat|restaurant|caf[eé]|coffee|bakery|supermarket|hypermarket|grocery|market|pharmacy|salon|barber|trading|services|automatic)/i.test(x)&&!/(near|mall|invoice|receipt|tax|trn|phone|mob)/i.test(x));
    if(biz)out.store=merchant(biz.replace(/^(?:STORE|MERCHANT|BUSINESS)\s*(?:\||:|=|-)?\s*/i,''));
  }
  if(!out.date){
    const m=raw.match(/(?:^|\n)\s*(?:DATE|INVOICE_DATE|INVOICE DATE)\s*(?:\||:|=|-)\s*([^\n]+)/im);
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

  return {out,lines,raw};
}
function validate(parsed){
  const r=parsed.out, warnings=[...r.warnings];
  const itemSum=r2(r.items.reduce((s,x)=>s+(x.line_total??0),0));
  if(r.count!=null&&r.count!==r.items.length)warnings.push(`Printed item count is ${r.count}, but ${r.items.length} rows were extracted`);
  if(r.subtotal!=null&&r.tax!=null&&r.total!=null&&Math.abs(r.subtotal+r.tax-r.total)>.06)warnings.push('Subtotal + VAT does not match Grand Total');
  if(r.rate!=null&&r.rate>0&&r.rate<30&&r.subtotal!=null&&r.tax!=null&&Math.abs(r.subtotal*r.rate/100-r.tax)>.06)warnings.push('VAT amount does not match printed VAT rate');
  if(r.items.length&&r.total!=null&&Math.abs(itemSum-r.total)>.18&&!(r.subtotal!=null&&Math.abs(itemSum-r.subtotal)<=.18))warnings.push('Item row sum does not match labeled totals');

  // Exact financial reconciliation only when total + printed VAT rate support it.
  if(r.total!=null&&r.rate!=null&&r.rate>0&&r.rate<30){
    const ds=r2(r.total/(1+r.rate/100)), dt=r2(r.total-ds);
    const bad=r.subtotal==null||r.tax==null||Math.abs((r.subtotal+r.tax)-r.total)>.05||Math.abs(r.subtotal*r.rate/100-r.tax)>.05;
    if(bad && (r.subtotal==null||Math.abs(r.subtotal-ds)<=.15) && (r.tax==null||Math.abs(r.tax-dt)<=.15)){
      r.subtotal=ds;r.tax=dt;warnings.push('Financial fields reconciled from Grand Total and printed VAT rate');
    }
  }

  const fields=[r.store,r.date,r.subtotal,r.tax,r.total,r.count].filter(v=>v!==null&&v!=='').length;
  let score=0;
  if(r.store)score+=18;if(r.date)score+=14;if(r.items.length)score+=34;if(r.total!=null)score+=18;
  if(r.subtotal!=null)score+=6;if(r.tax!=null)score+=5;
  if(r.count!=null&&r.count===r.items.length)score+=5;
  score=Math.min(100,score);

  const itemCountOk=(r.count==null||r.count===r.items.length);
  const financeOk=r.total!=null&&!warnings.some(x=>/does not match labeled|Subtotal \+ VAT/i.test(x));
  const accepted=r.items.length>0&&itemCountOk&&financeOk;
  const complete=accepted&&!!r.store&&!!r.date;
  if(accepted&&!r.store)warnings.push('Merchant name needs manual review');
  if(accepted&&!r.date)warnings.push('Invoice date needs manual review');

  return {
    receipt:{
      merchant_name_en:r.store,date:r.date,printed_item_count:r.count,vat_rate_percent:r.rate,
      currency:'AED',subtotal:r.subtotal,tax:r.tax,total:r.total,items:r.items,
      confidence:{merchant:r.store?.length?0.82:0,date:r.date?0.85:0,items:r.items.length?0.82:0,totals:r.total!=null?0.9:0},
      warnings:[...new Set(warnings)].slice(0,14),item_sum:itemSum
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
      return new Response(JSON.stringify({ok:true,engine:'Cloudflare Workers AI • Llama Line OCR',model:MODEL,version:VERSION}),{headers:headers()});
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
          meta:{engine:'Cloudflare Workers AI • Llama Line OCR',model:MODEL,version:VERSION,scan_id:scanId,elapsed_ms:Date.now()-started,images:1,inference_calls:1}
        }),{headers:headers()});
      }catch(e){
        console.error('receipt-reader',e);
        return new Response(JSON.stringify({ok:false,error:e?.message||'Receipt analysis failed',meta:{version:VERSION,scan_id:scanId,elapsed_ms:Date.now()-started}}),{status:500,headers:headers()});
      }
    }
    if(url.pathname==='/api/license'){
      const html=`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Llama License</title><body style="font-family:-apple-system,Arial;padding:32px;line-height:1.8;max-width:720px;margin:auto"><h2>رخصة Meta Llama</h2><p>إذا سبق أن وافقت على رخصة Meta لنفس حساب Cloudflare فلا تحتاج الموافقة مرة أخرى.</p><p><a href="https://ai.cloudflare.com/" target="_blank">فتح Workers AI</a></p><p><a href="/">العودة للموقع</a></p></body></html>`;
      return new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}});
    }
    return env.ASSETS.fetch(request);
  }
};