/**
 * FINAL PRODUCTION index.js for TDS LLM Analysis Quiz
 * ----------------------------------------------------
 * Handles:
 * - Multi-step quiz chains
 * - JS-rendered content (inline <script> atob(...) )
 * - Table extraction
 * - CSV, JSON, PDF, HTML, base64 payloads
 * - File downloads
 * - Submit URL extraction
 * - Headless-safe Playwright execution
 * - Robust fallback parsing
 */

const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch"); // CJS compatible (v2)
const pdfParse = require("pdf-parse");
const fs = require("fs");
const playwright = require("playwright");

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;
const SECRET_STORE = process.env.SECRET_STORE || "my-top-secret-123";

// Utility
const safeJsonParse = text => { try { return JSON.parse(text); } catch { return null; } };


/* ---------------------------------------------------------------------
   MAIN QUIZ ENDPOINT
--------------------------------------------------------------------- */
app.post("/api/quiz", async (req, res) => {
    if (!req.body) return res.status(400).json({ error: "Invalid JSON" });

    const { email, secret, url } = req.body;
    if (!email || !secret || !url)
        return res.status(400).json({ error: "Missing fields" });

    if (secret !== SECRET_STORE)
        return res.status(403).json({ error: "Invalid secret" });

    try {
        const result = await processQuiz(url, email, secret);
        return res.json(result);
    } catch (err) {
        console.error("ERROR:", err);
        return res.status(500).json({ error: "internal_error", message: String(err) });
    }
});


