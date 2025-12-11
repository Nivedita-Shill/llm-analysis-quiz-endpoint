// ----------------------
//  LLM Analysis Quiz Bot
// ----------------------

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { chromium } from "playwright";

const app = express();
app.use(bodyParser.json());

// Auto-select Render port
const PORT = process.env.PORT || 10000;

// ============================================================
// Helper: extract embedded JSON from page
// ============================================================
async function extractQuizJSON(page) {
  try {
    const json = await page.evaluate(() => {
      const pre = document.querySelector("pre[data-quiz-json]");
      if (!pre) return null;
      return JSON.parse(pre.textContent);
    });
    return json;
  } catch {
    return null;
  }
}

// ============================================================
// Route: /api/quiz
// ============================================================
app.post("/api/quiz", async (req, res) => {
  const { email, secret, url } = req.body;

  if (!email || !secret || !url) {
    return res.json({
      ok: false,
      reason: "missing-fields",
    });
  }

  console.log("\n\n==============================");
  console.log(" Solving:", url);
  console.log("==============================\n");

  let nextUrl = url;

  // ------------------------------------------------------------
  // SPECIAL HANDLING FOR PROJECT2 — MUST SUBMIT EMPTY ANSWER FIRST
  // ------------------------------------------------------------
  if (url.endsWith("/project2")) {
    console.log("🔵 Project2 initial submission required…");

    const initBody = {
      email,
      secret,
      url,
      answer: ""  // MUST be empty string for step 1
    };

    console.log("➡ Submitting initial POST:", initBody);

    const initResp = await fetch("https://tds-llm-analysis.s-anand.net/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initBody)
    });

    const initJson = await initResp.json();
    console.log("➡ Initial submit response:", initJson);

    if (!initJson.url) {
      return res.json({
        ok: false,
        reason: "initial-submit-failed",
        submitResponse: initJson
      });
    }

    nextUrl = initJson.url;
  }

  // ------------------------------------------------------------
  // Open the quiz page using Playwright
  // ------------------------------------------------------------
  console.log("🌐 Opening:", nextUrl);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(nextUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Wait for dynamic JS if needed — but safely ignore timeout
    try {
      await page.waitForFunction(
        () => window.__QUIZ_JSON_LOADED__ === true,
        { timeout: 3000 }
      );
    } catch {
      console.log("⚠ Dynamic JS content not fully loaded (timeout ignored)");
    }

    // Extract embedded quiz JSON (if present)
    const quizJson = await extractQuizJSON(page);

    await browser.close();

    if (!quizJson) {
      console.log("❌ No quiz JSON found on page.");
      return res.json({
        ok: true,
        quizUrl: url,
        submitUrl: null,
        answer: null,
        reason: "no-json-found",
        decodedPreview: await page.content()
      });
    }

    console.log("📦 Quiz JSON found:", quizJson);

    return res.json({
      ok: true,
      quizUrl: url,
      submitUrl: quizJson.submit,
      answer: quizJson.answer ?? null,
      reason: quizJson.reason ?? null,
      decodedPreview: quizJson.preview ?? null
    });

  } catch (err) {
    await browser.close();
    console.log("❌ Error:", err);
    return res.json({
      ok: false,
      reason: "playwright-error",
      error: String(err)
    });
  }
});

// ============================================================
// Start Server
// ============================================================
app.listen(PORT, () => {
  console.log(`✨ Server running on port ${PORT}`);
});
