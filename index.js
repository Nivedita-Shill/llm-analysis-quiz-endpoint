import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { chromium } from "playwright";

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;

// ----------- Solve a single quiz page -----------
async function solveQuizPage(quizUrl, email, secret, browser) {
  console.log("Solving:", quizUrl);

  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(quizUrl, { waitUntil: "load", timeout: 30000 });

  // ⭐ NEW: Wait for IITM JS to populate #result using atob()
  try {
    await page.waitForFunction(() => {
      const el = document.querySelector("#result");
      return el && el.innerText.trim().length > 0;
    }, { timeout: 7000 });
  } catch (err) {
    console.log("Dynamic content not fully loaded:", err);
  }

  // Extract the fully rendered HTML & visible text
  const html = await page.content();
  const bodyText = await page.innerText("body");
  console.log("Extracted page length:", html.length);

  // Look for a SUBMIT JSON payload inside <pre>...</pre>
  let extractedJson = null;
  const preBlocks = await page.$$eval("pre", (nodes) =>
    nodes.map((n) => n.innerText)
  );

  for (const block of preBlocks) {
    try {
      const parsed = JSON.parse(block);
      if (parsed.answer !== undefined) {
        extractedJson = parsed;
        break;
      }
    } catch (e) {}
  }

  if (!extractedJson) {
    console.log("❗ Could not find an instruction JSON block.");
    return { submitUrl: null, answer: null, reason: "no-json-found" };
  }

  const submitUrl = extractedJson.submitUrl || extractedJson.url;
  const reason = extractedJson.reason || "parsed";

  let computedAnswer = null;

  // ⭐ Auto-solve supported question types
  if (extractedJson.table) {
    computedAnswer = extractedJson.table.reduce((sum, row) => sum + (row.value || 0), 0);
  } else if (typeof extractedJson.value === "number") {
    computedAnswer = extractedJson.value;
  } else if (extractedJson.sum) {
    computedAnswer = extractedJson.sum;
  } else {
    computedAnswer = 0;
  }

  // SUBMIT the answer if we have a URL
  let submitResponse = null;
  if (submitUrl) {
    const payload = {
      email,
      secret,
      url: quizUrl,
      answer: computedAnswer,
    };

    console.log("Submitting →", submitUrl, payload);

    try {
      const resp = await fetch(submitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      submitResponse = await resp.json();
      console.log("Submit Response:", submitResponse);
    } catch (e) {
      console.log("Submission failed:", e);
    }
  }

  await page.close();
  await context.close();

  return {
    html,
    bodyText,
    submitUrl,
    answer: computedAnswer,
    reason,
    submitResponse,
  };
}

// ----------- Handle API /api/quiz -----------
app.post("/api/quiz", async (req, res) => {
  try {
    const { email, secret, url } = req.body;
    if (!email || !secret || !url) {
      return res.status(400).json({ error: "missing-fields" });
    }

    // validate secret
    if (secret !== "my-top-secret-123") {
      return res.status(403).json({ error: "invalid-secret" });
    }

    const browser = await chromium.launch({ headless: true });
    let nextUrl = url;
    let finalResult = null;

    // ⭐ Automatically follow quiz chain until a page gives no "nextUrl"
    for (let i = 0; i < 10; i++) {
      const result = await solveQuizPage(nextUrl, email, secret, browser);
      finalResult = result;

      if (!result.submitResponse || !result.submitResponse.url) break;
      nextUrl = result.submitResponse.url;
      console.log("➡️ Next:", nextUrl);
    }

    await browser.close();

    return res.json({
      ok: true,
      quizUrl: url,
      submitUrl: finalResult?.submitUrl ?? null,
      answer: finalResult?.answer ?? null,
      reason: finalResult?.reason ?? null,
      decodedPreview: finalResult?.bodyText ?? null,
      submitResponse: finalResult?.submitResponse ?? null,
    });
  } catch (e) {
    console.error("Server error:", e);
    return res.status(500).json({ error: "server-error", message: e.toString() });
  }
});

app.listen(PORT, () => {
  console.log("Listening on port", PORT);
});
