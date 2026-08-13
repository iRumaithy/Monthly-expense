const MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const VERSION = '4.3.1';

// Deliberately simple schema. Vision models are much more reliable at producing
// a flat object than a deeply nested receipt schema. The Worker parses items_text
// deterministically after the vision call returns.
const SIMPLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    merchant_name_en: { type: 'string' },
    invoice_date: { type: 'string' },
    printed_item_count: { type: 'string' },
    vat_rate_percent: { type: 'string' },
    currency: { type: 'string' },
    subtotal: { type: 'string' },
    tax: { type: 'string' },
    total: { type: 'string' },
    items_text: { type: 'string' }
  },
  required: [
    'merchant_name_en','invoice_date','printed_item_count','vat_rate_percent',
    'currency','subtotal','tax','total','items_text'
  ]
};

const PROMPT = `Read this UAE receipt image literally. The image contains three enlarged panels from the SAME receipt: header/date, item table, and totals.

Return only the requested JSON object. Do not explain anything.

merchant_name_en:
- Exact English business name printed at the top.
- Do NOT include address, phone, TRN, TAX INVOICE, JOB ORDER, mall/location, customer name or identifiers.

invoice_date:
- Exact invoice/transaction date, NOT delivery date/time and NOT print time.
- Return YYYY-MM-DD when clear, otherwise empty string.

printed_item_count:
- Number printed beside Total item. Return digits only, otherwise empty string.

vat_rate_percent:
- VAT percentage printed on the receipt. Return digits/decimal only, otherwise empty string.

subtotal:
- Amount explicitly labelled Excl.VAT / subtotal before VAT. Digits and decimal only.

tax:
- VAT amount, NOT the percentage. Digits and decimal only.

total:
- Grand Total / final payable total. Prefer Grand Total over Outstanding Balance. Digits and decimal only.

currency:
- AED if shown/clearly UAE currency; otherwise empty string.

items_text:
- ONE line for each purchasable item/service row, in printed order.
- Use exactly this line format:
QTY || UNIT_PRICE || LINE_TOTAL || ENGLISH_NAME || ARABIC_NAME
- If Arabic or English is absent, leave only that field empty but keep all separators.
- Never translate, autocorrect or invent names.
- Exclude headers, VAT, subtotal, totals, Total item, balances, cash/card, TRN, dates and order numbers.
- If Total item says 3, inspect until exactly 3 purchasable rows are represented unless a row is genuinely unreadable.

Read decimal points carefully: 12.00, 0.60 and 12.60 are different values. Use empty strings for uncertain scalar fields instead of guessing.`;

