const PRIMARY_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const VERIFY_MODEL = '@cf/moonshotai/kimi-k2.6';
const VERSION = '4.1.0';

const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    merchant_name_en: { type: ['string','null'] },
    invoice_date: { type: ['string','null'], description: 'YYYY-MM-DD only when clearly visible' },
    printed_item_count: { type: ['number','null'] },
    vat_rate_percent: { type: ['number','null'] },
    currency: { type: ['string','null'] },
    subtotal: { type: ['number','null'] },
    tax: { type: ['number','null'] },
    total: { type: ['number','null'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name_en: { type: ['string','null'] },
          name_ar: { type: ['string','null'] },
          quantity: { type: ['number','null'] },
          unit_price: { type: ['number','null'] },
          line_total: { type: ['number','null'] }
        },
        required: ['name_en','name_ar','quantity','unit_price','line_total']
      }
    },
    confidence: {
      type: 'object',
      additionalProperties: false,
      properties: {
        merchant: { type: 'number' },
        date: { type: 'number' },
        items: { type: 'number' },
        totals: { type: 'number' }
      },
      required: ['merchant','date','items','totals']
    },
    warnings: { type: 'array', items: { type: 'string' } }
  },
  required: ['merchant_name_en','invoice_date','printed_item_count','vat_rate_percent','currency','subtotal','tax','total','items','confidence','warnings']
};

const SYSTEM_PROMPT = `You are a high-precision UAE receipt transcription engine. Your job is literal visual reading, not guessing.
The receipt may contain Arabic and English on the same row. Copy only what is visibly printed.
Never translate Arabic into English or English into Arabic. Never rewrite, normalize, spell-correct, or invent merchant/item text.
For numbers, distinguish decimal points carefully. Read 12.60 as 12.60, never 1260, 12.09, or 12.6 unless that is what is printed.
If a character or number is not sufficiently clear, return null rather than guessing.`;

const USER_PROMPT = `Extract this receipt with extreme care.

MERCHANT:
- merchant_name_en = ONLY the English business name near the top of the receipt.
- Exclude address, mall/location, phone, TRN, TAX INVOICE, JOB ORDER, branch text, customer text and identifiers.

DATE:
- invoice_date = the transaction/invoice Date, not Delivery Date, Print Time, due date or order date.
- Return YYYY-MM-DD only when the year/month/day are visually clear.

ITEMS:
- Detect the actual item/service table and every purchasable row.
- name_en = exact English item text printed in that row, or null if no English is printed.
- name_ar = exact Arabic item text printed in that row, or null if no Arabic is printed.
- Do not include VAT, Subtotal, Total, Balance, Cash, Card, TRN, order numbers, dates or Total item as items.
- quantity, unit_price, line_total must come from the SAME row.
- printed_item_count = the explicitly printed count such as “Total item: 3” when visible; otherwise null.

TOTALS:
- subtotal = amount explicitly labeled before VAT / Excl.VAT / subtotal.
- tax = VAT/tax amount, not the VAT percentage.
- vat_rate_percent = the printed VAT percentage if visible.
- total = Grand Total / final payable total.
- currency = AED when shown or clearly indicated by UAE currency notation.

CONFIDENCE:
- Use 0..1 and be conservative.
- If text is blurry or partially obscured, confidence must be low and the uncertain field should be null rather than guessed.`;

const VERIFY_PROMPT = `The first extraction failed one or more structural checks. Re-read the receipt from scratch using the supplied original and focused crops.
Prioritize literal transcription over completion.
Critical checks:
1) English merchant name only, copied exactly from the top business-name line.
2) Invoice Date, NOT delivery date.
3) Read every item row. If “Total item: N” is visible, items.length should equal N.
4) Copy Arabic and English item names separately exactly as printed; never translate.
5) Read decimal amounts character-by-character. Check VAT percentage and the labeled Excl.VAT / VAT / Grand Total lines.
6) Do not use the first extraction as truth; it is only a list of fields that need verification.
Return the schema exactly.`;

