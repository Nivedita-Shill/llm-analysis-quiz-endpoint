// index.js — fixed, robust quiz solver
}


// 3) Scan anchor links for CSV/JSON/PDF
if (!answer) {
const links = await page.$$eval('a[href]', as => as.map(a=>a.href));
for (const link of links) {
try {
if (/\.csv(\?|$)/i.test(link)) {
const r = await fetch(link); const txt = await r.text();
const rows = txt.split(/\r?\n/).filter(Boolean);
const header = rows[0].split(',').map(h=>h.trim().toLowerCase());
const vidx = header.indexOf('value');
if (vidx>=0) {
const col = rows.slice(1).map(r=>r.split(',')[vidx]);
const s = sumValues(col);
if (s !== null) { answer = s; reason='csv-sum'; break; }
}
}
if (/\.json(\?|$)/i.test(link)) {
const r = await fetch(link); const j = await r.json().catch(()=>null);
if (Array.isArray(j)) {
const vals = j.map(o => o && o.value).filter(v=>typeof v!=='undefined');
const s = sumValues(vals);
if (s !== null) { answer = s; reason='json-sum'; break; }
}
}
if (/\.pdf(\?|$)/i.test(link)) {
const r = await fetch(link); const buf = Buffer.from(await r.arrayBuffer());
const p = await pdfParse(buf); const matches = p.text.match(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?/g);
if (matches) {
const s = sumValues(matches);
if (s !== null) { answer = s; reason='pdf-sum'; break; }
}
}
} catch (e) { /* ignore link failures */ }
}
}


// 4) Fallback: simple regex on body text for numbers after 'value' word
if (!answer) {
const re = /value[^\d\n\r\S\-]*([\d,\.]+)/ig;
const m = [...bodyText.matchAll(re)].map(x=>x[1]);
const s = sumValues(m);
if (s !== null) { answer = s; reason='text-regex-sum'; }
}


// Assemble result
await browser.close();


return { quizUrl, submitUrl, answer, reason, decodedPreview };
}


app.listen(PORT, () => console.log('Listening on port', PORT));


module.exports = app;
