import os
import time
import base64
import json
import logging
import re
from typing import Any, Dict

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from dotenv import load_dotenv
from bs4 import BeautifulSoup

# =====================
# Environment & Config
# =====================
load_dotenv()

SECRET_KEY = os.getenv("SECRET_KEY")
USER_EMAIL = os.getenv("USER_EMAIL")
AI_PIPE_TOKEN = os.getenv("AI_PIPE_TOKEN")
AI_PIPE_URL = os.getenv("AI_PIPE_URL", "https://api.pip.ai/v1/chat/completions")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o")

if not SECRET_KEY or not USER_EMAIL or not AI_PIPE_TOKEN:
    raise RuntimeError("SECRET_KEY, USER_EMAIL, AI_PIPE_TOKEN must be set")

TIME_LIMIT = 170  # seconds (< 3 minutes)
GLOBAL_SUBMIT_URL = "https://tds-llm-analysis.s-anand.net/submit"

# =====================
# App & Logging
# =====================
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("quiz")

app = FastAPI()

# =====================
# Helpers
# =====================
def extract_text_from_js(html: str) -> str:
    """
    Decode Base64 content embedded via atob(`...`) in JS-rendered quiz pages.
    """
    soup = BeautifulSoup(html, "lxml")
    for script in soup.find_all("script"):
        if script.string and "atob(" in script.string:
            try:
                encoded = script.string.split("atob(", 1)[1]
                encoded = encoded.split(")", 1)[0].strip("`'\"")
                return base64.b64decode(encoded).decode("utf-8", errors="ignore")
            except Exception:
                pass
    return soup.get_text("\n", strip=True)


async def ask_llm(question: str) -> Any:
    """
    Ask the LLM ONLY the question text.
    Must return ONLY the final answer.
    """
    headers = {"Authorization": f"Bearer {AI_PIPE_TOKEN}"}

    prompt = (
        "Return ONLY the final answer.\n"
        "No explanation. No apology.\n\n"
        f"{question}"
    )

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            AI_PIPE_URL,
            headers=headers,
            json={
                "model": LLM_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0,
            },
        )
        r.raise_for_status()
        output = r.json()["choices"][0]["message"]["content"].strip()

    try:
        return json.loads(output)
    except Exception:
        return output


# =====================
# Core Solver (FINAL)
# =====================
async def solve_quiz(start_url: str) -> Dict[str, Any]:
    start_time = time.time()
    current_url = start_url
    last_response: Dict[str, Any] = {}

    async with httpx.AsyncClient(timeout=30) as client:
        while current_url:
            if time.time() - start_time > TIME_LIMIT:
                raise TimeoutError("Time limit exceeded")

            logger.info(f"Fetching: {current_url}")
            r = await client.get(current_url)
            r.raise_for_status()

            decoded_text = extract_text_from_js(r.text)

            # Try to find submit URL inside task text
            submit_match = re.search(r"https?://[^\s]+/submit", decoded_text)

            # -------------------------------------------------
            # BOOTSTRAP CASE: /project2
            # -------------------------------------------------
            if not submit_match:
                if current_url.endswith("/project2"):
                    logger.info("Bootstrap URL detected (/project2)")

                    payload = {
                        "email": USER_EMAIL,
                        "secret": SECRET_KEY,
                        "url": current_url,
                        # IMPORTANT: answer must NOT be null
                        "answer": "12345"
                    }

                    resp = await client.post(GLOBAL_SUBMIT_URL, json=payload)
                    resp.raise_for_status()
                    last_response = resp.json()

                    current_url = last_response.get("url")
                    continue

                # Any other page without submit URL is invalid
                raise ValueError("Submit URL not found")

            # -------------------------------------------------
            # NORMAL QUIZ PAGE
            # -------------------------------------------------
            submit_url = submit_match.group(0)

            # Extract only the question (strip instructions)
            question = decoded_text.split("Post your answer", 1)[0].strip()

            logger.info("Sending question to LLM")
            answer = await ask_llm(question)
            logger.info(f"Answer computed: {answer}")

            payload = {
                "email": USER_EMAIL,
                "secret": SECRET_KEY,
                "url": current_url,
                "answer": answer,
            }

            resp = await client.post(submit_url, json=payload)
            resp.raise_for_status()
            last_response = resp.json()

            logger.info(f"Submission response: {last_response}")
            current_url = last_response.get("url")

    return last_response


# =====================
# API Endpoint
# =====================
@app.post("/quiztasks")
async def quiztasks(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    if body.get("secret") != SECRET_KEY:
        return JSONResponse(status_code=403, content={"error": "Invalid secret"})

    if body.get("email") != USER_EMAIL or "url" not in body:
        return JSONResponse(status_code=400, content={"error": "Missing fields"})

    try:
        result = await solve_quiz(body["url"])
        return JSONResponse(status_code=200, content=result)
    except Exception as e:
        logger.exception("Quiz solving failed")
        return JSONResponse(status_code=500, content={"error": str(e)})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
