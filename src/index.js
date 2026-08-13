const MODEL = '@cf/google/gemma-4-26b-a4b-it';
const VERSION = '4.2.0';

const RECEIPT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    merchant_name_en: { type: ['string','null'] },
    invoice_date: { type: ['string','null'], description: 'YYYY-MM-DD only when visually clear' },
    printed_item_count: { type: ['number','null'] },
    vat_rate_percent: { type: ['number','null'] },
    currency: { type: ['string','null'] },
    subtotal: { type: ['number','null'] },
    tax: { type: ['number','null'] },
    total: { type: ['number','null'] },
    items: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        name_en: { type: ['string','null'] },
        name_ar: { type: ['string','null'] },
        quantity: { type: ['number','null'] },
        unit_price: { type: ['number','null'] },
        line_total: { type: ['number','null'] }
      },
      required: ['name_en','name_ar','quantity','unit_price','line_total']
    }},
    confidence: {
      type:'object', additionalProperties:false,
      properties:{merchant:{type:'number'},date:{type:'number'},items:{type:'number'},totals:{type:'number'}},
      required:['merchant','date','items','totals']
    },
    warnings: { type:'array', items:{type:'string'} }
  },
  required:['merchant_name_en','invoice_date','printed_item_count','vat_rate_percent','currency','subtotal','tax','total','items','confidence','warnings']
};

const SYSTEM = `You are a literal multilingual OCR/transcription engine specialized in UAE receipts. Read visible pixels exactly. Arabic and English may appear together. Never translate, autocorrect, normalize, infer missing text, or invent values. If uncertain return null. Decimal points are critical.`;
const PROMPT = `You are given THREE cropped images from the SAME receipt, in this exact order:
IMAGE 1 = receipt HEADER / top area.
IMAGE 2 = ITEM TABLE / purchased services and quantities.
IMAGE 3 = TOTALS / VAT and final amounts.

Read them as one receipt and return the schema only.

HEADER:
- merchant_name_en = exact English business name printed near the top. Exclude address, mall/location, phone, TRN, TAX INVOICE, JOB ORDER and identifiers.
- invoice_date = transaction/invoice Date, NOT Delivery Date or Print Time. Format YYYY-MM-DD only if clear.

ITEM TABLE:
- Extract EVERY purchasable row.
- name_en and name_ar are literal transcriptions from the same row. If only one language exists, the other is null.
- Never translate or spell-correct.
- quantity, unit_price, line_total must come from that same row.
- Exclude VAT, subtotal, total, balance, cash/card, TRN, dates, order numbers and table headings.
- If “Total item: N” is visible, printed_item_count=N. Use it as a cross-check that no row was missed.

TOTALS:
- subtotal = explicitly labeled amount before VAT / Excl.VAT.
- tax = VAT amount, not the percentage.
- vat_rate_percent = printed VAT rate.
- total = Grand Total / final payable amount. Prefer Grand Total over Outstanding Balance.
- currency = AED when printed/clearly indicated.

IMPORTANT: Read decimal amounts character by character. 12.00, 0.60 and 12.60 are three different values. Return null instead of guessing.`;

