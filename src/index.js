const MODEL = '@cf/google/gemma-4-26b-a4b-it';
const VERSION = '4.2.1';

const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    merchant_name_en: { type: 'string' },
    invoice_date: { type: 'string' },
    printed_item_count: { type: 'number' },
    vat_rate_percent: { type: 'number' },
    currency: { type: 'string' },
    subtotal: { type: 'number' },
    tax: { type: 'number' },
    total: { type: 'number' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name_en: { type: 'string' },
          name_ar: { type: 'string' },
          quantity: { type: 'number' },
          unit_price: { type: 'number' },
          line_total: { type: 'number' }
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

const PROMPT = `You are a high-precision literal OCR engine for UAE receipts.

The single image is a COMPOSITE with three labeled panels from the SAME receipt:
LEFT = HEADER / merchant / invoice date.
CENTER = ITEM TABLE / all purchase rows.
RIGHT = TOTAL ITEM / Excl.VAT / VAT / Grand Total.

Return ONLY the requested JSON schema.

STRICT TRANSCRIPTION RULES:
- Copy visible text literally. Do not translate, autocorrect, beautify or invent.
- merchant_name_en: ONLY the English business name at the top. Exclude address, mall, phone, TRN, TAX INVOICE, JOB ORDER and identifiers.
- invoice_date: transaction/invoice Date, NOT Delivery Date or Print Time. Use YYYY-MM-DD. If unclear return "".
- For every item row: copy English into name_en and Arabic into name_ar exactly as visible. If a language is absent use "".
- quantity, unit_price and line_total must belong to the SAME row.
- Exclude VAT, subtotal, total, balance, Total item, payment rows, order numbers and dates from items.
- printed_item_count: value printed by "Total item". Use 0 if not visible.
- subtotal: amount explicitly labeled Excl.VAT / subtotal before VAT.
- tax: VAT amount, not percentage.
- vat_rate_percent: printed VAT percentage, or -1 if not visible.
- total: Grand Total / final payable amount, preferring Grand Total over Outstanding Balance.
- currency: AED when shown or clearly UAE currency, otherwise "".
- Read decimal points character-by-character. 12.00, 0.60 and 12.60 are different.
- Unknown monetary numbers must be -1, not guessed.
- Unknown quantity may be 0.
- Confidence fields are 0..1 and must be conservative.`;

function headers(extra={}) {
  return {'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra};
}
function clamp(v){const n=Number(v);return Number.isFinite(n)?Math.max(0,Math.min(1,n)):0}
function r2(v){const n=Number(v);return Number.isFinite(n)&&n>=0?Math.round((n+Number.EPSILON)*100)/100:null}
function text(v){return v==null?'':String(v).replace(/\s+/g,' ').trim()}
function validDate(v){
  const s=text(v); if(!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y,m,d]=s.split('-').map(Number),z=new Date(Date.UTC(y,m-1,d));
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
function parseAiObject(result){
  if(result?.response && typeof result.response==='object') return result.response;
  if(result?.answer && typeof result.answer==='object') return result.answer;
  if(result && typeof result==='object' && !Array.isArray(result) && !result.response && !result.answer) return result;
  const s=text(result?.response ?? result?.answer ?? result);
  try{return JSON.parse(s)}catch{}
  const a=s.indexOf('{'),b=s.lastIndexOf('}');
  if(a>=0&&b>a)return JSON.parse(s.slice(a,b+1));
  throw new Error('AI did not return valid structured JSON');
}
function sanitize(raw){
  const items=[];
  for(const row of Array.isArray(raw?.items)?raw.items:[]){
    const en=text(row?.name_en), ar=text(row?.name_ar), name=en&&ar?`${en} — ${ar}`:(en||ar);
    if(!name||summaryName(name))continue;
    let qty=Number(row?.quantity); if(!Number.isFinite(qty)||qty<=0||qty>999)qty=1;
    let unit=r2(row?.unit_price), line=r2(row?.line_total);
    if(line==null&&unit!=null)line=Math.round(unit*qty*100)/100;
    if(unit==null&&line!=null&&qty)unit=Math.round(line/qty*100)/100;
    items.push({name,name_en:en||null,name_ar:ar||null,quantity:qty,unit_price:unit,line_total:line});
  }
  const count=Number(raw?.printed_item_count)>0?Math.round(Number(raw.printed_item_count)):null;
  const rate=Number(raw?.vat_rate_percent)>=0?Number(raw.vat_rate_percent):null;
  let subtotal=r2(raw?.subtotal),tax=r2(raw?.tax),total=r2(raw?.total);
  const warnings=Array.isArray(raw?.warnings)?raw.warnings.map(String).slice(0,12):[];

  // Exact arithmetic repair when Grand Total and a printed VAT rate are available.
  if(total!=null&&rate!=null&&rate>0&&rate<30){
    const ds=Math.round((total/(1+rate/100)+Number.EPSILON)*100)/100;
    const dt=Math.round((total-ds+Number.EPSILON)*100)/100;
    const mismatch=subtotal==null||tax==null||Math.abs((subtotal+tax)-total)>.05||Math.abs(subtotal*rate/100-tax)>.05;
    if(mismatch && (subtotal==null||Math.abs(subtotal-ds)<=.15) && (tax==null||Math.abs(tax-dt)<=.15)){
      subtotal=ds;tax=dt;warnings.push('Financial fields reconciled from Grand Total and printed VAT rate');
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
    confidence.items>=.62&&confidence.totals>=.66&&
    !receipt.warnings.some(x=>/Printed item count|does not match/i.test(x));
  return {receipt,score,accepted};
}
function validImage(v){return typeof v==='string'&&v.startsWith('data:image/')&&v.length<7_000_000}

async function readReceipt(env,image){
  // Official Workers AI vision binding path: image is a top-level input.
  const result=await env.AI.run(MODEL,{
    prompt:PROMPT,
    image,
    response_format:{type:'json_schema',json_schema:RECEIPT_SCHEMA},
    temperature:0,
    max_completion_tokens:1200,
    stream:false
  });
  return sanitize(parseAiObject(result));
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/api/health'){
      if(url.searchParams.get('deep')==='1'){
        try{
          const probe=await env.AI.run(MODEL,{prompt:'Reply with exactly OK',max_completion_tokens:4,temperature:0});
          return new Response(JSON.stringify({ok:true,engine:'Cloudflare Workers AI • Composite Receipt Reader',model:MODEL,version:VERSION,model_ok:true,probe:text(probe?.response??probe)}),{headers:headers()});
        }catch(e){
          return new Response(JSON.stringify({ok:false,engine:'Cloudflare Workers AI • Composite Receipt Reader',model:MODEL,version:VERSION,model_ok:false,error:e?.message||String(e)}),{status:503,headers:headers()});
        }
      }
      return new Response(JSON.stringify({ok:true,engine:'Cloudflare Workers AI • Composite Receipt Reader',model:MODEL,version:VERSION}),{headers:headers()});
    }

    if(url.pathname==='/api/receipt'){
      if(request.method!=='POST')return new Response(JSON.stringify({ok:false,error:'Method not allowed'}),{status:405,headers:headers()});
      const started=Date.now(),scanId=crypto.randomUUID().slice(0,8);
      try{
        const body=await request.json(),image=body?.image;
        if(!validImage(image))return new Response(JSON.stringify({ok:false,error:'One composite receipt image is required'}),{status:400,headers:headers()});
        const result=await readReceipt(env,image);
        return new Response(JSON.stringify({ok:true,...result,meta:{engine:'Cloudflare Workers AI • Composite Receipt Reader',model:MODEL,version:VERSION,scan_id:scanId,elapsed_ms:Date.now()-started,images:1,inference_calls:1}}),{headers:headers()});
      }catch(e){
        console.error('receipt-reader',e);
        return new Response(JSON.stringify({ok:false,error:e?.message||'Receipt analysis failed',meta:{version:VERSION,scan_id:scanId,elapsed_ms:Date.now()-started}}),{status:500,headers:headers()});
      }
    }
    return env.ASSETS.fetch(request);
  }
};
