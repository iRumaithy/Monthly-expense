const VERSION = '4.6.0';
const STRUCT_MODEL = '@cf/zai-org/glm-4.7-flash';

const STRUCT_PROMPT = `You receive OCR TEXT extracted from 3 overlapping segments of ONE UAE receipt/tax invoice.
The OCR text can contain duplicated lines because the segments overlap.

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
function dataUriToBlob(uri,index=0){
  if(typeof uri!=='string'||!uri.startsWith('data:image/'))throw new Error(`Invalid image segment ${index+1}`);
  const m=uri.match(/^data:([^;,]+);base64,(.+)$/s);if(!m)throw new Error(`Invalid image data ${index+1}`);
  const bytes=Uint8Array.from(atob(m[2]),c=>c.charCodeAt(0));
  if(bytes.byteLength>5_000_000)throw new Error(`Image segment ${index+1} is too large`);
  return {name:`receipt-${index+1}.${m[1].includes('png')?'png':'jpg'}`,blob:new Blob([bytes],{type:m[1]})};
}
function normalizeLine(v){return stripMarks(v).replace(/\s+/g,' ').trim()}
function lineKey(v){return normalizeLine(v).toLowerCase().replace(/[^a-z0-9\u0600-\u06ff.]+/g,' ').replace(/\s+/g,' ').trim()}
function mergeTranscripts(parts){
  const out=[],seen=new Set();
  for(const part of parts){
    for(const raw of txt(part).split(/\n+/)){
      const line=normalizeLine(raw);if(!line)continue;
      const key=lineKey(line);
      if(key.length>2&&!seen.has(key)){seen.add(key);out.push(line)}
    }
  }
  return out.join('\n');
}
function headerCandidatesFromTranscript(transcript){
  const lines=txt(transcript).split(/\n+/).map(normalizeLine).filter(Boolean);
  const result=[];
  for(let i=0;i<Math.min(lines.length,28);i++){
    const s=lines[i];
    if(/\b(tax\s*invoice|invoice\s*no|receipt|trn|bill\s*no|customer|cashier|copy)\b/i.test(s)&&i>2)break;
    if(/[A-Za-z]{3}/.test(s)&&!/\d{5,}|@|www\.|https?:|near\b|street\b|road\b|mob\b|tel\b/i.test(s))result.push(s);
  }
  return result;
}
function fallbackDate(transcript){
  const lines=txt(transcript).split(/\n+/).map(normalizeLine).filter(Boolean);
  for(const line of lines.slice(0,45)){
    if(/\b(deliv|delivery|due|expiry|print\s*time)\b/i.test(line))continue;
    const labeled=line.match(/\b(?:date|invoice\s*date|transaction\s*date)\b[^\dA-Za-z]{0,8}((?:\d{1,2}[-/.]\d{1,2}[-/.]\d{4})|(?:\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}))/i);
    if(labeled){const d=validDate(labeled[1]);if(d)return d}
  }
  for(const line of lines.slice(0,45)){
    if(/\b(deliv|delivery|due|expiry)\b/i.test(line))continue;
    const m=line.match(/(\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/);
    if(m){const d=validDate(m[1]);if(d)return d}
  }
  return null;
}
function fallbackMoney(transcript,labelRe){
  const lines=txt(transcript).split(/\n+/);
  for(const l of lines){
    if(!labelRe.test(l))continue;
    const nums=[...l.matchAll(/-?\d+(?:[.,]\d{1,3})?/g)].map(m=>r2(m[0])).filter(v=>v!=null);
    if(nums.length)return nums[nums.length-1];
  }
  return null;
}
function cleanItemName(v){return stripMarks(v).replace(/^[|:;,\-\s]+|[|:;,\-\s]+$/g,'').replace(/\s+/g,' ').trim()}
function nameKey(v){return cleanItemName(v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim()}
function tokenSimilarity(a,b){
  const A=new Set(nameKey(a).split(' ').filter(x=>x.length>1)),B=new Set(nameKey(b).split(' ').filter(x=>x.length>1));
  if(!A.size||!B.size)return 0;let hit=0;for(const x of A)if(B.has(x))hit++;
  return hit/Math.max(A.size,B.size);
}
function sameMoney(a,b,t=.04){return a!=null&&b!=null&&Math.abs(Number(a)-Number(b))<=t}
function dedupeItems(rows){
  const out=[];
  for(const row of rows){
    if(!row?.name||summaryName(row.name))continue;
    let idx=-1;
    for(let i=0;i<out.length;i++){
      const x=out[i],qsame=Number(x.quantity||1)===Number(row.quantity||1);
      const money=sameMoney(x.line_total,row.line_total)||sameMoney(x.unit_price,row.unit_price);
      const sim=Math.max(tokenSimilarity(x.name,row.name),tokenSimilarity(x.name_en||'',row.name_en||''));
      if(qsame&&money&&sim>=.50){idx=i;break}
    }
    if(idx<0)out.push({...row});
    else{
      const x=out[idx];
      if(!x.name_en&&row.name_en)x.name_en=row.name_en;
      if(!x.name_ar&&row.name_ar)x.name_ar=row.name_ar;
      if(x.unit_price==null&&row.unit_price!=null)x.unit_price=row.unit_price;
      if(x.line_total==null&&row.line_total!=null)x.line_total=row.line_total;
      x.name=x.name_en&&x.name_ar?`${x.name_en} — ${x.name_ar}`:(x.name_en||x.name_ar||x.name);
    }
  }
  return out;
}
function parseProtocol(rawText,transcript){
  const raw=txt(rawText).replace(/```(?:text|txt)?/gi,'').replace(/```/g,'');
  const out={store:null,headers:[],date:null,count:null,pieces:null,rate:null,subtotal:null,tax:null,total:null,items:[],warnings:[]};
  const lines=raw.split(/\n+/).map(normalizeLine).filter(Boolean);
  for(const line of lines){
    const p=line.split('|').map(x=>x.trim()),key=(p[0]||'').toUpperCase().replace(/\s+/g,'_');
    if(key==='HEADER_LINE'){const h=merchant(p.slice(1).join('|'));if(h)out.headers.push(h);continue}
    if(key==='STORE'){out.store=merchant(p.slice(1).join('|'));continue}
    if(key==='DATE_RAW'||key==='DATE'){out.date=validDate(p[1]);continue}
    if(key==='COUNT'){const n=num(p[1]);out.count=n!=null&&n>0?Math.round(n):null;continue}
    if(key==='PIECES'){const n=num(p[1]);out.pieces=n!=null&&n>0?Math.round(n):null;continue}
    if(key==='VAT_RATE'){const n=num(p[1]);out.rate=n!=null&&n>=0&&n<100?n:null;continue}
    if(key==='SUBTOTAL'){out.subtotal=r2(p[1]);continue}
    if(key==='VAT'){out.tax=r2(p[1]);continue}
    if(key==='TOTAL'){out.total=r2(p[1]);continue}
    if(key==='ITEM'){
      const en=cleanItemName(p[1]),ar=cleanItemName(p[2]);
      let qty=num(p[3]),unit=r2(p[4]),total=r2(p[5]);
      if(!Number.isFinite(qty)||qty<=0||qty>999)qty=1;
      const name=en&&ar?`${en} — ${ar}`:(en||ar);
      if(!name||summaryName(name))continue;
      if(total==null&&unit!=null)total=r2(unit*qty);
      if(unit==null&&total!=null&&qty)unit=r2(total/qty);
      out.items.push({name,name_en:en||null,name_ar:ar||null,quantity:qty,unit_price:unit,line_total:total});
    }
  }

  const headerCandidates=[...out.headers,...headerCandidatesFromTranscript(transcript)];
  out.store=chooseMerchant(out.store,headerCandidates);
  if(!out.date)out.date=fallbackDate(transcript);
  if(out.subtotal==null)out.subtotal=fallbackMoney(transcript,/\b(excl\.?\s*vat|net\s*w\/?out\s*tax|net\s*without\s*tax|g\.?\s*amt|sub\s*total|subtotal|net\s*amount)\b/i);
  if(out.tax==null)out.tax=fallbackMoney(transcript,/\b(vat\s*amount|tax)\b/i);
  if(out.total==null)out.total=fallbackMoney(transcript,/\b(grand\s*total|gross|amount\s*due|final\s*total|adv)\b/i);
  if(out.total==null)out.total=fallbackMoney(transcript,/^\s*total\b/i);

  out.items=dedupeItems(out.items);
  return {out,raw,lines};
}
function validate(parsed){
  const r=parsed.out,warnings=[...r.warnings];
  const quantitySum=Math.round(r.items.reduce((s,x)=>s+(Number(x.quantity)||0),0)*100)/100;
  const itemSum=r2(r.items.reduce((s,x)=>s+(x.line_total??0),0));

  if(r.count!=null&&r.count!==r.items.length){
    if(Math.abs(r.count-quantitySum)<.01){r.pieces=r.pieces??r.count;r.count=null;warnings.push('Printed count interpreted as total pieces')}
    else warnings.push(`Printed row count is ${r.count}; extracted ${r.items.length}`);
  }
  if(r.pieces!=null&&Math.abs(r.pieces-quantitySum)>.01)warnings.push(`Printed pieces are ${r.pieces}; extracted quantity sum is ${quantitySum}`);

  if(r.subtotal!=null&&r.tax!=null&&r.total!=null&&Math.abs(r.subtotal+r.tax-r.total)>.07)
    warnings.push('Subtotal + VAT does not match total');
  const matchSubtotal=r.items.length&&r.subtotal!=null&&Math.abs(itemSum-r.subtotal)<=.20;
  const matchTotal=r.items.length&&r.total!=null&&Math.abs(itemSum-r.total)<=.20;
  if(r.items.length&&r.total!=null&&!matchSubtotal&&!matchTotal)warnings.push('Item sum does not match labeled totals');

  if(r.total!=null&&r.rate!=null&&r.rate>0&&r.rate<30){
    const ds=r2(r.total/(1+r.rate/100)),dt=r2(r.total-ds);
    const currentBad=r.subtotal==null||r.tax==null||Math.abs((r.subtotal+r.tax)-r.total)>.07;
    if(currentBad&&(r.subtotal==null||Math.abs(r.subtotal-ds)<=.18)&&(r.tax==null||Math.abs(r.tax-dt)<=.18)){
      r.subtotal=ds;r.tax=dt;warnings.push('Financial fields reconciled from total and VAT rate');
    }
  }

  const rowCountOk=r.count==null||r.count===r.items.length;
  const piecesOk=r.pieces==null||Math.abs(r.pieces-quantitySum)<.01;
  const financeOk=r.total!=null&&!warnings.some(x=>/Subtotal \+ VAT does not match/i.test(x));
  const arithmeticEvidence=matchSubtotal||matchTotal;
  const accepted=r.items.length>0&&financeOk&&piecesOk&&(rowCountOk||arithmeticEvidence);
  const complete=accepted&&!!r.store&&!!r.date;
  if(accepted&&!r.store)warnings.push('Merchant name needs manual review');
  if(accepted&&!r.date)warnings.push('Invoice date needs manual review');

  let score=0;
  if(r.store)score+=18;if(r.date)score+=14;if(r.items.length)score+=34;if(r.total!=null)score+=18;
  if(r.subtotal!=null)score+=6;if(r.tax!=null)score+=5;if(rowCountOk||piecesOk)score+=5;
  score=Math.min(100,score);

  return {
    receipt:{
      merchant_name_en:r.store,date:r.date,printed_item_count:r.count,printed_piece_count:r.pieces,
      vat_rate_percent:r.rate,currency:'AED',subtotal:r.subtotal,tax:r.tax,total:r.total,items:r.items,
      confidence:{merchant:r.store?0.88:0,date:r.date?0.9:0,items:r.items.length?0.88:0,totals:r.total!=null?0.92:0},
      warnings:[...new Set(warnings)].slice(0,14),item_sum:itemSum,quantity_sum:quantitySum
    },
    score,accepted,complete,
    fields:[r.store,r.date,r.subtotal,r.tax,r.total,r.items.length].filter(v=>v!==null&&v!==undefined&&v!=='').length
  };
}
async function convertImagesToText(env,images){
  const files=images.map(dataUriToBlob);
  const result=await env.AI.toMarkdown(files,{
    conversionOptions:{output:{format:'text'}}
  });
  const arr=Array.isArray(result)?result:(Array.isArray(result?.result)?result.result:(Array.isArray(result?.results)?result.results:[result]));
  const parts=[];
  for(const r of arr){
    if(!r)continue;
    if(r.format==='error')throw new Error(`Document OCR failed: ${r.error||'conversion error'}`);
    const data=txt(r.data||r.text||r.content);
    if(data)parts.push(data);
  }
  if(!parts.length)throw new Error('Document OCR returned no text');
  return {parts,transcript:mergeTranscripts(parts)};
}
async function structureTranscript(env,transcript){
  const prompt=`${STRUCT_PROMPT}\n\nOCR TRANSCRIPT:\n${transcript.slice(0,18000)}`;
  const result=await env.AI.run(STRUCT_MODEL,{prompt,temperature:0,max_tokens:1500,stream:false});
  const text=responseText(result);
  if(!text)throw new Error('Text structuring model returned no result');
  return text;
}
function validImages(v){
  return Array.isArray(v)&&v.length>=1&&v.length<=4&&v.every(x=>typeof x==='string'&&x.startsWith('data:image/')&&x.length<7_000_000);
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/api/health'){
      return new Response(JSON.stringify({
        ok:true,version:VERSION,
        engine:'Cloudflare Document OCR + Smart Structuring',
        ocr:'AI.toMarkdown → Gemma 4',
        structurer:STRUCT_MODEL,
        meta_license_required:false
      }),{headers:headers()});
    }
    if(url.pathname==='/api/license'){
      return new Response(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:-apple-system,Arial;padding:32px;line-height:1.8"><h2>لا توجد رخصة Meta مطلوبة</h2><p>الإصدار ${VERSION} لم يعد يستخدم Llama. القارئ يعمل عبر Cloudflare Document OCR / Gemma 4.</p><a href="/">العودة للموقع</a></body></html>`,{headers:{'content-type':'text/html; charset=utf-8'}});
    }
    if(url.pathname==='/api/receipt'){
      if(request.method!=='POST')return new Response(JSON.stringify({ok:false,error:'Method not allowed'}),{status:405,headers:headers()});
      const started=Date.now(),scanId=crypto.randomUUID().slice(0,8);
      try{
        const body=await request.json();
        let images=body?.images;
        if(!images&&body?.image)images=[body.image];
        if(!validImages(images))return new Response(JSON.stringify({ok:false,error:'1 to 4 receipt image segments are required'}),{status:400,headers:headers()});

        const ocr=await convertImagesToText(env,images);
        const structured=await structureTranscript(env,ocr.transcript);
        const parsed=parseProtocol(structured,ocr.transcript);
        const checked=validate(parsed);

        return new Response(JSON.stringify({
          ok:true,...checked,
          meta:{
            version:VERSION,scan_id:scanId,elapsed_ms:Date.now()-started,
            engine:'Cloudflare Document OCR + Smart Structuring',
            ocr_engine:'AI.toMarkdown / Gemma 4',
            structurer:STRUCT_MODEL,
            segments:images.length,
            ocr_lines:ocr.transcript.split(/\n+/).filter(Boolean).length,
            inference_pipeline:2
          }
        }),{headers:headers()});
      }catch(e){
        console.error('receipt-reader',e);
        const message=e?.message||'Receipt analysis failed';
        const status=/429|account limited|free allocation/i.test(message)?429:500;
        return new Response(JSON.stringify({
          ok:false,error:message,retriable:status>=500,
          meta:{version:VERSION,scan_id:scanId,elapsed_ms:Date.now()-started}
        }),{status,headers:headers()});
      }
    }
    return env.ASSETS.fetch(request);
  }
};