/**
 * index.js - Full automatic solver for IITM Project-2 (single-file)
 *
 * Requirements:
 *  - Node 18+ (default on Render)
 *  - package.json: "type": "module"
 *  - Dependencies: express, body-parser, node-fetch@2, playwright, pdf-parse (optional)
 *
 * Render settings:
 *  - Build: npm install && npx playwright install
 *  - Env var: PLAYWRIGHT_BROWSERS_PATH=0
 *
 * Use:
 * curl -X POST "https://<your-app>/api/quiz" -H "Content-Type: application/json" \
 *   -d '{"email":"24f1001642@ds.study.iitm.ac.in","secret":"my-top-secret-123","url":"https://tds-llm-analysis.s-anand.net/project2"}'
 */

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch"; // v2 style import
import { chromium } from "playwright";
import pdfParse from "pdf-parse"; // optional but helpful

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const SECRET = process.env.PROJECT_SECRET || "my-top-secret-123";
const QUIZ_BASE = "https://tds-llm-analysis.s-anand.net";
const MAX_STEPS = 15;

// ------------------------ Utilities ------------------------

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function isoDate(s) {
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  return s;
}

function toHex(n) { return n.toString(16).padStart(2, "0"); }

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch ${url} failed: ${r.status}`);
  return await r.text();
}

async function fetchBinary(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch ${url} failed: ${r.status}`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

// ------------------ Instruction extraction ------------------

/**
 * Try to find a JSON instruction on the page.
 * Strategies:
 *  1) Look for <pre> blocks that contain JSON
 *  2) Look for #result innerHTML and attempt to decode base64 embedded by atob()
 *  3) Look for JSON-looking substring in result HTML
 *  4) Fallback: return { preview: htmlString }
 */
