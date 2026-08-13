const MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const VERSION = '4.4.6';

const PROMPT = `You are a literal OCR transcriber specialized in many different UAE receipt and tax-invoice layouts.

The composite contains three FULL-WIDTH horizontal panels from the SAME receipt:
- TOP: merchant/header and invoice date.
- MIDDLE: item/service table.
- BOTTOM: totals/VAT/payment summary.

Do NOT return JSON. Return ONLY plain text protocol lines:

STORE|best customer-facing merchant/trade/store name
STORE_CANDIDATE|major English business/organization name from the header
STORE_CANDIDATE|another major English business/organization name if present
DATE_RAW|invoice/transaction date exactly as printed
COUNT|number of DISTINCT ITEM ROWS only when explicitly printed as Total item / No. of items
VAT_RATE|number
SUBTOTAL|amount before VAT/tax
VAT|tax amount
TOTAL|final payable/gross total
ITEM|English item text|Arabic item text|quantity|unit price|line total
ITEM|English item text|Arabic item text|quantity|unit price|line total

MERCHANT RULES:
1. STORE means the CUSTOMER-FACING OUTLET/TRADE NAME that actually issued the receipt, not necessarily the first legal company name.
2. Emit every major English organization/trade name in the header as STORE_CANDIDATE in TOP-TO-BOTTOM visual order.
3. If a parent/owner/management/holding company appears above a pharmacy, laundry, restaurant, shop, branch, clinic, market, salon, etc., choose the customer-facing outlet as STORE.
   Generic example: "ABC Facilities Management L.L.C." above "CITY PHARMACY - BRANCH" => STORE is CITY PHARMACY - BRANCH.
4. Exclude addresses, mall/location text, municipality/building names, phone, TRN, TAX INVOICE, invoice number, customer name and payment system names from STORE.

DATE RULES:
5. DATE_RAW must be copied EXACTLY in the same order printed. Never swap day and month.
   Example: 02-08-2026 => DATE_RAW|02-08-2026.
   A text date such as 21 Jul 2026 => DATE_RAW|21 Jul 2026.
6. Use the transaction/invoice date, not Delivery Date, due date or Print Time.

ITEM RULES:
7. Emit ONE ITEM line for every distinct purchasable row.
8. Copy English and Arabic item names literally. Never translate or spell-correct.
9. quantity, unit_price and line_total must belong to the SAME row.
10. COUNT is ONLY a printed count of distinct item rows. Do NOT use T.Pcs, Total Pieces, Total Qty or total quantity as COUNT.
11. Never include VAT, totals, balance, dates, TRN, invoice/order/customer numbers or table headings as ITEM rows.

TOTAL RULES:
12. SUBTOTAL is the amount before VAT/tax. Labels vary: Excl.VAT, Subtotal, Net W/Out Tax, G.Amt or similar.
13. VAT is the tax amount, not the percentage.
14. TOTAL is the final amount payable. Labels vary: Grand Total, Total, Gross, Amount Due, Adv when it clearly equals subtotal + tax, or similar.
15. Read decimal points character-by-character. 12.00, 0.60 and 12.60 are different.
16. If a field is unreadable, leave it empty rather than guessing.
17. No markdown, no commentary and no code fences. Only protocol lines.`;

const REPAIR_PROMPT = `You are a second-pass OCR verifier for the SAME UAE receipt image.
The first pass was incomplete or internally inconsistent.

Read the receipt again independently. Focus on the actual item/service table and the labeled financial summary.
Do NOT copy examples, instructions, placeholders or field descriptions into values.

Return ONLY:
STORE|actual customer-facing merchant name visibly printed on the receipt
DATE_RAW|invoice/transaction date exactly as printed
COUNT|distinct item-row count only when explicitly printed as Total item / No. of Items / # of Items
PIECES|total pieces / T.Pcs / Total Qty only when explicitly printed
VAT_RATE|percentage
SUBTOTAL|amount before tax
VAT|tax amount
TOTAL|final payable/gross/net amount
ITEM|English item text|Arabic item text|quantity|unit price|line total

Rules:
1. STORE must be ACTUAL text visible on the receipt. NEVER output phrases such as "best customer-facing merchant/trade/store name", "store name", "merchant name", or any instruction text.
2. Read every DISTINCT purchase row. Do not output totals, customer details, dates, payment methods, terms or balances as items.
3. Common subtotal labels include Excl.VAT, VATable Sales, Taxable Sales, Subtotal, Net W/Out Tax, G.Amt and Net Amount Before Tax.
4. VAT labels include VAT Amount, VAT 5%, Tax.
5. Common final-total labels include Grand Total, Gross, Net Amount, Total, Amount Due and final paid amount.
6. T.Pcs / Total Pieces / Total Qty is PIECES, not COUNT.
7. Keep dates in the printed order. Never swap day and month.
8. Copy item names literally; do not translate or spell-correct.
9. If only one money value is printed for a row, use it as line total.
10. Read decimals exactly. If unclear, leave blank instead of guessing.
11. No JSON, markdown, explanation or code fences.`;

