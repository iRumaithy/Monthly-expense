const VERSION = '4.7.0';
const VISION_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const STRUCT_MODEL = '@cf/zai-org/glm-4.7-flash';

const OCR_PROMPT = `You are a high-accuracy OCR transcriber for UAE receipts and tax invoices.

Transcribe ALL visible receipt text from the supplied image.
The image may contain four overlapping panels from the same receipt.

Requirements:
- Preserve the visual reading order and line breaks as closely as possible.
- Read both English and Arabic.
- Do not summarize, explain, translate, normalize, or invent.
- Keep merchant/business names exactly as printed.
- Keep dates in the printed order. 02-08-2026 must remain 02-08-2026.
- Preserve item rows with item name, quantity, unit price and row total on the same line when possible.
- Preserve labels such as Total item, T.Pcs, G.Amt, VAT, Tax, Gross, Adv, Bal.Amt, Excl.VAT and Grand Total.
- If overlapping panels show the same line twice, transcribe it once if you can identify the duplicate.
- Output plain text only. No markdown and no commentary.`;

const STRUCT_PROMPT = `You receive literal OCR TEXT extracted from ONE UAE receipt/tax invoice.
Some lines may be duplicated because the source image contains overlapping receipt panels.

Return ONLY these plain protocol lines. No JSON. No markdown. No explanation.

HEADER_LINE|prominent English business/header line
HEADER_LINE|another prominent English business/header line
STORE|customer-facing shop/outlet/trade name in English
DATE_RAW|invoice/transaction date exactly as printed
COUNT|number of DISTINCT purchasable item rows, only if explicitly printed
PIECES|total pieces / T.Pcs / total quantity, only if explicitly printed
VAT_RATE|VAT percentage
SUBTOTAL|amount before VAT/tax
VAT|tax amount
TOTAL|final/gross/payable amount
ITEM|English item text|Arabic item text|quantity|unit price|line total

Rules:
1. STORE is the business the customer visited. If both a parent/management/legal entity and a pharmacy/laundry/shop/restaurant name appear, choose the pharmacy/laundry/shop/restaurant.
2. Example: "ZAS Medical Facilities Management" + "ALAIN PHARMACY - SOLE PROPRIETORSHIP L.L.C. - BRANCH" => STORE is ALAIN PHARMACY - SOLE PROPRIETORSHIP L.L.C. - BRANCH.
3. Keep prominent business candidates as HEADER_LINE too.
4. Remove markdown markers such as ** from names.
5. DATE_RAW must preserve the printed order. 02-08-2026 means 2 August 2026 and must stay 02-08-2026. Use invoice/transaction date, not delivery/due/print time.
6. Emit exactly one ITEM line per DISTINCT purchase row. Overlap duplicates must appear once only.
7. T.Pcs / Total Pieces / total quantity is PIECES, not COUNT.
8. Copy item names literally. Do not translate or spell-correct. If only one language exists, leave the other language field empty.
9. If a row has one monetary value, use it as line total and leave unit price empty.
10. Exclude totals, VAT, balance, advance, payment method, customer, bill/order numbers, booked-by, terms and conditions from ITEM.
11. SUBTOTAL may be labeled Excl.VAT, Net W/Out Tax, G.Amt, Net Amount, Subtotal, etc.
12. VAT is the tax AMOUNT. VAT_RATE is the percentage.
13. TOTAL may be Grand Total, Gross, Total, Amount Due, or the final paid amount. Bal.Amt/Outstanding is a remaining balance and should not replace a clearly printed gross/final total.
14. If a value is unclear, leave it blank rather than guessing.`;

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
  const n=Number(s);return Number.isFinite(n)?n:null;
}
function r2(v){const n=num(v);return n==null?null:Math.round((n+Number.EPSILON)*100)/100}
function stripMarks(v){
  return txt(v).replace(/[*_#`~]+/g,' ').replace(/[“”"'<>]+/g,' ').replace(/\s+/g,' ').trim();
}
function validDate(v){
  let s=txt(v).trim().replace(/[,]+/g,' ');
  if(!s)return null;
  let y,m,d,match;
  if((match=s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))){
    y=+match[1];m=+match[2];d=+match[3];
  }else if((match=s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))){
    d=+match[1];m=+match[2];y=+match[3];
  }else{
    const months={jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12};
    match=s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    if(match){d=+match[1];m=months[match[2].toLowerCase()];y=+match[3]}
    if(!match){
      match=s.match(/^([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})$/);
      if(match){m=months[match[1].toLowerCase()];d=+match[2];y=+match[3]}
    }
  }
  if(!y||!m||!d)return null;
  const z=new Date(Date.UTC(y,m-1,d));
  if(y<2000||y>2100||z.getUTCFullYear()!==y||z.getUTCMonth()!==m-1||z.getUTCDate()!==d)return null;
  return `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function merchant(v){
  let s=stripMarks(v)
    .replace(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]+/g,' ')
    .replace(/\s+/g,' ').trim();
  s=s.replace(/^(?:STORE|MERCHANT|BUSINESS|HEADER_LINE)\s*(?:\||:|=|-)?\s*/i,'').trim();
  s=s.replace(/\b(?:TAX\s*INVOICE|INVOICE|RECEIPT|JOB\s*ORDER|TRN|MOB(?:ILE)?|TEL(?:EPHONE)?|BILL\s*NO)\b.*$/i,'').trim();
  return /[A-Za-z]{3}/.test(s)?s:null;
}
function merchantKey(v){return stripMarks(v).toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim()}
function merchantScore(v,index=0){
  const s=merchant(v);if(!s)return -999;
  let score=0;
  if(/\b(pharmacy|laundry|laundromat|dry\s*clean|restaurant|cafe|coffee|bakery|supermarket|hypermarket|grocery|market|salon|barber|clinic|hospital|optical|boutique|store|shop|mart|garage|workshop|tailor|cafeteria|roastery|medical\s+(?:center|centre))\b/i.test(s))score+=90;
  if(/\b(branch|sole\s+proprietorship)\b/i.test(s))score+=12;
  if(/\b(facilit(?:y|ies)\s+management|property\s+management|municipality|payment|payments|bank|visa|mastercard)\b/i.test(s))score-=125;
  if(/\b(tax\s*invoice|invoice|receipt|customer|cashier|address|street|mall|mobile|telephone|trn)\b/i.test(s))score-=80;
  if(s.length>=5&&s.length<=80)score+=12;
  score+=Math.max(0,8-index);
  return score;
}
function chooseMerchant(preferred,candidates=[]){
  const all=[preferred,...candidates].map(merchant).filter(Boolean);
  const unique=[];const seen=new Set();
  for(const s of all){const k=merchantKey(s);if(!k||seen.has(k))continue;seen.add(k);unique.push(s)}
  let best=null,bestScore=-999;
  unique.forEach((s,i)=>{const sc=merchantScore(s,i)+(preferred&&merchantKey(s)===merchantKey(preferred)?5:0);if(sc>bestScore){best=s;bestScore=sc}});
  return best;
}
function summaryName(s){
  return /^(?:vat|tax|subtotal|sub\s*total|excl\.?\s*vat|grand\s*total|gross|g\.?\s*amt|total|balance|bal\.?\s*amt|outstanding|amount\s*due|total\s*item|t\.?\s*pcs|cash|card|change|trn|invoice|job\s*order|ضريبة|الإجمالي|الاجمالي|المجموع)/i.test(stripMarks(s));
}
function responseText(result){
  if(typeof result==='string')return result;
  const candidates=[result?.response,result?.answer,result?.result,result?.choices?.[0]?.message?.content,result?.choices?.[0]?.text,result?.data];
  for(const c of candidates){
    if(typeof c==='string'&&c.trim())return c;
    if(Array.isArray(c)){
      const t=c.map(x=>typeof x==='string'?x:(x?.text||x?.content||'')).join('\n').trim();
      if(t)return t;
    }
  }
  return '';
}
function validImage(v){
  return typeof v==='string'&&v.startsWith('data:image/')&&v.length<7_000_000;
}
async function transcribeImage(env,image){
  const started=Date.now();
  const result=await env.AI.run(VISION_MODEL,{
    messages:[
      {role:'system',content:'You are a literal multilingual OCR engine. Do not describe the image; transcribe the receipt text.'},
      {role:'user',content:OCR_PROMPT}
    ],
    image,
    temperature:0,
    max_tokens:2600,
    stream:false
  });
  const transcript=responseText(result);
  if(!transcript)throw new Error('Gemma 4 returned no OCR text');
  return {transcript,vision_ms:Date.now()-started};
}
async function structureTranscript(env,transcript){
  const started=Date.now();
  const prompt=`${STRUCT_PROMPT}\n\nOCR TRANSCRIPT:\n${transcript.slice(0,19000)}`;
  const result=await env.AI.run(STRUCT_MODEL,{
    prompt,
    temperature:0,
    max_tokens:1600,
    stream:false
  });
  const text=responseText(result);
  if(!text)throw new Error('Text structuring model returned no result');
  return {text,structure_ms:Date.now()-started};
}

function validImages(v){return Array.isArray(v)&&v.length===1&&validImage(v[0]);}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/api/health'){
      return new Response(JSON.stringify({
        ok:true,
        version:VERSION,
        engine:'Direct Gemma 4 Receipt OCR + Smart Structuring',
        vision_model:VISION_MODEL,
        structurer:STRUCT_MODEL,
        markdown_conversion:false,
        meta_license_required:false
      }),{headers:headers()});
    }
    if(url.pathname==='/api/license'){
      return new Response(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:-apple-system,Arial;padding:32px;line-height:1.8"><h2>لا توجد رخصة Meta مطلوبة</h2><p>الإصدار ${VERSION} يستخدم Google Gemma 4 مباشرة لقراءة الفواتير ولا يستخدم Llama أو Markdown Conversion.</p><a href="/">العودة للموقع</a></body></html>`,{headers:{'content-type':'text/html; charset=utf-8'}});
    }
    if(url.pathname==='/api/receipt'){
      if(request.method!=='POST')return new Response(JSON.stringify({ok:false,error:'Method not allowed'}),{status:405,headers:headers()});
      const started=Date.now(),scanId=crypto.randomUUID().slice(0,8);
      try{
        const body=await request.json();
        let image=body?.image;
        if(!image&&Array.isArray(body?.images))image=body.images[0];
        if(!validImage(image))return new Response(JSON.stringify({ok:false,error:'One optimized receipt image is required'}),{status:400,headers:headers()});

        const vision=await transcribeImage(env,image);
        const structured=await structureTranscript(env,vision.transcript);
        const parsed=parseProtocol(structured.text,vision.transcript);
        const checked=validate(parsed);

        return new Response(JSON.stringify({
          ok:true,...checked,
          meta:{
            version:VERSION,
            scan_id:scanId,
            elapsed_ms:Date.now()-started,
            vision_ms:vision.vision_ms,
            structure_ms:structured.structure_ms,
            engine:'Direct Gemma 4 Receipt OCR + Smart Structuring',
            vision_model:VISION_MODEL,
            structurer:STRUCT_MODEL,
            ocr_lines:vision.transcript.split(/\n+/).filter(Boolean).length,
            inference_calls:2,
            markdown_conversion:false
          }
        }),{headers:headers()});
      }catch(e){
        console.error('receipt-reader',e);
        const message=e?.message||'Receipt analysis failed';
        const status=/429|account limited|free allocation/i.test(message)?429:
          (/timeout|aborted/i.test(message)?408:500);
        return new Response(JSON.stringify({
          ok:false,
          error:message,
          retriable:status===408||status>=500,
          meta:{version:VERSION,scan_id:scanId,elapsed_ms:Date.now()-started}
        }),{status,headers:headers()});
      }
    }
    return env.ASSETS.fetch(request);
  }
};