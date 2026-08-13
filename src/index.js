const MODEL = '@cf/moondream/moondream3.1-9B-A2B';

const RECEIPT_PROMPT = `You are a high-precision receipt and invoice extraction engine for UAE receipts.
Read the image visually. Do not guess text that is not clearly visible.
Return ONLY valid JSON with this exact structure:
{
  "merchant_name_en": string | null,
  "date": string | null,
  "currency": string | null,
  "subtotal": number | null,
  "tax": number | null,
  "total": number | null,
  "items": [
    {
      "name": string,
      "quantity": number | null,
      "unit_price": number | null,
      "line_total": number | null
    }
  ],
  "confidence": {
    "merchant": number,
    "date": number,
    "items": number,
    "totals": number
  },
  "warnings": [string]
}

Critical rules:
1) merchant_name_en: copy ONLY the English merchant/business name printed near the top. Do not translate Arabic. Do not use address, phone, TRN, TAX INVOICE, JOB ORDER, branch address, city or mall as the merchant name.
2) items: copy each purchasable item/service exactly as printed. If the item is printed in Arabic and English, preserve BOTH languages in the same name. If only one language is printed, keep only that language. Never translate, normalize, beautify, spell-correct or invent item names.
3) Exclude summary/payment rows such as VAT, Tax, Subtotal, Excl.VAT, Grand Total, Balance, Total Item, Cash, Card, Change, TRN, order number and dates from items.
4) quantity, unit_price and line_total must come from the matching row. Do not confuse dates, percentages, TRN/order numbers or totals with item prices.
5) date must be the invoice/transaction date, formatted YYYY-MM-DD when clear. If uncertain return null.
6) subtotal is the amount before tax. tax is VAT/tax amount. total is final payable/grand total.
7) Use null for any uncertain numeric field. Never fabricate a value just to complete the JSON.
8) confidence values must be between 0 and 1 and reflect actual visual confidence.
9) Preserve decimal points exactly. A value like 12.60 must never become 1260 or 1.26.
10) Return JSON only, no markdown and no explanation.`;

const RETRY_PROMPT = `Re-read this receipt carefully because the first extraction was uncertain.
Focus ONLY on these fields: English merchant name at the top, every item/service row exactly as printed (preserve Arabic+English if both are printed), quantity, unit price, line total, invoice date, subtotal before VAT, VAT, and final total.
Ignore address, TRN, phone, TAX INVOICE, JOB ORDER, Total Item, payment rows and all identifiers.
Return ONLY JSON using the same receipt schema. Do not translate or rewrite item names. Use null rather than guessing.`;

function jsonHeaders(extra = {}) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  };
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const normalized = String(value)
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/٫/g, '.')
    .replace(/٬/g, '')
    .replace(/[^0-9.,-]/g, '')
    .replace(/,(?=\d{1,2}$)/, '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return n == null ? null : Math.round((n + Number.EPSILON) * 100) / 100;
}

function confidence(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function extractJson(text) {
  if (text && typeof text === 'object' && !Array.isArray(text)) return text;
  const s = String(text || '').trim();
  if (!s) throw new Error('AI returned an empty response');
  try { return JSON.parse(s); } catch {}
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const start = s.indexOf('{');
  if (start >= 0) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return JSON.parse(s.slice(start, i + 1));
      }
    }
  }
  throw new Error('AI response did not contain valid JSON');
}

function englishMerchant(value) {
  if (!value) return null;
  let s = String(value)
    .replace(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[A-Za-z]/.test(s)) return null;
  s = s.replace(/\b(?:TAX\s*INVOICE|INVOICE|RECEIPT|JOB\s*ORDER|TRN)\b.*$/i, '').trim();
  return s || null;
}

function isSummaryItem(name) {
  return /^(?:vat|tax|subtotal|sub\s*total|excl\.?\s*vat|grand\s*total|total|balance|amount\s*due|total\s*item|cash|card|change|trn|invoice|job\s*order|ضريبة|الإجمالي|الاجمالي|المجموع|المبلغ\s*المستحق|عدد\s*(?:الأصناف|الاصناف))/i.test(String(name || '').trim());
}

function sanitizeReceipt(raw) {
  const warnings = Array.isArray(raw?.warnings) ? raw.warnings.map(x => String(x)).slice(0, 20) : [];
  const merchant = englishMerchant(raw?.merchant_name_en ?? raw?.merchant ?? raw?.store);
  const items = [];
  for (const row of Array.isArray(raw?.items) ? raw.items : []) {
    const name = String(row?.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name || isSummaryItem(name)) continue;
    let qty = toNumber(row?.quantity ?? row?.qty);
    let unit = toNumber(row?.unit_price ?? row?.price);
    let line = toNumber(row?.line_total ?? row?.total);
    if (qty != null && (qty <= 0 || qty > 1000)) qty = null;
    if (unit != null && (unit < 0 || unit > 1000000)) unit = null;
    if (line != null && (line < 0 || line > 1000000)) line = null;
    if (qty == null) qty = 1;
    if (line == null && unit != null && qty != null) line = round2(unit * qty);
    if (unit == null && line != null && qty) unit = round2(line / qty);
    if (unit != null && line != null && Math.abs(unit * qty - line) > Math.max(0.15, line * 0.04)) {
      warnings.push(`Item arithmetic needs review: ${name}`);
    }
    items.push({ name, quantity: qty, unit_price: round2(unit), line_total: round2(line) });
  }

  let subtotal = toNumber(raw?.subtotal);
  let tax = toNumber(raw?.tax ?? raw?.vat);
  let total = toNumber(raw?.total ?? raw?.grand_total);
  subtotal = round2(subtotal); tax = round2(tax); total = round2(total);

  if (subtotal != null && tax != null && total != null) {
    const delta = Math.abs(subtotal + tax - total);
    if (delta > Math.max(0.15, total * 0.015)) warnings.push('Subtotal + tax does not match total');
  }

  const itemSum = round2(items.reduce((sum, it) => sum + (it.line_total ?? ((it.unit_price ?? 0) * (it.quantity ?? 1))), 0));
  if (items.length && total != null && itemSum > total * 1.5) warnings.push('Item sum is implausibly above receipt total');

  const c = raw?.confidence || {};
  return {
    merchant_name_en: merchant,
    date: raw?.date ? String(raw.date).trim() : null,
    currency: raw?.currency ? String(raw.currency).trim() : 'AED',
    subtotal,
    tax,
    total,
    items,
    confidence: {
      merchant: confidence(c.merchant),
      date: confidence(c.date),
      items: confidence(c.items),
      totals: confidence(c.totals),
    },
    warnings: [...new Set(warnings)].slice(0, 20),
    item_sum: itemSum,
  };
}

