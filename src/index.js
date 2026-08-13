const MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const VERSION = '4.3.0';

const PROMPT = `You are a high-precision receipt transcription engine for UAE receipts.
Read the supplied image literally. The image is a vertical composite made from the SAME receipt:
PANEL 1 = HEADER / merchant / invoice date.
PANEL 2 = ITEM TABLE / all purchased items or services.
PANEL 3 = TOTALS / Total item / Excl.VAT / VAT / Grand Total.

Return ONLY one valid JSON object, with NO markdown and NO explanation, using exactly:
{
  "merchant_name_en": "",
  "invoice_date": "",
  "printed_item_count": 0,
  "vat_rate_percent": -1,
  "currency": "AED",
  "subtotal": -1,
  "tax": -1,
  "total": -1,
  "items": [
    {
      "name_en": "",
      "name_ar": "",
      "quantity": 0,
      "unit_price": -1,
      "line_total": -1
    }
  ],
  "confidence": {
    "merchant": 0,
    "date": 0,
    "items": 0,
    "totals": 0
  },
  "warnings": []
}

STRICT RULES:
- Do not translate, autocorrect, beautify, normalize or invent printed merchant/item text.
- merchant_name_en = ONLY the English business name near the top. Exclude address, mall/location, phone, TRN, TAX INVOICE, JOB ORDER and identifiers.
- invoice_date = invoice/transaction Date, NOT Delivery Date, Delivery Time, Print Time or order number. Return YYYY-MM-DD only when clear, otherwise "".
- Extract EVERY purchasable item/service row from the item table.
- For each row, name_en and name_ar must be copied from that SAME row. If one language is absent use "".
- quantity, unit_price and line_total must come from the same row.
- Exclude table headers, Total item, VAT, Subtotal, Excl.VAT, Grand Total, Balance, Cash, Card, Change, TRN, invoice number and dates from items.
- printed_item_count = the number explicitly printed beside Total item. Use 0 when not visible.
- subtotal = the amount explicitly labelled Excl.VAT / subtotal before VAT.
- tax = VAT amount, not VAT percentage.
- vat_rate_percent = printed VAT percentage, otherwise -1.
- total = Grand Total / final payable total. Prefer Grand Total over Outstanding Balance.
- Read decimal points digit-by-digit. 12.00, 0.60 and 12.60 are distinct.
- Unknown money values = -1. Unknown quantity = 0.
- Confidence fields must be numbers from 0 to 1 and conservative.
- If Total item says 3, make sure you inspect the item table for exactly 3 purchasable rows before finishing.`;

