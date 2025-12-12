import os
import time
import base64
import json
import logging
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
AI_PIPE_URL = os.getenv("AI_PIPE_URL", "https://aipipe.org/openrouter/v1/chat/completions")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o")

if not SECRET_KEY or not USER_EMAIL:
    raise RuntimeError("SECRET_KEY and USER_EMAIL must be set in environment")

# =====================
# App & Logging
# =====================
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("tds-llm-quiz")

app = FastAPI()

TIME_LIMIT = 170  # seconds (safe margin under 3 minutes)

# =====================
# Utility Functions
# =====================

def extract_text_from_js(html: str) -> str:
    """
    Extracts Base64-encoded content inside atob(`...`) from script tags
    and returns decoded text.
    """
    soup = BeautifulSoup(html, "lxml")
    scripts = soup.find_all("script")

    for script in scripts:
        if script.string and "atob(" in script.string:
            try:
                encoded = script.string.split("atob(", 1)[1]
                encoded = encoded.split(")", 1)[0].strip("`'\"")
                decoded = base64.b64decode(encoded).decode("utf-8", errors="ignore")
                return decoded
            except Exception:
                continue

    # Fallback: visible text
    return soup.get_text("\n", strip=True)


async def ask_llm(question: str) -> Any:
    """Ask LLM to compute the final answer."""
    headers = {
        "Authorization": f"Bearer {AI_PIPE_TOKEN}",
        "Content-Type": "application/json",
    }

    prompt = (
        "You are solving a data analysis quiz. "
        "Follow the instructions exactly and return ONLY the final answer.\n\n"
        f"QUESTION:\n{question}"
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
        content = r.json()["choices"][0]["message"]["content"].strip()

    # Try JSON parse if possible
    try:
        return json.loads(content)
    except Exception:
        return content


async def solve_quiz(start_url: str) -> Dict[str, Any]:
    start_time = time.time()
    current_url = start_url
    last_response: Dict[str, Any] = {}

    async with httpx.AsyncClient(timeout=30) as client:
        while current_url:
            if time.time() - start_time > TIME_LIMIT:
                raise TimeoutError("Time limit exceeded")

            logger.info(f"Fetching quiz page: {current_url}")
            r = await client.get(current_url)
            r.raise_for_status()

            question_text = extract_text_from_js(r.text)
            logger.info(f"Extracted question text")

            answer = await ask_llm(question_text)
            logger.info(f"Computed answer: {answer}")

            # Find submit URL inside decoded content
            submit_url = None
            for line in question_text.splitlines():
                if line.strip().startswith("http") and "submit" in line:
                    submit_url = line.strip()
                    break

            if not submit_url:
                raise ValueError("Submit URL not found in quiz text")

            payload = {
                "email": USER_EMAIL,
                "secret": SECRET_KEY,
                "url": current_url,
                "answer": answer,
            }

            logger.info(f"Submitting answer to {submit_url}")
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