function jsonHeaders(extra={}) {
  return {'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra};
}
function text(v){return v==null?'':String(v).replace(/\r/g,'').trim()}
function compact(v){return text(v).replace(/\s+/g,' ').trim()}
function toNumber(v){
  if(v===null||v===undefined)return null;
  let s=String(v)
    .replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/٫/g,'.').replace(/٬/g,'')
    .replace(/[^0-9.,-]/g,'')
    .replace(/,(?=\d{1,2}$)/,'.');
  if((s.match(/\./g)||[]).length>1){const a=s.split('.');s=a.slice(0,-1).join('')+'.'+a.at(-1)}
  const n=Number(s);return s&&Number.isFinite(n)?n:null;
}
function round2(n){return n==null?null:Math.round((Number(n)+Number.EPSILON)*100)/100}
function validDate(v){
  const s=compact(v);if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return null;
  const [y,m,d]=s.split('-').map(Number),z=new Date(Date.UTC(y,m-1,d));
  if(y<2000||y>2100||z.getUTCFullYear()!==y||z.getUTCMonth()!==m-1||z.getUTCDate()!==d)return null;
  return s;
}
function cleanMerchant(v){
  let s=compact(v).replace(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]+/g,' ').replace(/\s+/g,' ').trim();
  s=s.replace(/\b(?:TAX\s*INVOICE|INVOICE|RECEIPT|JOB\s*ORDER|TRN|MOB(?:ILE)?|TEL(?:EPHONE)?)\b.*$/i,'').trim();
  return /[A-Za-z]{3}/.test(s)?s:null;
}
function isSummaryName(s){
  return /^(?:vat|tax|subtotal|sub\s*total|excl\.?\s*vat|grand\s*total|total|balance|outstanding|amount\s*due|total\s*item|cash|card|change|trn|invoice|job\s*order|ضريبة|الإجمالي|الاجمالي|المجموع)/i.test(compact(s));
}
function responseObject(result){
  const candidate=result?.response ?? result?.answer ?? result;
  if(candidate && typeof candidate==='object' && !Array.isArray(candidate))return candidate;
  const s=text(candidate);
  if(!s)throw new Error('Vision model returned an empty response');
  try{return JSON.parse(s)}catch{}
  const fenced=s.match(/```(?:json)?\s*([\s\S]*?)```/i);if(fenced){try{return JSON.parse(fenced[1].trim())}catch{}}
  const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a>=0&&b>a){try{return JSON.parse(s.slice(a,b+1))}catch{}}
  throw new Error('Vision response was not structured JSON');
}
function parseItemLines(itemsText){
  const items=[];
  const lines=text(itemsText).split(/\n+/).map(x=>x.trim()).filter(Boolean);
  for(const raw of lines){
    let parts=raw.split(/\s*\|\|\s*/);
    if(parts.length<5)parts=raw.split(/\s+\|\s+/);
    if(parts.length<5)continue;
    // Arabic/English item text can contain separators accidentally. Preserve overflow in Arabic field.
    const qty=toNumber(parts[0]),unit=toNumber(parts[1]),line=toNumber(parts[2]);
    const en=compact(parts[3]),ar=compact(parts.slice(4).join(' || '));
    const name=en&&ar?`${en} — ${ar}`:(en||ar);
    if(!name||isSummaryName(name))continue;
    let q=qty;if(q==null||q<=0||q>999)q=1;
    let u=round2(unit),lt=round2(line);
    if(lt==null&&u!=null)lt=round2(u*q);
    if(u==null&&lt!=null&&q)u=round2(lt/q);
    items.push({name,name_en:en||null,name_ar:ar||null,quantity:q,unit_price:u,line_total:lt});
  }
  return items;
}
function sanitize(raw){
  const merchant_name_en=cleanMerchant(raw?.merchant_name_en);
  const date=validDate(raw?.invoice_date);
  const printed_item_count=(()=>{const n=toNumber(raw?.printed_item_count);return n!=null&&n>0?Math.round(n):null})();
  const vat_rate_percent=(()=>{const n=toNumber(raw?.vat_rate_percent);return n!=null&&n>=0&&n<30?n:null})();
  let subtotal=round2(toNumber(raw?.subtotal)),tax=round2(toNumber(raw?.tax)),total=round2(toNumber(raw?.total));
  const currency=compact(raw?.currency)||'AED';
  const items=parseItemLines(raw?.items_text);
  const warnings=[];

  // Safe financial reconciliation only when total and a clearly read VAT rate imply values
  // very close to what the model returned (or the model left them empty).
  if(total!=null&&vat_rate_percent!=null&&vat_rate_percent>0){
    const ds=round2(total/(1+vat_rate_percent/100)),dt=round2(total-ds);
    const bad=subtotal==null||tax==null||Math.abs((subtotal+tax)-total)>.05||Math.abs(subtotal*vat_rate_percent/100-tax)>.05;
    if(bad && (subtotal==null||Math.abs(subtotal-ds)<=.15) && (tax==null||Math.abs(tax-dt)<=.15)){
      subtotal=ds;tax=dt;warnings.push('Financial fields reconciled from Grand Total and VAT rate');
    }
  }

  const item_sum=round2(items.reduce((s,x)=>s+(x.line_total??0),0));
  if(printed_item_count!=null&&printed_item_count!==items.length)warnings.push(`Printed item count is ${printed_item_count}, but ${items.length} rows were extracted`);
  if(subtotal!=null&&tax!=null&&total!=null&&Math.abs(subtotal+tax-total)>.06)warnings.push('Subtotal + VAT does not match Grand Total');
  if(items.length&&total!=null&&Math.abs(item_sum-total)>.18&&!(subtotal!=null&&Math.abs(item_sum-subtotal)<=.18))warnings.push('Item row sum does not match labeled totals');

  const confidence={
    merchant:merchant_name_en?.length>=5?.88:0,
    date:date?.length?0.9:0,
    items:items.length?(printed_item_count===items.length?.92:.68):0,
    totals:total!=null&&subtotal!=null&&tax!=null?.94:(total!=null?.72:0)
  };
  let score=0;if(merchant_name_en)score+=20;if(date)score+=15;if(items.length)score+=35;if(total!=null)score+=20;if(subtotal!=null)score+=5;if(tax!=null)score+=5;
  const accepted=!!merchant_name_en&&!!date&&items.length>0&&total!=null&&
    (printed_item_count==null||printed_item_count===items.length)&&
    !warnings.some(x=>/does not match/i.test(x));
  return {receipt:{merchant_name_en,date,printed_item_count,vat_rate_percent,currency,subtotal,tax,total,items,confidence,warnings,item_sum},score,accepted};
}
function validImage(v){return typeof v==='string'&&v.startsWith('data:image/')&&v.length<7_000_000}
function isLicenseError(e){return /agree|license|acceptable use|meta/i.test(String(e?.message||e||''))}