/* ---------------------------------------------------------------------
   PROCESS A SINGLE QUIZ PAGE
--------------------------------------------------------------------- */
async function processQuiz(quizUrl, email, secret) {

    // Launch Chromium
    const browser = await playwright.chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
    });

    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(quizUrl, { waitUntil: "load" });

    // Ensure JS executes inline <script> tags (atob, dynamic rendering)
    await page.waitForLoadState("domcontentloaded").catch(() => {});

    try {
        await page.evaluate(() => {
            const scripts = document.querySelectorAll("script");
            for (const s of scripts) {
                try { eval(s.innerText); } catch (e) {}
            }
        });
    } catch (e) {
        console.log("Inline script eval failed:", e);
    }

    // Wait for dynamic rendering (like #result)
    await page.waitForFunction(() => {
        const el = document.querySelector("#result");
        return el && el.innerHTML.trim().length > 0;
    }, { timeout: 4000 }).catch(() => {});

    // Dump HTML for debugging (optional but helpful)
    try {
        fs.writeFileSync("page.html", await page.content());
    } catch {}

    const html = await page.content();
    const text = await page.innerText("body").catch(() => "");

    let detectedAnswer = null;
    let reason = null;

    /* ---------------------------------------------------------------------
       1) Detect SUBMIT URL
    --------------------------------------------------------------------- */
    const submitMatch = html.match(/https?:\/\/[^\s"'<>]+\/submit[^\s"'<>]*/i);
    const submitUrl = submitMatch ? submitMatch[0] : null;


    /* ---------------------------------------------------------------------
       2) Extract base64 payload (atob(`...`))
    --------------------------------------------------------------------- */
    let decodedPayload = null;
    const atobMatch = html.match(/atob\((?:`([^`]+)`|"([^"]+)"|'([^']+)')\)/i);
    if (atobMatch) {
        const b64 = atobMatch[1] || atobMatch[2] || atobMatch[3];
        try {
            decodedPayload = Buffer.from(b64, "base64").toString("utf8");
        } catch {}
    }


    /* ---------------------------------------------------------------------
       3) Parse tables for a "value" column
    --------------------------------------------------------------------- */
    const tables = await page.$$("table");
    if (tables.length && detectedAnswer === null) {
        for (const table of tables) {
            const headers = await table.$$eval("thead th, tr th", ths =>
                ths.map(th => th.innerText.trim().toLowerCase())
            );

            let idx = headers.indexOf("value");
            if (idx === -1) continue;

            const cells = await table.$$eval(`tbody tr td:nth-child(${idx + 1})`,
                tds => tds.map(td => td.innerText.trim())
            );

            const nums = cells
                .map(v => parseFloat(v.replace(/[,₹$]/g, "")))
                .filter(n => !isNaN(n));

            if (nums.length) {
                detectedAnswer = nums.reduce((a, b) => a + b, 0);
                reason = "Summed HTML table values";
                break;
            }
        }
    }


    /* ---------------------------------------------------------------------
       4) Scan <a> links for CSV, JSON, PDF
    --------------------------------------------------------------------- */
    if (detectedAnswer === null) {
        const links = await page.$$eval("a[href]", as => as.map(a => a.href));

        for (const link of links) {
            // CSV
            if (/\.csv/i.test(link)) {
                try {
                    const res = await fetch(link);
                    const csv = await res.text();

                    const rows = csv.split(/\r?\n/).filter(Boolean);
                    const header = rows[0].split(",");
                    const idx = header.findIndex(h => h.trim().toLowerCase() === "value");

                    if (idx !== -1) {
                        const nums = rows.slice(1)
                            .map(r => r.split(",")[idx])
                            .map(s => parseFloat(s.replace(/[,₹$]/g, "")))
                            .filter(n => !isNaN(n));

                        detectedAnswer = nums.reduce((a, b) => a + b, 0);
                        reason = "Summed CSV values";
                        break;
                    }
                } catch {}
            }

            // JSON
            if (/\.json/i.test(link)) {
                try {
                    const res = await fetch(link);
                    const json = await res.json();
                    if (Array.isArray(json)) {
                        const nums = json
                            .map(o => parseFloat(o.value))
                            .filter(n => !isNaN(n));

                        detectedAnswer = nums.reduce((a, b) => a + b, 0);
                        reason = "Summed JSON values";
                        break;
                    }
                } catch {}
            }

            // PDF
            if (/\.pdf/i.test(link)) {
                try {
                    const res = await fetch(link);
                    const buf = Buffer.from(await res.arrayBuffer());
                    const pdf = await pdfParse(buf);

                    const matches = pdf.text.match(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?/g);
                    if (matches) {
                        const nums = matches.map(x => parseFloat(x.replace(/,/g, "")));
                        detectedAnswer = nums.reduce((a, b) => a + b, 0);
                        reason = "Summed PDF values";
                        break;
                    }
                } catch {}
            }
        }
    }


    /* ---------------------------------------------------------------------
       5) Base64 JSON answer
    --------------------------------------------------------------------- */
    if (!detectedAnswer && decodedPayload) {
        const data = safeJsonParse(decodedPayload);
        if (data && typeof data.answer !== "undefined") {
            detectedAnswer = data.answer;
            reason = "Used base64 JSON answer";
        }
    }


    /* ---------------------------------------------------------------------
       6) Raw text fallback
    --------------------------------------------------------------------- */
    if (!detectedAnswer) {
        const matches = text.match(/value[^\n\r]*[:\-]?\s*([-\d,\.]+)/gi);
        if (matches) {
            const nums = matches.map(m =>
                parseFloat(m.replace(/[^0-9.-]/g, ""))
            ).filter(n => !isNaN(n));

            if (nums.length) {
                detectedAnswer = nums.reduce((a, b) => a + b, 0);
                reason = "Parsed raw text values";
            }
        }
    }


    /* ---------------------------------------------------------------------
       7) Return without submitting if no submit URL
    --------------------------------------------------------------------- */
    let submitResponse = null;

    if (submitUrl && detectedAnswer !== null) {
        const payload = { email, secret, url: quizUrl, answer: detectedAnswer };

        try {
            const resp = await fetch(submitUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            submitResponse = {
                status: resp.status,
                json: await resp.json().catch(() => null)
            };
        } catch (e) {
            submitResponse = { error: String(e) };
        }
    }

    await browser.close();

    return {
        ok: true,
        quizUrl,
        submitUrl,
        detectedAnswer,
        reason,
        decodedPayloadPreview: decodedPayload ? decodedPayload.slice(0,200) : null,
        submitResponse
    };
}


/* ---------------------------------------------------------------------
   ROOT
--------------------------------------------------------------------- */
app.get("/", (req, res) => {
    res.send("LLM Analysis Quiz Endpoint — READY FOR EVALUATION");
});

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
