// index.js — Clean, fixed, IITM-ready quiz solver

const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");         // v2 required
const pdfParse = require("pdf-parse");
const fs = require("fs").promises;
const playwright = require("playwright");

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

// CONFIG
const PORT = process.env.PORT || 10000;
const SECRET_STORE = process.env.SECRET_STORE || "my-top-secret-123";

// Safe JSON parsing
const safeJsonParse = (s) => {
  try { return JSON.parse(s); } catch { return null; }
};

// Main quiz endpoint
app.post("/api/quiz", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Invalid JSON" });

  const { email, secret, url } = req.body;
  if (!email || !secret || !url) return res.status(400).json({ error: "Missing fields" });
  if (secret !== SECRET_STORE) return res.status(403).json({ error: "Invalid secret" });

  const startedAt = Date.now();
  const deadlineMs = 3 * 60 * 1000; // 3 minutes max

  try {
    let currentUrl = url;
    let lastResult = null;

    while (currentUrl && Date.now() - startedAt < deadlineMs) {
      lastResult = await solveQuizPage(currentUrl);

      // Submit answer if needed
      if (lastResult.submitUrl && typeof lastResult.answer !== "undefined") {
        try {
          const submitResp = await fetch(lastResult.submitUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email,
              secret,
              url: currentUrl,
              answer: lastResult.answer,
            }),
          });

          const json = await submitResp.json().catch(() => null);
          lastResult.submitResponse = json;

          if (json && json.url) {
            currentUrl = json.url;
            continue; // solve next quiz in chain
          }
        } catch (e) {
          lastResult.submitResponse = { error: String(e) };
        }
      }

      break; // No next URL → stop
    }

    return res.json({ ok: true, ...(lastResult || {}) });

  } catch (err) {
    return res.status(500).json({
      error: "internal_error",
      message: String(err),
    });
  }
});


// ===============================
//  QUIZ PROCESSOR FUNCTION
// ===============================
async function solveQuizPage(quizUrl) {
  console.log("Solving:", quizUrl);

  const browser = await playwright.chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  // Let the quiz page fully load (scripts included)
  await page.goto(quizUrl, { waitUntil: "load", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);

  const html = await page.content();
  const bodyText = await page.innerText("body").catch(() => "");

  // Write HTML for debugging (safe)
  try { await fs.writeFile("page.html", html); } catch {}

  // -------------------------
  // Capture submit URL
  // -------------------------
  const submitMatch = html.match(/https?:\/\/[\w\-:/.?=&%]+\/submit[\w\-:/.?=&%]*/i);
  const submitUrl = submitMatch ? submitMatch[0] : null;

  // -------------------------
  // Extract Base64 payload
  // -------------------------
  let decodedPayload = null;
  const b64Match = html.match(/atob\((`([^`]+)`|"([^"]+)"|'([^']+)')\)/i);
  if (b64Match) {
    const b64 = b64Match[2] || b64Match[3] || b64Match[4];
    try { decodedPayload = Buffer.from(b64, "base64").toString("utf8"); } catch {}
  }

  // -------------------------
  // Utility to sum numbers
  // -------------------------
  const sumValues = (arr) => {
    const nums = arr
      .map((v) => String(v).replace(/[,$₹\s]/g, ""))
      .map((s) => parseFloat(s))
      .filter((n) => !isNaN(n));
    return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
  };

  let answer = null;
  let reason = null;

  // -------------------------------------------
  // 1) If decoded payload is JSON with answer
  // -------------------------------------------
  if (decodedPayload) {
    const j = safeJsonParse(decodedPayload);
    if (j && typeof j.answer !== "undefined") {
      answer = j.answer;
      reason = "base64-json";
    }
  }

  // -------------------------------------------
  // 2) HTML table with 'value' column
  // -------------------------------------------
  if (!answer) {
    const tables = await page.$$("table");
    for (const tbl of tables) {
      const headers = await tbl.$$eval("thead th, tr th", ths =>
        ths.map(t => t.innerText.trim().toLowerCase())
      );
      let idx = headers.indexOf("value");

      if (idx === -1) {
        const firstRow = await tbl.$("tr");
        if (firstRow) {
          const ths = await firstRow.$$eval("td,th",
            tds => tds.map(t => t.innerText.trim().toLowerCase())
          );
          idx = ths.indexOf("value");
        }
      }

      if (idx !== -1) {
        const col = await tbl.$$eval(
          `tbody tr td:nth-child(${idx + 1}), tr td:nth-child(${idx + 1})`,
          tds => tds.map(t => t.innerText.trim())
        );
        const s = sumValues(col);
        if (s !== null) {
          answer = s;
          reason = "html-table-sum";
          break;
        }
      }
    }
  }

  // -------------------------------------------
  // 3) CSV / JSON / PDF links
  // -------------------------------------------
  if (!answer) {
    const links = await page.$$eval("a[href]", as => as.map(a => a.href));

    for (const link of links) {
      try {
        if (/\.csv/i.test(link)) {
          const r = await fetch(link);
          const txt = await r.text();
          const rows = txt.split(/\r?\n/).filter(Boolean);
          const header = rows[0].split(",").map(h => h.trim().toLowerCase());
          const idx = header.indexOf("value");

          if (idx >= 0) {
            const values = rows.slice(1).map(r => r.split(",")[idx]);
            const s = sumValues(values);
            if (s !== null) { answer = s; reason = "csv-sum"; break; }
          }
        }

        if (/\.json/i.test(link)) {
          const r = await fetch(link);
          const j = await r.json().catch(() => null);
          if (Array.isArray(j)) {
            const vals = j.map(o => o.value).filter(v => v !== undefined);
            const s = sumValues(vals);
            if (s !== null) { answer = s; reason = "json-sum"; break; }
          }
        }

        if (/\.pdf/i.test(link)) {
          const r = await fetch(link);
          const buf = Buffer.from(await r.arrayBuffer());
          const pdf = await pdfParse(buf);
          const matches = pdf.text.match(/\d[\d,\.]*/g);
          const s = sumValues(matches || []);
          if (s !== null) { answer = s; reason = "pdf-sum"; break; }
        }
      } catch (e) {}
    }
  }

  // -------------------------------------------
  // 4) Fallback: regex on text
  // -------------------------------------------
  if (!answer) {
    const m = [...bodyText.matchAll(/value[^0-9\-]*([0-9.,]+)/gi)].map(g => g[1]);
    const s = sumValues(m);
    if (s !== null) { answer = s; reason = "text-regex-sum"; }
  }

  await browser.close();

  return {
    quizUrl,
    submitUrl,
    answer,
    reason,
    decodedPreview: decodedPayload,
  };
}

// Start server
app.listen(PORT, () => console.log("Listening on port", PORT));

module.exports = app;