const ALT_LAYOUT_PROMPT = `You are a literal OCR transcriber for a UAE receipt/tax invoice of ANY layout.

The supplied image is an ALTERNATE MAGNIFIED VIEW of one receipt:
- LEFT COLUMN: the complete receipt for context.
- RIGHT COLUMN: four overlapping enlarged sections, in top-to-bottom order.
The enlarged sections are coverage only. DO NOT assume merchant, date, items or totals are at fixed positions.

Return ONLY plain protocol lines:

STORE|actual customer-facing merchant/trade/store name visibly printed on the receipt
STORE_CANDIDATE|another major English business/legal/outlet name visibly printed
DATE_RAW|invoice/transaction date exactly as printed
COUNT|distinct purchasable item-row count only if explicitly printed
PIECES|T.Pcs / Total Pieces / Total Qty / summed quantity only if explicitly printed
VAT_RATE|percentage number
SUBTOTAL|amount before VAT/tax
VAT|tax amount
TOTAL|final payable/gross/net total
ITEM|English item text|Arabic item text|quantity|unit price|line total

RULES:
1. Read the ACTUAL receipt, not these instructions. Never output example/placeholder phrases.
2. STORE is the outlet the customer used. If a parent/management company and a pharmacy/laundry/shop/restaurant are both visible, choose the outlet.
3. Preserve DATE_RAW exactly in printed order. Never swap day/month.
4. Read EVERY DISTINCT purchase/service row from the whole receipt.
5. T.Pcs / Total Qty / Total Pieces is PIECES, not COUNT.
6. Common pre-tax labels include VATable Sales, Taxable Sales, Excl.VAT, Subtotal, G.Amt, Net W/Out Tax.
7. Common tax labels include VAT Amount, VAT 5%, Tax.
8. Common final labels include Net Amount, Gross, Grand Total, Total, Amount Due, Adv when it is the final paid amount.
9. Copy item names literally. Do not translate or spell-correct.
10. Exclude customer/order/invoice numbers, payment methods, balances, dates, VAT/totals and terms from ITEM rows.
11. If a number/text is unclear, leave it blank instead of guessing.
12. No JSON, markdown, commentary or code fences.`;

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
  let s=txt(v)
    .replace(/[*_#`~]+/g,' ')
    .replace(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]+/g,' ')
    .replace(/\s+/g,' ').trim();
  s=s.replace(/\b(?:TAX\s*INVOICE|INVOICE|RECEIPT|JOB\s*ORDER|TRN|MOB(?:ILE)?|TEL(?:EPHONE)?)\b.*$/i,'').trim();
  if(/^(?:best\s+)?customer[-\s]*facing\s+(?:merchant|outlet|trade|store)|^(?:store|merchant|business)\s*name$|actual\s+(?:store|merchant)\s+name|name\s+visibly\s+printed/i.test(s))return null;
  if(/\b(?:best customer-facing merchant\/trade\/store name|customer-facing merchant\/trade\/store name)\b/i.test(s))return null;
  return /[A-Za-z]{3}/.test(s)?s:null;
}