function scoreReceipt(r) {
  let score = 0;
  if (r.merchant_name_en) score += 18 * Math.max(0.5, r.confidence.merchant);
  if (r.date) score += 14 * Math.max(0.5, r.confidence.date);
  if (r.items.length) score += 30 * Math.max(0.5, r.confidence.items);
  if (r.total != null) score += 20 * Math.max(0.5, r.confidence.totals);
  if (r.subtotal != null) score += 7;
  if (r.tax != null) score += 6;
  if (r.subtotal != null && r.tax != null && r.total != null && Math.abs(r.subtotal + r.tax - r.total) <= Math.max(0.15, r.total * 0.015)) score += 5;
  return Math.round(Math.max(0, Math.min(100, score)));
}

function needsRetry(r) {
  return !r.merchant_name_en || !r.items.length || r.total == null || r.confidence.items < 0.68 || r.confidence.merchant < 0.65 || r.warnings.some(w => /does not match|implausibly/i.test(w));
}

function mergeReceipts(a, b) {
  if (!b) return a;
  const choose = (key, confKey) => {
    const av = a[key], bv = b[key];
    if (bv == null || bv === '' || (Array.isArray(bv) && !bv.length)) return av;
    if (av == null || av === '' || (Array.isArray(av) && !av.length)) return bv;
    return (b.confidence?.[confKey] || 0) > (a.confidence?.[confKey] || 0) ? bv : av;
  };
  return sanitizeReceipt({
    merchant_name_en: choose('merchant_name_en', 'merchant'),
    date: choose('date', 'date'),
    currency: a.currency || b.currency || 'AED',
    subtotal: choose('subtotal', 'totals'),
    tax: choose('tax', 'totals'),
    total: choose('total', 'totals'),
    items: (b.items?.length && ((b.confidence?.items || 0) >= (a.confidence?.items || 0) || !a.items?.length)) ? b.items : a.items,
    confidence: {
      merchant: Math.max(a.confidence.merchant, b.confidence.merchant),
      date: Math.max(a.confidence.date, b.confidence.date),
      items: Math.max(a.confidence.items, b.confidence.items),
      totals: Math.max(a.confidence.totals, b.confidence.totals),
    },
    warnings: [...(a.warnings || []), ...(b.warnings || [])],
  });
}

async function askVision(env, image, prompt) {
  const result = await env.AI.run(MODEL, {
    task: 'query',
    image,
    question: prompt,
    reasoning: true,
    temperature: 0.05,
    top_p: 0.1,
    max_tokens: 2600,
    stream: false,
  });
  const raw = result?.answer ?? result?.response ?? result;
  return sanitizeReceipt(extractJson(raw));
}

async function analyzeReceipt(env, image) {
  let first = await askVision(env, image, RECEIPT_PROMPT);
  if (needsRetry(first)) {
    try {
      const second = await askVision(env, image, RETRY_PROMPT);
      first = mergeReceipts(first, second);
    } catch (e) {
      first.warnings.push(`Second-pass verification failed: ${e.message}`);
    }
  }
  return { receipt: first, score: scoreReceipt(first) };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ ok: true, engine: 'Cloudflare Workers AI', model: MODEL, version: '4.0.0' }), {
        status: 200,
        headers: jsonHeaders(),
      });
    }

    if (url.pathname === '/api/receipt') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
      if (request.method !== 'POST') return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405, headers: jsonHeaders() });

      try {
        const body = await request.json();
        const image = body?.image;
        if (typeof image !== 'string' || !image.startsWith('data:image/')) {
          return new Response(JSON.stringify({ ok: false, error: 'A base64 image data URI is required' }), { status: 400, headers: jsonHeaders() });
        }
        if (image.length > 8_000_000) {
          return new Response(JSON.stringify({ ok: false, error: 'Image is too large; please use the optimized image from the page' }), { status: 413, headers: jsonHeaders() });
        }

        const started = Date.now();
        const result = await analyzeReceipt(env, image);
        return new Response(JSON.stringify({
          ok: true,
          receipt: result.receipt,
          score: result.score,
          meta: {
            engine: 'Cloudflare Workers AI',
            model: MODEL,
            version: '4.0.0',
            elapsed_ms: Date.now() - started,
          },
        }), { status: 200, headers: jsonHeaders() });
      } catch (error) {
        console.error('Receipt analysis failed', error);
        return new Response(JSON.stringify({ ok: false, error: error?.message || 'Receipt analysis failed' }), { status: 500, headers: jsonHeaders() });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