function jsonHeaders(extra={}) {
  return {'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra};
}
function clamp01(v){const n=Number(v);return Number.isFinite(n)?Math.max(0,Math.min(1,n)):0}
function round2(n){return n==null?null:Math.round((Number(n)+Number.EPSILON)*100)/100}
function toNumber(v){
  if(v===null||v===undefined||v==='')return null;
  if(typeof v==='number')return Number.isFinite(v)?v:null;
  const s=String(v).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/٫/g,'.').replace(/٬/g,'').replace(/[^0-9.,-]/g,'').replace(/,(?=\d{1,2}$)/,'.');
  const n=Number(s);return Number.isFinite(n)?n:null;
}
function cleanText(v){return v==null?null:String(v).replace(/\s+/g,' ').trim()||null}
function merchantEnglish(v){
  let s=cleanText(v);if(!s)return null;
  s=s.replace(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]+/g,' ').replace(/\s+/g,' ').trim();
  s=s.replace(/\b(?:TAX\s*INVOICE|INVOICE|RECEIPT|JOB\s*ORDER|TRN|MOB(?:ILE)?|TEL(?:EPHONE)?)\b.*$/i,'').trim();
  return /[A-Za-z]{3}/.test(s)?s:null;
}
function itemName(row){
  const en=cleanText(row?.name_en), ar=cleanText(row?.name_ar);
  if(en&&ar)return `${en} — ${ar}`;
  return en||ar||'';
}
function isSummaryName(name){return /^(?:vat|tax|subtotal|sub\s*total|excl\.?\s*vat|grand\s*total|total|balance|amount\s*due|total\s*item|cash|card|change|trn|invoice|job\s*order|ضريبة|الإجمالي|الاجمالي|المجموع|المبلغ\s*المستحق)/i.test(String(name||'').trim())}
function validIsoDate(v){
  const s=cleanText(v);if(!s||!/^\d{4}-\d{2}-\d{2}$/.test(s))return null;
  const [y,m,d]=s.split('-').map(Number);const dt=new Date(Date.UTC(y,m-1,d));
  if(dt.getUTCFullYear()!==y||dt.getUTCMonth()!==m-1||dt.getUTCDate()!==d)return null;
  if(y<2000||y>2100)return null;return s;
}
function extractObject(result){
  if(result==null)throw new Error('AI returned empty response');
  if(result.response&&typeof result.response==='object')return result.response;
  if(result.answer&&typeof result.answer==='object')return result.answer;
  if(typeof result==='object'&&!Array.isArray(result)&&!result.response&&!result.answer)return result;
  const text=String(result.response??result.answer??result).trim();
  try{return JSON.parse(text)}catch{}
  const fenced=text.match(/```(?:json)?\s*([\s\S]*?)```/i);if(fenced){try{return JSON.parse(fenced[1])}catch{}}
  const a=text.indexOf('{'),b=text.lastIndexOf('}');if(a>=0&&b>a)return JSON.parse(text.slice(a,b+1));
  throw new Error('AI response was not valid JSON');
}
function sanitize(raw){
  const warnings=Array.isArray(raw?.warnings)?raw.warnings.map(String).slice(0,20):[];
  const items=[];
  for(const row of Array.isArray(raw?.items)?raw.items:[]){
    const name=itemName(row);if(!name||isSummaryName(name))continue;
    let qty=toNumber(row.quantity),unit=toNumber(row.unit_price),line=toNumber(row.line_total);
    if(qty!=null&&(qty<=0||qty>999))qty=null;if(qty==null)qty=1;
    if(unit!=null&&(unit<0||unit>1e6))unit=null;if(line!=null&&(line<0||line>1e6))line=null;
    if(line==null&&unit!=null)line=round2(unit*qty);if(unit==null&&line!=null&&qty)unit=round2(line/qty);
    items.push({name,name_en:cleanText(row.name_en),name_ar:cleanText(row.name_ar),quantity:qty,unit_price:round2(unit),line_total:round2(line)});
  }
  const c=raw?.confidence||{};
  const receipt={
    merchant_name_en:merchantEnglish(raw?.merchant_name_en),
    date:validIsoDate(raw?.invoice_date??raw?.date),
    printed_item_count:toNumber(raw?.printed_item_count),
    vat_rate_percent:toNumber(raw?.vat_rate_percent),
    currency:cleanText(raw?.currency)||'AED',
    subtotal:round2(toNumber(raw?.subtotal)),
    tax:round2(toNumber(raw?.tax)),
    total:round2(toNumber(raw?.total)),
    items,
    confidence:{merchant:clamp01(c.merchant),date:clamp01(c.date),items:clamp01(c.items),totals:clamp01(c.totals)},
    warnings:[...new Set(warnings)]
  };
  reconcile(receipt);
  return receipt;
}
function reconcile(r){
  const itemSum=round2(r.items.reduce((s,x)=>s+(x.line_total??((x.unit_price??0)*(x.quantity??1))),0));r.item_sum=itemSum;
  if(r.printed_item_count!=null&&Math.round(r.printed_item_count)!==r.items.length)r.warnings.push(`Printed item count is ${r.printed_item_count}, but ${r.items.length} rows were extracted`);
  if(r.items.length&&r.total!=null&&itemSum>r.total*1.35)r.warnings.push('Item sum is implausibly above receipt total');
  if(r.subtotal!=null&&r.tax!=null&&r.total!=null&&Math.abs((r.subtotal+r.tax)-r.total)>Math.max(.06,r.total*.008))r.warnings.push('Subtotal + VAT does not match Grand Total');
  const rate=toNumber(r.vat_rate_percent);
  if(rate!=null&&rate>0&&rate<30&&r.subtotal!=null&&r.tax!=null){
    const expected=round2(r.subtotal*rate/100);
    if(Math.abs(expected-r.tax)>Math.max(.06,expected*.08))r.warnings.push('VAT amount does not match printed VAT rate');
  }
  // Conservative arithmetic repair: only when total and a clearly printed VAT rate form a clean 2-decimal split.
  if(rate!=null&&rate>0&&rate<30&&r.total!=null&&r.warnings.some(x=>/VAT amount|Subtotal \+ VAT/i.test(x))){
    const derivedSubtotal=round2(r.total/(1+rate/100)), derivedTax=round2(r.total-derivedSubtotal);
    if(derivedSubtotal!=null&&derivedTax!=null&&Math.abs(derivedSubtotal+derivedTax-r.total)<.011){
      if(r.subtotal!=null&&Math.abs(r.subtotal-derivedSubtotal)<=.15 && r.tax!=null&&Math.abs(r.tax-derivedTax)<=.15){
        r.subtotal=derivedSubtotal;r.tax=derivedTax;r.warnings.push('Financial fields corrected using Grand Total and printed VAT rate');
      }
    }
  }
  r.warnings=[...new Set(r.warnings)].slice(0,20);
}
function score(r){
  let s=0;if(r.merchant_name_en)s+=18*Math.max(.55,r.confidence.merchant);if(r.date)s+=12*Math.max(.55,r.confidence.date);
  if(r.items.length)s+=34*Math.max(.55,r.confidence.items);if(r.total!=null)s+=18*Math.max(.55,r.confidence.totals);if(r.subtotal!=null)s+=6;if(r.tax!=null)s+=5;
  if(r.printed_item_count!=null&&Math.round(r.printed_item_count)===r.items.length)s+=4;if(!r.warnings.some(x=>/does not match|implausibly|Printed item count/i.test(x)))s+=3;
  return Math.round(Math.max(0,Math.min(100,s)));
}
function needsVerify(r){
  return !r.merchant_name_en||!r.date||!r.items.length||r.total==null||r.confidence.merchant<.72||r.confidence.items<.76||r.confidence.totals<.78||
    (r.printed_item_count!=null&&Math.round(r.printed_item_count)!==r.items.length)||r.warnings.some(x=>/does not match|implausibly/i.test(x));
}
function better(a,b){
  if(!b)return a;
  const ac=score(a),bc=score(b);if(bc>ac+2)return b;if(ac>bc+2)return a;
  // Field-wise merge only when verifier has equal/higher confidence.
  const out=JSON.parse(JSON.stringify(a));
  if(b.merchant_name_en&&b.confidence.merchant>=a.confidence.merchant)out.merchant_name_en=b.merchant_name_en;
  if(b.date&&b.confidence.date>=a.confidence.date)out.date=b.date;
  if(b.total!=null&&b.confidence.totals>=a.confidence.totals){out.subtotal=b.subtotal;out.tax=b.tax;out.total=b.total;out.vat_rate_percent=b.vat_rate_percent;}
  if(b.items.length&&b.confidence.items>=a.confidence.items)out.items=b.items;
  if(b.printed_item_count!=null)out.printed_item_count=b.printed_item_count;
  out.confidence={merchant:Math.max(a.confidence.merchant,b.confidence.merchant),date:Math.max(a.confidence.date,b.confidence.date),items:Math.max(a.confidence.items,b.confidence.items),totals:Math.max(a.confidence.totals,b.confidence.totals)};
  out.warnings=[...(a.warnings||[]),...(b.warnings||[])];reconcile(out);return out;
}
async function runStructured(env,model,messages){
  const result=await env.AI.run(model,{messages,response_format:{type:'json_schema',json_schema:RECEIPT_SCHEMA},temperature:0,max_completion_tokens:2600,stream:false});
  return sanitize(extractObject(result));
}
async function primaryRead(env,image){
  const messages=[{role:'system',content:SYSTEM_PROMPT},{role:'user',content:[{type:'text',text:USER_PROMPT},{type:'image_url',image_url:{url:image}}]}];
  return runStructured(env,PRIMARY_MODEL,messages);
}
async function verifyRead(env,images,first){
  const content=[{type:'text',text:`${VERIFY_PROMPT}\n\nFirst extraction for verification only:\n${JSON.stringify(first)}`}];
  for(const img of [images.image,images.header,images.items,images.totals])if(typeof img==='string'&&img.startsWith('data:image/'))content.push({type:'image_url',image_url:{url:img}});
  return runStructured(env,VERIFY_MODEL,[{role:'system',content:SYSTEM_PROMPT},{role:'user',content}]);
}
async function analyze(env,images){
  let first=await primaryRead(env,images.image);let verified=false;
  if(needsVerify(first)){
    try{const second=await verifyRead(env,images,first);first=better(first,second);verified=true}catch(e){first.warnings.push(`Verification pass failed: ${e.message}`)}
  }
  return {receipt:first,score:score(first),verified};
}
function validImage(v){return typeof v==='string'&&v.startsWith('data:image/')&&v.length<8_000_000}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/api/health')return new Response(JSON.stringify({ok:true,engine:'Cloudflare Workers AI',primary_model:PRIMARY_MODEL,verify_model:VERIFY_MODEL,version:VERSION}),{headers:jsonHeaders()});
    if(url.pathname==='/api/receipt'){
      if(request.method==='OPTIONS')return new Response(null,{status:204});
      if(request.method!=='POST')return new Response(JSON.stringify({ok:false,error:'Method not allowed'}),{status:405,headers:jsonHeaders()});
      try{
        const body=await request.json();if(!validImage(body?.image))return new Response(JSON.stringify({ok:false,error:'A valid original receipt image is required'}),{status:400,headers:jsonHeaders()});
        const images={image:body.image,header:validImage(body.header)?body.header:null,items:validImage(body.items)?body.items:null,totals:validImage(body.totals)?body.totals:null};
        const started=Date.now(),result=await analyze(env,images);
        return new Response(JSON.stringify({ok:true,receipt:result.receipt,score:result.score,meta:{engine:'Cloudflare Workers AI',primary_model:PRIMARY_MODEL,verify_model:result.verified?VERIFY_MODEL:null,verified:result.verified,version:VERSION,elapsed_ms:Date.now()-started}}),{headers:jsonHeaders()});
      }catch(error){console.error('Receipt analysis failed',error);return new Response(JSON.stringify({ok:false,error:error?.message||'Receipt analysis failed'}),{status:500,headers:jsonHeaders()});}
    }
    return env.ASSETS.fetch(request);
  }
};
