import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { chromium } from "playwright";

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const SECRET = "my-top-secret-123";

// ----------------------------------------------------------------------
// Helper: Extract quiz instruction JSON from <pre>...</pre>
// ----------------------------------------------------------------------
async function extractInstructionJson(page) {
  const preBlocks = await page.$$eval("pre", (nodes) =>
    nodes.map((n) => n.innerText.trim())
  );

  for (const block of preBlocks) {
    try {
      const parsed = JSON.parse(block);
      return parsed; // MUST contain { answer: ..., submitUrl: ... }
    } catch (e) {}
  }

  return null;
}

// ----------------------------------------------------------------------
// Helper: Auto-compute an answer if the JSON describes known tasks
// ----------------------------------------------------------------------
function autoSolve(json) {
  if (!json) return null;

  // If quiz gives "value" or direct numeric results
  if (typeof json.value === "number") return json.value;

  // If quiz gives a table and asks to sum "value" column
  if (Array.isArray(json.table)) {
    return json.table.reduce((sum, row) => sum + (row.value || 0), 0);
  }

  // Fallback: if quiz gives "sum" or "answer"
  if (json.sum) return json.sum;
  if (json.answer) return json.answer;

  // Default fallback
  return 0;
}

// ----------------------------------------------------------------------
// Core solver: loads quiz page, waits for JS rendering, extracts JSON,
// computes answer, submits, returns results.
// ----------------------------------------------------------------------
async function solveQuizPage(quizUrl, email, secret, browser) {
  console.log("🟦 Solving:", quizUrl);

  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(quizUrl, { waitUntil: "load", timeout: 30000 });

  // ⭐ CRITICAL FIX — WAIT FOR JS TO RENDER BASE64 CONTENT
  try {
    await page.waitForFunction(() => {
      const el = document.querySelector("#result");
      return el && el.innerText.trim().length > 0;
    }, { timeout: 7000 });
  } catch (err) {
    console.log("⚠ Dynamic JS content not fully loaded:", err);
  }

  // Retrieve full HTML & text
  const html = await page.content();
  const text = await page.innerText("body");

  // Extract instruction JSON from <pre> blocks
  const instructionJson = await extractInstructionJson(page);

  if (!instructionJson) {
    console.log("❌ No quiz JSON found on page.");
    await page.close();
    await context.close();
    return {
      submitUrl: null,
      answer: null,
      reason: "no-json-found",
      submitResponse: null,
      text,
    };
  }

  const submitUrl = instructionJson.submitUrl || instructionJson.url;
  const computedAnswer = autoSolve(instructionJson);

  // ----------------------------------------------------------------------
  // Submit the answer to submitUrl
  // ----------------------------------------------------------------------
  let submitResponse = null;

  if (submitUrl) {
    const payload = {
      email,
      secret,
      url: quizUrl,
      answer: computedAnswer,
    };

    console.log("➡ Submitting answer:", payload);

    try {
      const resp = await fetch(submitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      submitResponse = await resp.json();
      console.log("⬅ Submit Response:", submitResponse);
    } catch (e) {
      console.log("❌ Submission error:", e);
    }
  }

  await page.close();
  await context.close();

  return {
    html,
    text,
    submitUrl,
    answer: computedAnswer,
    reason: "solved",
    submitResponse,
  };
}

// ----------------------------------------------------------------------
// API endpoint: /api/quiz
// ----------------------------------------------------------------------
app.post("/api/quiz", async (req, res) => {
  try {
    const { email, secret, url } = req.body;

    if (!email || !secret || !url) {
      return res.status(400).json({ error: "missing-fields" });
    }

    if (secret !== SECRET) {
      return res.status(403).json({ error: "invalid-secret" });
    }

    const browser = await chromium.launch({ headless: true });

    let nextUrl = url;
    let final = null;

    // Follow up to 10 chained quiz steps
    for (let i = 0; i < 10; i++) {
      const result = await solveQuizPage(nextUrl, email, secret, browser);
      final = result;

      if (!result.submitResponse || !result.submitResponse.url) break;

      nextUrl = result.submitResponse.url;
      console.log("🔗 NEXT:", nextUrl);
    }

    await browser.close();

    return res.json({
      ok: true,
      quizUrl: url,
      submitUrl: final?.submitUrl ?? null,
      answer: final?.answer ?? null,
      reason: final?.reason ?? null,
      decodedPreview: final?.text ?? null,
      submitResponse: final?.submitResponse ?? null,
    });

  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({ error: "server-error", message: err.toString() });
  }
});

// ----------------------------------------------------------------------
// Start Server
// ----------------------------------------------------------------------
app.listen(PORT, () => {
  console.log("✨ Server running on port", PORT);
});