async function readReceipt(env,image){
  const result=await env.AI.run(MODEL,{
    prompt:PROMPT,
    image,
    response_format:{type:'json_schema',json_schema:SIMPLE_SCHEMA},
    max_tokens:1200,
    temperature:0,
    top_p:0.1,
    stream:false
  });
  return sanitize(responseObject(result));
}

function licensePage(message=''){
  const esc=s=>String(s).replace(/[<>&]/g,m=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[m]));
  const msg=message?`<p style="color:#9a3531">${esc(message)}</p>`:'';
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>تفعيل القارئ</title><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Tahoma,Arial;background:#f4eadb;color:#17324d;padding:30px"><main style="max-width:620px;margin:auto;background:#fffaf2;border:1px solid #dfd2bf;border-radius:20px;padding:24px"><h1>تفعيل قارئ Llama Vision</h1><p>يلزم قبول رخصة Meta مرة واحدة على حساب Cloudflare.</p>${msg}<form method="post"><button style="border:0;border-radius:14px;background:#17324d;color:white;padding:14px 18px;font-weight:800;font-size:16px">أوافق وأفعّل القارئ</button></form></main></body></html>`;
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/api/license'){
      if(request.method==='GET')return new Response(licensePage(),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
      if(request.method==='POST'){
        try{await env.AI.run(MODEL,{prompt:'agree',max_tokens:8});return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body dir="rtl" style="font-family:-apple-system;background:#f4eadb;padding:30px;color:#17324d"><h1>تم التفعيل ✅</h1><p>ارجع إلى الموقع وجرب القراءة.</p></body>',{headers:{'content-type':'text/html; charset=utf-8'}})}
        catch(e){return new Response(licensePage('تعذر التفعيل: '+String(e?.message||e)),{status:500,headers:{'content-type':'text/html; charset=utf-8'}})}
      }
      return new Response('Method not allowed',{status:405});
    }
    if(url.pathname==='/api/health')return new Response(JSON.stringify({ok:true,engine:'Cloudflare Workers AI • Llama Vision Flat-JSON Receipt Reader',model:MODEL,version:VERSION,license_url:'/api/license'}),{headers:jsonHeaders()});
    if(url.pathname==='/api/receipt'){
      if(request.method!=='POST')return new Response(JSON.stringify({ok:false,error:'Method not allowed'}),{status:405,headers:jsonHeaders()});
      const started=Date.now(),scanId=crypto.randomUUID().slice(0,8);
      try{
        const body=await request.json(),image=body?.image;
        if(!validImage(image))return new Response(JSON.stringify({ok:false,error:'One receipt composite image is required'}),{status:400,headers:jsonHeaders()});
        const result=await readReceipt(env,image);
        return new Response(JSON.stringify({ok:true,...result,meta:{engine:'Cloudflare Workers AI • Llama 3.2 Vision Flat JSON',model:MODEL,version:VERSION,scan_id:scanId,elapsed_ms:Date.now()-started,images:1,inference_calls:1}}),{headers:jsonHeaders()});
      }catch(e){
        const msg=e?.message||String(e),licenseRequired=isLicenseError(e);
        return new Response(JSON.stringify({ok:false,error:msg,license_required:licenseRequired,license_url:'/api/license',meta:{version:VERSION,scan_id:scanId,elapsed_ms:Date.now()-started}}),{status:licenseRequired?428:500,headers:jsonHeaders()});
      }
    }
    return env.ASSETS.fetch(request);
  }
};