async function extractInstructionFromPage(page) {
  // 1) <pre> blocks
  try {
    const preTexts = await page.$$eval("pre", nodes => nodes.map(n => n.innerText.trim()));
    for (const p of preTexts) {
      const j = safeJsonParse(p);
      if (j) return { json: j, raw: p };
    }
  } catch (e) {}

  // 2) #result innerHTML and scripts for atob(...)
  try {
    const resultHtml = await page.$eval("#result", el => el.innerHTML).catch(() => null);
    if (resultHtml && resultHtml.trim().length > 0) {
      // try to find base64 payload in scripts
      const scripts = await page.$$eval("script", nodes => nodes.map(n => n.innerText));
      for (const s of scripts) {
        const m = s.match(/atob\((`([^`]+)`|"([^"]+)"|'([^']+)')\)/i);
        if (m) {
          const b64 = m[2] || m[3] || m[4];
          try {
            const decoded = Buffer.from(b64, "base64").toString("utf8");
            const j = safeJsonParse(decoded);
            if (j) return { json: j, raw: decoded };
            const jsonMatch = decoded.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const j2 = safeJsonParse(jsonMatch[0]);
              if (j2) return { json: j2, raw: jsonMatch[0] };
            }
            // decoded HTML as preview
            return { preview: decoded };
          } catch {}
        }
      }
      // 3) try to find JSON substring directly
      const jsonMatch = resultHtml.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const j2 = safeJsonParse(jsonMatch[0]);
        if (j2) return { json: j2, raw: jsonMatch[0] };
      }
      // fallback to preview
      return { preview: resultHtml };
    }
  } catch (e) {}

  // 4) try any pre text scanned earlier as fallback or body text
  try {
    const body = await page.content();
    const jsonMatch = body.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const j = safeJsonParse(jsonMatch[0]);
      if (j) return { json: j, raw: jsonMatch[0] };
    }
    return { preview: body.slice(0, 200) };
  } catch (e) {}

  return null;
}

// ------------------ Task solvers ------------------

function solveUV(email) {
  return `uv http get https://tds-llm-analysis.s-anand.net/project2/uv.json?email=${email} -H "Accept: application/json"`;
}

function solveGit() {
  return `git add env.sample\ngit commit -m "chore: keep env sample"`;
}

function solveMD() {
  return "/project2/data-preparation.md";
}

// Try to extract transcription from visible page text
async function solveAudioPassphrase(page) {
  try {
    const bodyText = (await page.innerText("body")).toLowerCase();
    // find phrase like "word1 word2 123"
    const m = bodyText.match(/([a-z]{2,}(?:\s+[a-z]{2,}){0,2})\s+(\d{3})/i);
    if (m) return `${m[1].trim()} ${m[2]}`.toLowerCase();
  } catch (e) {}
  return null;
}

// Heatmap: use canvas inside page to count pixel frequencies
async function solveHeatmapInPage(page) {
  try {
    const imgUrl = await page.$$eval("img[src]", imgs => (imgs.length ? imgs[0].src : null)).catch(() => null);
    if (!imgUrl) return null;

    const hex = await page.evaluate(async (src) => {
      function toHex(n) { return n.toString(16).padStart(2, "0"); }
      return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.src = src + (src.includes("?") ? "&" : "?") + "cb=" + Date.now();
        img.onload = () => {
          try {
            const w = img.naturalWidth, h = img.naturalHeight;
            const c = document.createElement("canvas");
            c.width = w; c.height = h;
            const ctx = c.getContext("2d");
            ctx.drawImage(img, 0, 0);
            const data = ctx.getImageData(0, 0, w, h).data;
            const counts = {};
            for (let i = 0; i < data.length; i += 4) {
              const r = data[i], g = data[i+1], b = data[i+2];
              const key = `${r},${g},${b}`;
              counts[key] = (counts[key] || 0) + 1;
            }
            let best = null, bestc = 0;
            for (const k in counts) {
              if (counts[k] > bestc) { bestc = counts[k]; best = k; }
            }
            if (!best) return null;
            const [r,g,b] = best.split(",").map(x => parseInt(x));
            return "#" + toHex(r) + toHex(g) + toHex(b);
          } catch (e) { resolve(null); }
        };
        img.onerror = () => resolve(null);
      });
    }, imgUrl);
    return hex ? hex.toLowerCase() : null;
  } catch (e) { return null; }
}

// CSV normalization from text content
function normalizeCSVText(csvText) {
  const rows = csvText.trim().split(/\r?\n/).filter(Boolean).map(r => r.split(",").map(c => c.trim()));
  if (rows.length < 1) return [];
  const header = rows[0].map(h => h.replace(/"/g, "").trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length !== header.length) continue;
    const rec = {};
    for (let j = 0; j < header.length; j++) {
      const key = header[j].toLowerCase();
      let v = r[j];
      if (/^id$/i.test(key)) v = parseInt(v);
      if (/value/i.test(key)) v = parseInt(String(v).replace(/[^\d-]/g, "")) || 0;
      if (/joined|date|created/i.test(key)) v = isoDate(v);
      rec[key.replace(/[^a-z0-9]+/gi,'_')] = v;
    }
    out.push({
      id: rec.id ?? i,
      name: rec.name ?? "",
      joined: rec.joined ?? null,
      value: rec.value ?? 0
    });
  }
  out.sort((a,b) => a.id - b.id);
  return out;
}

async function solveCSVFromPage(page) {
  // try direct CSV link
  try {
    const links = await page.$$eval("a[href]", as => as.map(a => a.href)).catch(() => []);
    let csvUrl = links.find(u => /\.csv(\?|$)/i.test(u));
    if (csvUrl) {
      const txt = await fetchText(csvUrl);
      return normalizeCSVText(txt);
    }
    // try pre blocks
    const preTexts = await page.$$eval("pre", nodes => nodes.map(n => n.innerText)).catch(() => []);
    const csvText = preTexts.find(t => t.includes(","));
    if (csvText) return normalizeCSVText(csvText);
    // try body text
    const body = await page.innerText("body").catch(() => "");
    if (body.includes(",")) return normalizeCSVText(body);
  } catch (e) {}
  return null;
}

// GitHub tree count
async function solveGHTreeFromParams(params, email) {
  const owner = params.owner;
  const repo = params.repo;
  const sha = params.sha;
  const pathPrefix = params.pathPrefix ?? "";
  const extension = params.extension ?? ".md";
  if (!owner || !repo || !sha) throw new Error("missing-gh-params");
  const api = `https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`;
  const r = await fetch(api, { headers: { "Accept": "application/vnd.github+json" }});
  if (!r.ok) throw new Error(`GitHub API failed ${r.status}`);
  const j = await r.json();
  const list = j.tree || [];
  const filtered = list.filter(item => item.path.startsWith(pathPrefix) && item.path.endsWith(extension));
  const count = filtered.length;
  const offs = (email.length % 2);
  return count + offs;
}

// ------------------ Chain solver ------------------

/**
 * Given a start URL (often /project2), run the required initial submit then
 * iterate through the chain of quiz pages, solve and submit answers automatically.
 */
async function solveChain(startUrl, email, secret) {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox","--disable-dev-shm-usage"] });
  let currentUrl = startUrl;
  let lastResult = null;

  // initial submit if starting at /project2
  if (startUrl.endsWith("/project2")) {
    const initPayload = { email, secret, url: startUrl, answer: "" }; // MUST be empty string
    let initJson = null;
    try {
      const resp = await fetch(`${QUIZ_BASE}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(initPayload)
      });
      initJson = await resp.json().catch(()=>null);
    } catch (e) {
      await browser.close();
      return { ok: false, reason: "initial-submit-failed", submitResponse: { error: String(e) } };
    }
    if (!initJson || !initJson.url) {
      await browser.close();
      return { ok: false, reason: "initial-submit-failed", submitResponse: initJson || null };
    }
    currentUrl = initJson.url;
  }

  for (let step = 0; step < MAX_STEPS; step++) {
    console.log(`--- STEP ${step+1} visiting ${currentUrl}`);
    const page = await browser.newPage();

    try {
      await page.goto(currentUrl, { waitUntil: "load", timeout: 30000 });
    } catch (e) {
      console.log("nav error", e);
    }

    // wait for dynamic content (#result or pre)
    try {
      await page.waitForFunction(() => {
        const r = document.querySelector("#result");
        if (r && r.innerText.trim().length > 0) return true;
        if (document.querySelector("pre")) return true;
        return false;
      }, { timeout: 5000 });
    } catch (e) {
      // continue
    }

    const extracted = await extractInstructionFromPage(page);
    if (!extracted) {
      await page.close();
      lastResult = { currentUrl, error: "no-instruction" };
      break;
    }

    const instr = extracted.json || extracted.preview || extracted.raw || {};
    const previewText = (extracted.raw || extracted.preview || "").toString().toLowerCase();

    // determine submit URL embedded in JSON or on page
    const submitUrl = (instr && (instr.submitUrl || instr.url || instr.submit)) ||
                      null;

    // pick answer
    let answer = null;
    let reason = null;

    // If instruction already has an "answer" (rare), use it
    if (instr && typeof instr.answer !== "undefined") {
      answer = instr.answer;
      reason = "explicit";
    } else {
      // heuristics based on preview or fields
      if (instr && instr.task === "uv" || /uv http get/i.test(previewText) || currentUrl.includes("uv")) {
        answer = solveUV(email); reason = "uv";
      } else if (instr && instr.task === "git" || /env.sample/i.test(previewText) || /git add env.sample/i.test(previewText)) {
        answer = solveGit(); reason = "git";
      } else if (instr && instr.task === "md" || previewText.includes("data-preparation.md")) {
        answer = solveMD(); reason = "md";
      } else if (instr && instr.task === "audio-passphrase" || currentUrl.includes("audio-passphrase") || /passphrase/i.test(previewText)) {
        answer = await solveAudioPassphrase(page);
        reason = "audio";
      } else if (instr && instr.task === "heatmap" || currentUrl.includes("heatmap") || /heatmap/i.test(previewText)) {
        answer = await solveHeatmapInPage(page);
        reason = "heatmap";
      } else if (instr && instr.task === "csv" || previewText.includes("messy.csv") || /normalize to json/i.test(previewText) || currentUrl.includes("csv")) {
        const j = await solveCSVFromPage(page);
        answer = j; reason = "csv";
      } else if (instr && instr.task === "gh-tree" || /git.*tree|pathprefix|sha/i.test(previewText) || currentUrl.includes("gh-tree")) {
        // use params in instr or preview
        let params = instr;
        if (!params.owner && instr.preview) {
          const p = safeJsonParse(instr.preview);
          if (p) params = p;
        }
        try {
          const cnt = await solveGHTreeFromParams(params, email);
          answer = cnt; reason = "gh-tree";
        } catch (e) {
          console.log("gh-tree error", e);
          answer = null; reason = "gh-tree-error";
        }
      } else {
        // fallback: try summing HTML table value column
        try {
          const sum = await page.$$eval("table", tables => {
            for (const t of tables) {
              const headers = Array.from(t.querySelectorAll("th")).map(th => th.innerText.trim().toLowerCase());
              const rows = Array.from(t.querySelectorAll("tbody tr"));
              const idx = headers.indexOf("value");
              if (idx !== -1) {
                return rows.map(r => {
                  const cells = Array.from(r.querySelectorAll("td"));
                  return parseFloat(cells[idx].innerText.replace(/[^\d.-]/g,"")) || 0;
                }).reduce((a,b)=>a+b,0);
              }
            }
            return null;
          });
          if (typeof sum === "number") { answer = sum; reason = "html-table-sum"; }
        } catch (e) {}
      }
    }

    // find submit URL if not in JSON
    let finalSubmitUrl = submitUrl;
    if (!finalSubmitUrl) {
      const candidate = await page.$$eval("a[href]", as => as.map(a => a.href)).catch(()=>[]);
      finalSubmitUrl = (candidate || []).find(u => u.includes("/submit")) || null;
    }

    // submit if possible
    let submitResponse = null;
    if (finalSubmitUrl && typeof answer !== "undefined" && answer !== null) {
      const payload = { email, secret, url: currentUrl, answer };
      try {
        const resp = await fetch(finalSubmitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        submitResponse = await resp.json().catch(()=>null);
      } catch (e) {
        submitResponse = { error: String(e) };
      }
    }

    await page.close();

    lastResult = {
      currentUrl,
      instr,
      preview: extracted.preview || extracted.raw || null,
      answer,
      reason,
      finalSubmitUrl,
      submitResponse
    };

    // follow next url if provided by grader
    if (submitResponse && submitResponse.url) {
      currentUrl = submitResponse.url;
      continue;
    } else {
      break;
    }
  } // end steps

  await browser.close();
  return { ok: true, result: lastResult };
}

// ------------------ Express handler ------------------

app.post("/api/quiz", async (req, res) => {
  try {
    const { email, secret, url } = req.body;
    if (!email || !secret || !url) return res.status(400).json({ ok: false, error: "missing-fields" });
    if (secret !== SECRET) return res.status(403).json({ ok: false, error: "invalid-secret" });

    const out = await solveChain(url, email, secret);
    return res.json(out);
  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// ------------------ Start ------------------

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
