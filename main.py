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
# Environment
# =====================
load_dotenv()

SECRET_KEY = os.getenv("SECRET_KEY")
USER_EMAIL = os.getenv("USER_EMAIL")
AI_PIPE_TOKEN = os.getenv("AI_PIPE_TOKEN")
AI_PIPE_URL = os.getenv("AI_PIPE_URL", "https://aipipe.org/openrouter/v1/chat/completions")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o")

if not SECRET_KEY or not USER_EMAIL or not AI_PIPE_TOKEN:
    raise RuntimeError("Missing required environment variables")

TIME_LIMIT = 170
GLOBAL_SUBMIT_URL = "https://tds-llm-analysis.s-anand.net/submit"

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
    """Decode Base64 text embedded in JS (atob)."""
    soup = BeautifulSoup(html, "lxml")
    for script in soup.find_all("script"):
        if script.string and "atob(" in script.string:
            encoded = script.string.split("atob(", 1)[1]
            encoded = encoded.split(")", 1)[0].strip("`'\"")
            return base64.b64decode(encoded).decode("utf-8", errors="ignore")
    return soup.get_text("\n", strip=True)


async def ask_llm(question: str) -> Any:
    """Use LLM for reasoning-only tasks."""
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
        content = r.json()["choices"][0]["message"]["content"].strip()

    try:
        return json.loads(content)
    except Exception:
        return content


# =====================
# Task Router
# =====================
def route_task(url: str) -> str:
    if url.endswith("/project2"):
        return "bootstrap"
    if "audio" in url:
        return "audio"
    if "heatmap" in url or "image" in url:
        return "image"
    if "csv" in url:
        return "csv"
    if "gh" in url:
        return "github"
    if "uv" in url:
        return "uv"
    return "llm"


# =====================
# Partial Solvers
# =====================
async def solve_llm_task(text: str):
    return await ask_llm(text)


def solve_dummy(task_type: str):
    """
    Intentionally incomplete solvers.
    Returns placeholder answers to demonstrate routing.
    """
    logger.warning(f"Using dummy solver for task type: {task_type}")

    if task_type == "audio":
        return "unable-to-transcribe"
    if task_type == "image":
        return "#000000"
    if task_type == "csv":
        return {}
    if task_type == "github":
        return 0
    if task_type == "uv":
        return "uv http get <url>"
    return 0


# =====================
# Core Solver
# =====================
async def solve_quiz(start_url: str) -> Dict[str, Any]:
    start_time = time.time()
    current_url = start_url
    last_response: Dict[str, Any] = {}

    async with httpx.AsyncClient(timeout=30) as client:
        while current_url:
            if time.time() - start_time > TIME_LIMIT:
                raise TimeoutError("Time limit exceeded")

            logger.info(f"Fetching task: {current_url}")
            r = await client.get(current_url)
            r.raise_for_status()

            decoded_text = extract_text_from_js(r.text)
            question = decoded_text.split("Post your answer", 1)[0].strip()

            task_type = route_task(current_url)
            logger.info(f"Task type detected: {task_type}")

            if task_type == "bootstrap":
                answer = 0
            elif task_type == "llm":
                answer = await solve_llm_task(question)
            else:
                # intentionally incomplete
                answer = solve_dummy(task_type)

            payload = {
                "email": USER_EMAIL,
                "secret": SECRET_KEY,
                "url": current_url,
                "answer": answer,
            }

            logger.info("Submitting to global /submit")
            resp = await client.post(GLOBAL_SUBMIT_URL, json=payload)
            resp.raise_for_status()
            last_response = resp.json()

            logger.info(f"Response: {last_response}")
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
        logger.exception("Quiz failed")
        return JSONResponse(status_code=500, content={"error": str(e)})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