function headers(){return {'content-type':'application/json; charset=utf-8','cache-control':'no-store'}}
function clamp(v){const x=Number(v);return Number.isFinite(x)?Math.max(0,Math.min(1,x)):0}
function num(v){if(v===null||v===undefined||v==='')return null;const s=String(v).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/٫/g,'.').replace(/٬/g,'').replace(/[^0-9.-]/g,'');const x=Number(s);return Number.isFinite(x)?x:null}
function r2(v){const x=num(v);return x==null?null:Math.round((x+Number.EPSILON)*100)/100}
function text(v){return v==null?null:String(v).replace(/\s+/g,' ').trim()||null}
function validDate(v){const s=text(v);if(!s||!/^\d{4}-\d{2}-\d{2}$/.test(s))return null;const [y,m,d]=s.split('-').map(Number),z=new Date(Date.UTC(y,m-1,d));return y>=2000&&y<=2100&&z.getUTCFullYear()===y&&z.getUTCMonth()===m-1&&z.getUTCDate()===d?s:null}
function merchant(v){let s=text(v);if(!s)return null;s=s.replace(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]+/g,' ').replace(/\s+/g,' ').trim().replace(/\b(?:TAX\s*INVOICE|INVOICE|RECEIPT|JOB\s*ORDER|TRN|MOB(?:ILE)?|TEL(?:EPHONE)?)\b.*$/i,'').trim();return /[A-Za-z]{3}/.test(s)?s:null}
function summary(s){return /^(?:vat|tax|subtotal|sub\s*total|excl\.?\s*vat|grand\s*total|total|balance|amount\s*due|total\s*item|cash|card|change|trn|invoice|job\s*order|ضريبة|الإجمالي|الاجمالي|المجموع)/i.test(String(s||'').trim())}
function itemName(row){const en=text(row?.name_en),ar=text(row?.name_ar);return en&&ar?`${en} — ${ar}`:(en||ar||'')}
function extract(result){if(result==null)throw new Error('AI returned empty response');if(result.response&&typeof result.response==='object')return result.response;if(result.answer&&typeof result.answer==='object')return result.answer;if(typeof result==='object'&&!Array.isArray(result)&&!result.response&&!result.answer)return result;const s=String(result.response??result.answer??result).trim();try{return JSON.parse(s)}catch{}const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a>=0&&b>a)return JSON.parse(s.slice(a,b+1));throw new Error('AI response was not valid JSON')}
function sanitize(raw){
  const items=[];
  for(const row of Array.isArray(raw?.items)?raw.items:[]){
    const name=itemName(row);if(!name||summary(name))continue;
    let qty=num(row.quantity),unit=r2(row.unit_price),line=r2(row.line_total);if(qty==null||qty<=0||qty>999)qty=1;
    if(unit!=null&&(unit<0||unit>1e6))unit=null;if(line!=null&&(line<0||line>1e6))line=null;
    if(line==null&&unit!=null)line=r2(unit*qty);if(unit==null&&line!=null&&qty)unit=r2(line/qty);
    items.push({name,name_en:text(row.name_en),name_ar:text(row.name_ar),quantity:qty,unit_price:unit,line_total:line});
  }
  const subtotal=r2(raw?.subtotal),tax=r2(raw?.tax),total=r2(raw?.total),count=num(raw?.printed_item_count),rate=num(raw?.vat_rate_percent),warnings=Array.isArray(raw?.warnings)?raw.warnings.map(String).slice(0,12):[];
  const c=raw?.confidence||{},confidence={merchant:clamp(c.merchant),date:clamp(c.date),items:clamp(c.items),totals:clamp(c.totals)};
  const itemSum=r2(items.reduce((s,x)=>s+(x.line_total??0),0));
  if(count!=null&&Math.round(count)!==items.length)warnings.push(`Printed item count is ${count}, but ${items.length} rows were extracted`);
  if(subtotal!=null&&tax!=null&&total!=null&&Math.abs(subtotal+tax-total)>.08)warnings.push('Subtotal + VAT does not match Grand Total');
  if(rate!=null&&rate>0&&rate<30&&subtotal!=null&&tax!=null&&Math.abs(subtotal*rate/100-tax)>.08)warnings.push('VAT amount does not match printed VAT rate');
  // Item rows can be VAT-inclusive while Excl.VAT is exclusive, so compare rows against either labeled target.
  if(items.length&&total!=null&&Math.abs(itemSum-total)>.18&&!(subtotal!=null&&Math.abs(itemSum-subtotal)<=.18))warnings.push('Item row sum does not match labeled totals');
  const receipt={merchant_name_en:merchant(raw?.merchant_name_en),date:validDate(raw?.invoice_date),printed_item_count:count,vat_rate_percent:rate,currency:text(raw?.currency)||'AED',subtotal,tax,total,items,confidence,warnings:[...new Set(warnings)],item_sum:itemSum};
  let score=0;if(receipt.merchant_name_en)score+=20*Math.max(.5,confidence.merchant);if(receipt.date)score+=15*Math.max(.5,confidence.date);if(items.length)score+=35*Math.max(.5,confidence.items);if(total!=null)score+=20*Math.max(.5,confidence.totals);if(subtotal!=null)score+=5;if(tax!=null)score+=5;score=Math.round(Math.min(100,score));
  const accepted=!!receipt.merchant_name_en&&!!receipt.date&&items.length>0&&total!=null&&confidence.items>=.65&&confidence.totals>=.68&&!receipt.warnings.some(x=>/Printed item count|does not match/i.test(x));
  return {receipt,score,accepted};
}
function validImage(v){return typeof v==='string'&&v.startsWith('data:image/')&&v.length<7_500_000}

async function readReceipt(env,header,items,totals){
  const content=[{type:'text',text:PROMPT},{type:'image_url',image_url:{url:header}},{type:'image_url',image_url:{url:items}},{type:'image_url',image_url:{url:totals}}];
  const result=await env.AI.run(MODEL,{messages:[{role:'system',content:SYSTEM},{role:'user',content}],response_format:{type:'json_schema',json_schema:RECEIPT_SCHEMA},temperature:0,max_completion_tokens:1200,stream:false});
  return sanitize(extract(result));
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/api/health')return new Response(JSON.stringify({ok:true,engine:'Cloudflare Workers AI • Fast ROI Receipt Reader',model:MODEL,version:VERSION}),{headers:headers()});
    if(url.pathname==='/api/receipt'){
      if(request.method!=='POST')return new Response(JSON.stringify({ok:false,error:'Method not allowed'}),{status:405,headers:headers()});
      const started=Date.now();
      try{
        const body=await request.json(),header=body?.header,items=body?.items,totals=body?.totals;
        if(!validImage(header)||!validImage(items)||!validImage(totals))return new Response(JSON.stringify({ok:false,error:'Three receipt region images are required'}),{status:400,headers:headers()});
        const result=await readReceipt(env,header,items,totals),scanId=crypto.randomUUID().slice(0,8);
        return new Response(JSON.stringify({ok:true,...result,meta:{engine:'Cloudflare Workers AI • Fast ROI Receipt Reader',model:MODEL,version:VERSION,scan_id:scanId,elapsed_ms:Date.now()-started,images:3,inference_calls:1}}),{headers:headers()});
      }catch(e){console.error(e);return new Response(JSON.stringify({ok:false,error:e?.message||'Receipt analysis failed'}),{status:500,headers:headers()})}
    }
    return env.ASSETS.fetch(request)
  }
};