function jsonHeaders(extra={}) {
  return {'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra};
}
function clamp(v){const n=Number(v);return Number.isFinite(n)?Math.max(0,Math.min(1,n)):0}
function text(v){return v==null?'':String(v).replace(/\s+/g,' ').trim()}
function r2(v){const n=Number(v);return Number.isFinite(n)&&n>=0?Math.round((n+Number.EPSILON)*100)/100:null}
function validDate(v){
  const s=text(v); if(!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y,m,d]=s.split('-').map(Number), z=new Date(Date.UTC(y,m-1,d));
  if(y<2000||y>2100||z.getUTCFullYear()!==y||z.getUTCMonth()!==m-1||z.getUTCDate()!==d)return null;
  return s;
}
function merchant(v){
  let s=text(v).replace(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]+/g,' ').replace(/\s+/g,' ').trim();
  s=s.replace(/\b(?:TAX\s*INVOICE|INVOICE|RECEIPT|JOB\s*ORDER|TRN|MOB(?:ILE)?|TEL(?:EPHONE)?)\b.*$/i,'').trim();
  return /[A-Za-z]{3}/.test(s)?s:null;
}
function summaryName(s){
  return /^(?:vat|tax|subtotal|sub\s*total|excl\.?\s*vat|grand\s*total|total|balance|outstanding|amount\s*due|total\s*item|cash|card|change|trn|invoice|job\s*order|ضريبة|الإجمالي|الاجمالي|المجموع)/i.test(text(s));
}
function extractObject(result){
  const s=text(result?.response ?? result?.answer ?? result);
  if(!s) throw new Error('Vision model returned an empty response');
  try{return JSON.parse(s)}catch{}
  const fenced=s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fenced){try{return JSON.parse(fenced[1].trim())}catch{}}
  const a=s.indexOf('{'), b=s.lastIndexOf('}');
  if(a>=0&&b>a){try{return JSON.parse(s.slice(a,b+1))}catch{}}
  throw new Error('Vision model did not return valid JSON');
}
function sanitize(raw){
  const items=[];
  for(const row of Array.isArray(raw?.items)?raw.items:[]){
    const en=text(row?.name_en), ar=text(row?.name_ar), name=en&&ar?`${en} — ${ar}`:(en||ar);
    if(!name||summaryName(name))continue;
    let qty=Number(row?.quantity);
    if(!Number.isFinite(qty)||qty<=0||qty>999)qty=1;
    let unit=r2(row?.unit_price), line=r2(row?.line_total);
    if(line==null&&unit!=null)line=Math.round(unit*qty*100)/100;
    if(unit==null&&line!=null&&qty)unit=Math.round(line/qty*100)/100;
    items.push({name,name_en:en||null,name_ar:ar||null,quantity:qty,unit_price:unit,line_total:line});
  }

  const count=Number(raw?.printed_item_count)>0?Math.round(Number(raw.printed_item_count)):null;
  const rate=Number(raw?.vat_rate_percent)>=0?Number(raw.vat_rate_percent):null;
  let subtotal=r2(raw?.subtotal), tax=r2(raw?.tax), total=r2(raw?.total);
  const warnings=Array.isArray(raw?.warnings)?raw.warnings.map(String).slice(0,12):[];

  // Receipt arithmetic guard. Do not overwrite clearly different printed values.
  if(total!=null&&rate!=null&&rate>0&&rate<30){
    const ds=Math.round((total/(1+rate/100)+Number.EPSILON)*100)/100;
    const dt=Math.round((total-ds+Number.EPSILON)*100)/100;
    const bad=subtotal==null||tax==null||Math.abs((subtotal+tax)-total)>.05||Math.abs(subtotal*rate/100-tax)>.05;
    if(bad && (subtotal==null||Math.abs(subtotal-ds)<=.12) && (tax==null||Math.abs(tax-dt)<=.12)){
      subtotal=ds; tax=dt; warnings.push('Financial fields reconciled using Grand Total and printed VAT rate');
    }
  }

  const itemSum=Math.round(items.reduce((s,x)=>s+(x.line_total??0),0)*100)/100;
  if(count!=null&&count!==items.length)warnings.push(`Printed item count is ${count}, but ${items.length} rows were extracted`);
  if(subtotal!=null&&tax!=null&&total!=null&&Math.abs(subtotal+tax-total)>.06)warnings.push('Subtotal + VAT does not match Grand Total');
  if(rate!=null&&subtotal!=null&&tax!=null&&Math.abs(subtotal*rate/100-tax)>.06)warnings.push('VAT amount does not match printed VAT rate');
  if(items.length&&total!=null&&Math.abs(itemSum-total)>.18&&!(subtotal!=null&&Math.abs(itemSum-subtotal)<=.18))warnings.push('Item row sum does not match labeled totals');

  const c=raw?.confidence||{};
  const confidence={merchant:clamp(c.merchant),date:clamp(c.date),items:clamp(c.items),totals:clamp(c.totals)};
  const receipt={
    merchant_name_en:merchant(raw?.merchant_name_en),
    date:validDate(raw?.invoice_date),
    printed_item_count:count,
    vat_rate_percent:rate,
    currency:text(raw?.currency)||'AED',
    subtotal,tax,total,items,confidence,
    warnings:[...new Set(warnings)].slice(0,14),
    item_sum:itemSum
  };
  let score=0;
  if(receipt.merchant_name_en)score+=20*Math.max(.5,confidence.merchant);
  if(receipt.date)score+=15*Math.max(.5,confidence.date);
  if(items.length)score+=35*Math.max(.5,confidence.items);
  if(total!=null)score+=20*Math.max(.5,confidence.totals);
  if(subtotal!=null)score+=5;if(tax!=null)score+=5;
  score=Math.round(Math.min(100,score));
  const accepted=!!receipt.merchant_name_en&&!!receipt.date&&items.length>0&&total!=null&&
    confidence.items>=.58&&confidence.totals>=.62&&
    !receipt.warnings.some(x=>/Printed item count|does not match/i.test(x));
  return {receipt,score,accepted};
}
function validImage(v){return typeof v==='string'&&v.startsWith('data:image/')&&v.length<7_000_000}
function isLicenseError(e){
  return /agree|license|acceptable use|meta/i.test(String(e?.message||e||''));
}
async function readReceipt(env,image){
  const result=await env.AI.run(MODEL,{
    messages:[
      {role:'system',content:'You transcribe receipts literally and return only valid JSON.'},
      {role:'user',content:PROMPT}
    ],
    image,
    max_tokens:1800,
    temperature:0.05,
    top_p:0.15,
    stream:false
  });
  return sanitize(extractObject(result));
}
function licensePage(message=''){
  const msg=message?`<p style="color:#9a3531">${message.replace(/[<>&]/g,m=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[m]))}</p>`:'';
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>تفعيل القارئ</title><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Tahoma,Arial;background:#f4eadb;color:#17324d;padding:30px"><main style="max-width:620px;margin:auto;background:#fffaf2;border:1px solid #dfd2bf;border-radius:20px;padding:24px"><h1>تفعيل قارئ Llama Vision</h1><p>يستخدم القارئ نموذج Meta Llama 3.2 Vision على Cloudflare Workers AI. Cloudflare تشترط الموافقة مرة واحدة على رخصة Meta وسياسة الاستخدام المقبول قبل أول استخدام.</p>${msg}<p><a href="https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/LICENSE" target="_blank">عرض رخصة Meta</a></p><form method="post"><input type="hidden" name="accept" value="yes"><button style="border:0;border-radius:14px;background:#17324d;color:white;padding:14px 18px;font-weight:800;font-size:16px">أوافق وأفعّل القارئ</button></form><p style="font-size:13px;color:#777;margin-top:18px">هذه الموافقة تخص حساب Cloudflare مرة واحدة فقط.</p></main></body></html>`;
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);

    if(url.pathname==='/api/license'){
      if(request.method==='GET') return new Response(licensePage(),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
      if(request.method==='POST'){
        try{
          await env.AI.run(MODEL,{prompt:'agree',max_tokens:8});
          return new Response(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:-apple-system;background:#f4eadb;color:#17324d;padding:30px"><main style="max-width:620px;margin:auto;background:#fffaf2;border-radius:20px;padding:24px"><h1>تم التفعيل ✅</h1><p>يمكنك العودة إلى صفحة مصاريف الشهر وتجربة الفاتورة الآن.</p><button onclick="history.back()" style="border:0;border-radius:14px;background:#17324d;color:#fff;padding:14px 18px;font-weight:800">العودة</button></main></body></html>`,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
        }catch(e){
          return new Response(licensePage('تعذر تفعيل النموذج: '+String(e?.message||e)),{status:500,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
        }
      }
      return new Response('Method not allowed',{status:405});
    }

    if(url.pathname==='/api/health'){
      return new Response(JSON.stringify({ok:true,engine:'Cloudflare Workers AI • Llama Vision Receipt Reader',model:MODEL,version:VERSION,license_url:'/api/license'}),{headers:jsonHeaders()});
    }

    if(url.pathname==='/api/receipt'){
      if(request.method!=='POST')return new Response(JSON.stringify({ok:false,error:'Method not allowed'}),{status:405,headers:jsonHeaders()});
      const started=Date.now(),scanId=crypto.randomUUID().slice(0,8);
      try{
        const body=await request.json(),image=body?.image;
        if(!validImage(image))return new Response(JSON.stringify({ok:false,error:'One receipt composite image is required'}),{status:400,headers:jsonHeaders()});
        const result=await readReceipt(env,image);
        return new Response(JSON.stringify({ok:true,...result,meta:{engine:'Cloudflare Workers AI • Llama 3.2 Vision',model:MODEL,version:VERSION,scan_id:scanId,elapsed_ms:Date.now()-started,images:1,inference_calls:1}}),{headers:jsonHeaders()});
      }catch(e){
        console.error('receipt-reader',e);
        const licenseRequired=isLicenseError(e);
        return new Response(JSON.stringify({ok:false,error:e?.message||'Receipt analysis failed',license_required:licenseRequired,license_url:'/api/license',meta:{version:VERSION,scan_id:scanId,elapsed_ms:Date.now()-started}}),{status:licenseRequired?428:500,headers:jsonHeaders()});
      }
    }
    return env.ASSETS.fetch(request);
  }
};
