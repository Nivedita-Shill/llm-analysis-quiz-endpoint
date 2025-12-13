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
# Environment
# =====================
load_dotenv()

SECRET_KEY = os.getenv("SECRET_KEY")
USER_EMAIL = os.getenv("USER_EMAIL")
AI_PIPE_TOKEN = os.getenv("AI_PIPE_TOKEN")
AI_PIPE_URL = os.getenv("AI_PIPE_URL", "https://api.pip.ai/v1/chat/completions")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o")

if not SECRET_KEY or not USER_EMAIL or not AI_PIPE_TOKEN:
    raise RuntimeError("Missing env vars")

TIME_LIMIT = 170

# =====================
# App
# =====================
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("quiz")

app = FastAPI()

# =====================
# Helpers
# =====================
def extract_text_from_js(html: str) -> str:
    soup = BeautifulSoup(html, "lxml")
    for script in soup.find_all("script"):
        if script.string and "atob(" in script.string:
            encoded = script.string.split("atob(", 1)[1]
            encoded = encoded.split(")", 1)[0].strip("`'\"")
            return base64.b64decode(encoded).decode("utf-8", errors="ignore")
    return soup.get_text("\n", strip=True)


async def ask_llm(question: str) -> Any:
    headers = {"Authorization": f"Bearer {AI_PIPE_TOKEN}"}
    prompt = (
        "Return ONLY the final answer.\n"
        "No explanation.\n\n"
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
        out = r.json()["choices"][0]["message"]["content"].strip()

    try:
        return json.loads(out)
    except:
        return out


# =====================
# Solver
# =====================
async def solve_quiz(start_url: str) -> Dict[str, Any]:
    start = time.time()
    url = start_url
    last = {}

    async with httpx.AsyncClient(timeout=30) as client:
        while url:
            if time.time() - start > TIME_LIMIT:
                raise TimeoutError("Time exceeded")

            r = await client.get(url)
            r.raise_for_status()

            text = extract_text_from_js(r.text)

            submit_match = re.search(r"https?://[^\\s]+/submit", text)
            if not submit_match:
                raise ValueError("Submit URL not found")

            submit_url = submit_match.group(0)
            question = text.split("Post your answer", 1)[0].strip()

            answer = await ask_llm(question)

            payload = {
                "email": USER_EMAIL,
                "secret": SECRET_KEY,
                "url": url,
                "answer": answer,
            }

            resp = await client.post(submit_url, json=payload)
            resp.raise_for_status()
            last = resp.json()

            url = last.get("url")

    return last


# =====================
# API
# =====================
@app.post("/quiztasks")
async def quiztasks(request: Request):
    body = await request.json()

    if body.get("secret") != SECRET_KEY:
        return JSONResponse(status_code=403, content={"error": "Invalid secret"})

    if body.get("email") != USER_EMAIL or "url" not in body:
        return JSONResponse(status_code=400, content={"error": "Missing fields"})

    try:
        result = await solve_quiz(body["url"])
        return JSONResponse(status_code=200, content=result)
    except Exception as e:
        logger.exception("Failed")
        return JSONResponse(status_code=500, content={"error": str(e)})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