function merchantKey(v){
  return txt(v).toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
}
function merchantCandidateScore(name,index=0,preferred=false){
  const s=txt(name),k=merchantKey(s); if(!k||!/^[\s\S]*[a-z]{2}/i.test(k))return -999;
  let score=10 + Math.min(12,index*3);
  if(preferred)score+=18;

  // Strong customer-facing business signals.
  if(/\b(pharmacy|laundry|laundromat|dry\s*clean|restaurant|cafe|coffee|bakery|supermarket|hypermarket|grocery|market|salon|barber|clinic|hospital|optical|boutique|store|shop|mart|garage|workshop|tailor|cafeteria|roastery)\b/i.test(s))score+=82;
  else if(/\b(trading|services|medical|dental|electronics|furniture|fashion|jewellery|jewelry|flowers|florist|stationery|typing|printing|car\s*wash|rent\s*a\s*car)\b/i.test(s))score+=28;

  if(/\bbranch\b/i.test(s))score+=9;
  if(/\b(sole\s+proprietorship|establishment)\b/i.test(s))score+=5;

  // Strong signals that a line is a parent/legal/administrative entity rather than the outlet.
  if(/\bfacilit(?:y|ies)\s+management\b/i.test(s))score-=105;
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
  const out={store:null,storeCandidates:[],date:null,count:null,pieces:null,rate:null,subtotal:null,tax:null,total:null,items:[],warnings:[]};
  const lines=raw.split(/\n+/).map(cleanLine).filter(Boolean);

  for(const line of lines){
    const p=line.split('|').map(x=>x.trim()), key=(p[0]||'').toUpperCase().replace(/\s+/g,'_');
    if(key==='STORE'){out.store=merchant(p.slice(1).join('|'));continue}
    if(key==='STORE_CANDIDATE'){const c=merchant(p.slice(1).join('|'));if(c)out.storeCandidates.push(c);continue}
    if(key==='DATE_RAW'||key==='DATE'){out.date=validDate(p[1]);continue}
    if(key==='COUNT'){const n=num(p[1]);out.count=n!=null&&n>0?Math.round(n):null;continue}
    if(key==='PIECES'){const n=num(p[1]);out.pieces=n!=null&&n>0?Math.round(n):null;continue}
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
    if(/^STORE_CANDIDATE\s*\|/i.test(line))continue;
    if(/\b(?:pharmacy|laundry|laundromat|restaurant|cafe|coffee|bakery|supermarket|hypermarket|grocery|market|salon|barber|clinic|hospital|optical|boutique|store|shop|trading|facilities management|holding|management)\b/i.test(line)
      && !/\b(?:tax invoice|invoice|receipt|trn|telephone|mobile|customer|bill no|order no)\b/i.test(line)){
      const c=merchant(line.replace(/^(?:STORE|MERCHANT|BUSINESS)\s*(?:\||:|=|-)?\s*/i,''));
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
    const m=raw.match(/(?:GRAND\s*TOTAL|NET\s*AMOUNT|GROSS|AMOUNT\s*DUE|FINAL\s*TOTAL|TOTAL)\s*[:=|\-]?\s*(\d+(?:[.,]\d{1,2})?)/i);
    if(m)out.total=r2(m[1]);
  }
  if(out.tax==null){
    const m=raw.match(/\b(?:VAT\s*AMOUNT|VAT(?!_RATE)(?:\s*\d+(?:\.\d+)?\s*%)?|TAX)\s*[:=|\-]?\s*(\d+(?:[.,]\d{1,2})?)/i);
    if(m)out.tax=r2(m[1]);
  }
  if(out.subtotal==null){
    const m=raw.match(/(?:VATABLE\s*SALES|TAXABLE\s*SALES|SUBTOTAL|SUB\s*TOTAL|EXCL\.?\s*VAT|NET\s*W\/?OUT\s*TAX|NET\s*WITHOUT\s*TAX|G\.?\s*AMT)\s*[:=|\-]?\s*(\d+(?:[.,]\d{1,2})?)/i);
    if(m)out.subtotal=r2(m[1]);
  }

  out.store=chooseMerchant(out.store,out.storeCandidates);
  return {out,lines,raw};
}

function itemSuspicionScore(item){
  const n=txt(item?.name||'').toLowerCase();
  let s=0;
  if(!n)s+=100;
  if(/\b(customer|bill|cashier|order|invoice|trn|mobile|phone|time|date|balance|discount|service\s*fee|gross|total|vat|tax|cash|visa|online|change|amounts?|point|booked|advance)\b/i.test(n))s+=70;
  if(/\b(thank|terms?|condition|street|building|mall|branch|pharmacy|laundry)\b/i.test(n))s+=25;
  if((item?.line_total==null)&&(item?.unit_price==null))s+=45;
  if(Number(item?.quantity||1)<=0||Number(item?.quantity||1)>100)s+=30;
  if(n.length<2)s+=30;
  return s;
}
function rowMoney(item){
  if(item?.line_total!=null)return r2(item.line_total);
  if(item?.unit_price!=null)return r2(Number(item.unit_price)*(Number(item.quantity)||1));
  return null;
}
function chooseBestItemSubset(items,expectedCount,targets){
  if(!Number.isInteger(expectedCount)||expectedCount<=0||items.length<=expectedCount||items.length>12)return null;
  const usable=items.map((x,i)=>({item:x,i,money:rowMoney(x),sus:itemSuspicionScore(x)}));
  const validTargets=(targets||[]).filter(v=>v!=null&&Number.isFinite(Number(v))).map(Number);
  if(!validTargets.length)return null;

  let best=null;
  const pick=(start,left,chosen)=>{
    if(left===0){
      const rows=chosen.map(i=>usable[i]);
      if(rows.some(r=>r.money==null))return;
      const sum=r2(rows.reduce((s,r)=>s+Number(r.money||0),0));
      const diff=Math.min(...validTargets.map(t=>Math.abs(sum-t)));
      const suspicion=rows.reduce((s,r)=>s+r.sus,0);
      const score=diff*1000+suspicion;
      if(!best||score<best.score)best={indices:chosen.slice(),sum,diff,suspicion,score};
      return;
    }
    for(let i=start;i<=usable.length-left;i++){
      chosen.push(i);pick(i+1,left-1,chosen);chosen.pop();
    }
  };
  pick(0,expectedCount,[]);
  if(!best)return null;

  // Only prune when the selected rows are financially convincing.
  const tolerance=Math.max(.08,Math.min(.30,Math.max(...validTargets)*.006));
  if(best.diff>tolerance)return null;
  return best.indices.map(i=>items[i]);
}

function chooseBestPieceSubset(items,pieceTarget,targets){
  if(!Number.isInteger(pieceTarget)||pieceTarget<=0||items.length<2||items.length>14)return null;
  const validTargets=(targets||[]).filter(v=>v!=null&&Number.isFinite(Number(v))).map(Number);
  if(!validTargets.length)return null;
  const rows=items.map((x,i)=>({
    i,item:x,qty:Number(x.quantity)||1,money:rowMoney(x),sus:itemSuspicionScore(x)
  }));
  let best=null;
  const maxMask=1<<rows.length;
  for(let mask=1;mask<maxMask;mask++){
    let q=0,sum=0,sus=0,count=0,ok=true,idx=[];
    for(let i=0;i<rows.length;i++){
      if(!(mask&(1<<i)))continue;
      const r=rows[i];q+=r.qty;count++;sus+=r.sus;idx.push(i);
      if(r.money==null){ok=false;break}
      sum+=Number(r.money);
    }
    if(!ok||Math.abs(q-pieceTarget)>.001)continue;
    sum=r2(sum);
    const diff=Math.min(...validTargets.map(t=>Math.abs(sum-t)));
    // Prefer exact money first, then fewer suspicious rows; do NOT blindly prefer more/fewer rows.
    const score=diff*1000+sus+count*.15;
    if(!best||score<best.score)best={indices:idx,diff,sum,score,count};
  }
  if(!best)return null;
  const tolerance=Math.max(.08,Math.min(.35,Math.max(...validTargets)*.006));
  if(best.diff>tolerance)return null;
  return best.indices.map(i=>items[i]);
}

function reconcileItemRows(r,warnings){
  const original=r.items||[];
  if(!original.length)return;

  const targets=[];
  if(r.subtotal!=null)targets.push(r.subtotal);
  if(r.total!=null&&r.tax!=null)targets.push(r2(r.total-r.tax));
  if(r.total!=null)targets.push(r.total);

  let quantitySum=Math.round(original.reduce((s,x)=>s+(Number(x.quantity)||0),0)*100)/100;

  // Explicit PIECES from a repair pass.
  if(r.pieces!=null&&r.pieces>0&&original.length>1){
    const chosen=chooseBestPieceSubset(original,r.pieces,targets);
    if(chosen&&chosen.length<original.length){
      r.items=chosen;
      warnings.push(`Removed ${original.length-chosen.length} OCR rows using printed pieces and financial totals`);
      return;
    }
  }

  // The first pass may have incorrectly used T.Pcs / Total Qty as COUNT.
  // If any subset has summed quantity == printed number AND matches the subtotal,
  // reinterpret the number as pieces and keep that financially valid subset.
  if(r.count!=null&&r.count>0&&original.length>1){
    const chosenByPieces=chooseBestPieceSubset(original,r.count,targets);
    if(chosenByPieces&&(
      original.length!==r.count ||
      Math.abs(quantitySum-r.count)>.001
    )){
      r.items=chosenByPieces;
      r._pieceCount=r.count;
      r.count=null;
      warnings.push('Printed count reinterpreted as total pieces/quantity using item quantities and financial totals');
      return;
    }
  }

  // Simple case: extracted quantities already prove this is a pieces count.
  if(r.count!=null&&r.count!==original.length&&Math.abs(r.count-quantitySum)<.001){
    r._pieceCount=r.count;
    r.count=null;
    warnings.push('Printed count interpreted as total pieces/quantity, not item-row count');
    return;
  }

  // True item-row count with extra OCR rows.
  if(r.count!=null&&r.count>0&&original.length>r.count){
    const chosen=chooseBestItemSubset(original,r.count,targets);
    if(chosen&&chosen.length===r.count){
      const removed=original.length-chosen.length;
      r.items=chosen;
      warnings.push(`Removed ${removed} OCR row${removed===1?'':'s'} that did not match the printed item count and financial totals`);
    }
  }
}

function validate(parsed){
  const r=parsed.out, warnings=[...r.warnings];
  reconcileItemRows(r,warnings);
  const itemSum=r2(r.items.reduce((s,x)=>s+(x.line_total??0),0));
  const quantitySum=Math.round(r.items.reduce((s,x)=>s+(Number(x.quantity)||0),0)*100)/100;
  let pieceCount=r._pieceCount??r.pieces??null;
  if(r.count!=null&&r.count!==r.items.length){
    if(Math.abs(r.count-quantitySum)<.001){
      pieceCount=r.count;r.count=null;
      warnings.push('Printed count interpreted as total pieces/quantity, not item-row count');
    } else {
      warnings.push(`Printed item count is ${r.count}, but ${r.items.length} rows were extracted`);
    }
  }
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
  const financeOk=r.total!=null&&!warnings.some(x=>/does not match labeled|Subtotal \+ VAT|VAT amount does not match/i.test(x));
  const pieceOk=pieceCount==null||Math.abs(pieceCount-quantitySum)<.001;
  const accepted=r.items.length>0&&itemCountOk&&pieceOk&&financeOk;
  const complete=accepted&&!!r.store&&!!r.date;
  if(accepted&&!r.store)warnings.push('Merchant name needs manual review');
  if(accepted&&!r.date)warnings.push('Invoice date needs manual review');

  return {
    receipt:{
      merchant_name_en:r.store,date:r.date,printed_item_count:r.count,printed_piece_count:pieceCount,vat_rate_percent:r.rate,
      currency:'AED',subtotal:r.subtotal,tax:r.tax,total:r.total,items:r.items,
      confidence:{merchant:r.store?.length?0.82:0,date:r.date?0.85:0,items:r.items.length?0.82:0,totals:r.total!=null?0.9:0},
      warnings:[...new Set(warnings)].slice(0,14),item_sum:itemSum
    },
    score,accepted,complete,fields
  };
}
function validImage(v){return typeof v==='string'&&v.startsWith('data:image/')&&v.length<7_000_000}


function checkedQuality(c){
  if(!c)return -9999;
  let s=Number(c.score||0);
  if(c.accepted)s+=120;
  if(c.complete)s+=18;
  const r=c.receipt||{};
  const items=Array.isArray(r.items)?r.items:[];
  s+=Math.min(30,items.length*4);
  if(r.merchant_name_en)s+=8;
  if(r.date)s+=8;
  if(r.total!=null)s+=8;
  const warns=Array.isArray(r.warnings)?r.warnings:[];
  s-=warns.filter(x=>/does not match|needs manual|Printed item count|Printed pieces/i.test(x)).length*12;
  return s;
}
function isPlaceholderStore(v){
  const s=txt(v).toLowerCase();
  return /best customer-facing|customer-facing merchant\/trade\/store|store name|merchant name|actual store name/.test(s);
}
function shouldRepair(checked){
  if(!checked||checked.accepted===false)return true;
  const r=checked.receipt||{},items=Array.isArray(r.items)?r.items:[];
  if(isPlaceholderStore(r.merchant_name_en))return true;
  const warns=Array.isArray(r.warnings)?r.warnings:[];
  if(warns.some(x=>/VAT amount does not match|item row sum does not match|Printed item count|Printed pieces/i.test(x)))return true;
  const first=items[0],firstMoney=rowMoney(first);
  if(items.length===1&&r.total!=null&&firstMoney!=null&&Number(r.total)>Number(firstMoney)*1.45)return true;
  return false;
}
function fillMissingFromPrimary(best,primary){
  if(!best||!primary)return best;
  const b=best.receipt||{},p=primary.receipt||{};
  if(!b.merchant_name_en&&!isPlaceholderStore(p.merchant_name_en))b.merchant_name_en=p.merchant_name_en;
  if(!b.date)b.date=p.date;
  best.receipt=b;
  best.complete=best.accepted&&!!b.merchant_name_en&&!!b.date;
  return best;
}

async function readReceipt(env,image,mode='primary'){
  if(mode==='alternate'){
    const altResult=await env.AI.run(MODEL,{
      prompt:ALT_LAYOUT_PROMPT,
      image,
      max_tokens:1450,
      temperature:0,
      stream:false
    });
    const altRaw=responseText(altResult);
    if(!altRaw)throw new Error('Alternate vision pass returned no text');
    const alt=validate(parseProtocol(altRaw));
    alt.transcript_lines=altRaw.split(/\n+/).filter(Boolean).length;
    alt.transcript_preview=altRaw.slice(0,1400);
    alt.repair_used=false;
    alt.alternate_layout=true;
    return alt;
  }

  const firstResult=await env.AI.run(MODEL,{
    prompt:PROMPT,
    image,
    max_tokens:1000,
    temperature:0,
    stream:false
  });
  const firstRaw=responseText(firstResult);
  if(!firstRaw)throw new Error('Vision model returned no text');
  const primary=validate(parseProtocol(firstRaw));
  primary.transcript_lines=firstRaw.split(/\n+/).filter(Boolean).length;
  primary.transcript_preview=firstRaw.slice(0,1200);
  primary.repair_used=false;
  primary.alternate_layout=false;

  if(!shouldRepair(primary))return primary;

  const secondResult=await env.AI.run(MODEL,{
    prompt:REPAIR_PROMPT,
    image,
    max_tokens:1200,
    temperature:0,
    stream:false
  });
  const secondRaw=responseText(secondResult);
  if(!secondRaw)return primary;

  const repaired=validate(parseProtocol(secondRaw));
  repaired.transcript_lines=secondRaw.split(/\n+/).filter(Boolean).length;
  repaired.transcript_preview=secondRaw.slice(0,1200);
  repaired.repair_used=true;
  repaired.alternate_layout=false;

  let best=checkedQuality(repaired)>checkedQuality(primary)?repaired:primary;
  if(best===repaired)best=fillMissingFromPrimary(best,primary);
  best.repair_used=true;
  best.primary_score=primary.score;
  best.repair_score=repaired.score;
  best.alternate_layout=false;
  return best;
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/api/health'){
      return new Response(JSON.stringify({ok:true,engine:'Cloudflare Workers AI • Universal Receipt OCR + Adaptive Layout',model:MODEL,version:VERSION,base:'4.4.0'}),{headers:headers()});
    }
    if(url.pathname==='/api/receipt'){
      if(request.method!=='POST')return new Response(JSON.stringify({ok:false,error:'Method not allowed'}),{status:405,headers:headers()});
      const started=Date.now(),scanId=crypto.randomUUID().slice(0,8);
      try{
        const body=await request.json(),image=body?.image,mode=body?.mode==='alternate'?'alternate':'primary';
        if(!validImage(image))return new Response(JSON.stringify({ok:false,error:'One composite receipt image is required'}),{status:400,headers:headers()});
        const result=await readReceipt(env,image,mode);
        return new Response(JSON.stringify({
          ok:true,...result,
          meta:{engine:'Cloudflare Workers AI • Universal Receipt OCR + Adaptive Layout',model:MODEL,version:VERSION,base:'4.4.0',scan_id:scanId,elapsed_ms:Date.now()-started,images:1,inference_calls:mode==='alternate'?1:(result.repair_used?2:1),repair_used:!!result.repair_used,alternate_layout:mode==='alternate'}
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