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
from bs4 import BeautifulSoup
from dotenv import load_dotenv

# =====================
# ENVIRONMENT
# =====================
load_dotenv()

SECRET_KEY = os.getenv("SECRET_KEY")
USER_EMAIL = os.getenv("USER_EMAIL")
AI_PIPE_TOKEN = os.getenv("AI_PIPE_TOKEN")
AI_PIPE_URL = os.getenv("AI_PIPE_URL")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o")

GLOBAL_SUBMIT_URL = "https://tds-llm-analysis.s-anand.net/submit"
TIME_LIMIT = 170  # < 3 minutes

if not all([SECRET_KEY, USER_EMAIL, AI_PIPE_TOKEN, AI_PIPE_URL]):
    raise RuntimeError("Missing required environment variables")

# =====================
# APP
# =====================
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("quiz")

app = FastAPI()

# =====================
# HELPERS
# =====================
def extract_text_from_js(html: str) -> str:
    soup = BeautifulSoup(html, "lxml")
    for script in soup.find_all("script"):
        if script.string and "atob(" in script.string:
            encoded = script.string.split("atob(", 1)[1]
            encoded = encoded.split(")", 1)[0].strip("`'\"")
            return base64.b64decode(encoded).decode("utf-8", errors="ignore")
    return soup.get_text("\n", strip=True)


async def ask_llm(prompt: str) -> Any:
    headers = {"Authorization": f"Bearer {AI_PIPE_TOKEN}"}

    system_prompt = (
        "You are solving a data analysis quiz. "
        "Return ONLY the final answer. "
        "No explanation."
    )

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            AI_PIPE_URL,
            headers=headers,
            json={
                "model": LLM_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt},
                ],
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
# TASK ROUTER
# =====================
def route_task(url: str) -> str:
    u = url.lower()
    if u.endswith("/project2"):
        return "bootstrap"
    if "uv" in u:
        return "uv"
    if "gh-tree" in u:
        return "github"
    return "llm"


# =====================
# TASK SOLVERS
# =====================
def solve_uv(task_text: str) -> str:
    """
    Return exact CLI command string.
    """
    match = re.search(r"(https?://[^\s]+uv\.json\?email=[^\s]+)", task_text)
    if not match:
        raise ValueError("UV JSON URL not found")
    return f'uv http get {match.group(1)} -H "Accept: application/json"'


async def solve_github_tree(task_text: str) -> int:
    """
    Count .md files under prefix and add (email length mod 2)
    """
    repo_match = re.search(r"github.com/([^/\s]+/[^/\s]+)", task_text)
    prefix_match = re.search(r"prefix[:\s]+([^\s]+)", task_text)

    if not repo_match or not prefix_match:
        raise ValueError("Could not extract repo or prefix")

    repo = repo_match.group(1)
    prefix = prefix_match.group(1)

    api_url = f"https://api.github.com/repos/{repo}/git/trees/main?recursive=1"

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(api_url)
        r.raise_for_status()
        tree = r.json()["tree"]

    md_count = sum(
        1
        for item in tree
        if item["path"].startswith(prefix) and item["path"].endswith(".md")
    )

    return md_count + (len(USER_EMAIL) % 2)


# =====================
# CORE SOLVER
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
            task_type = route_task(current_url)

            logger.info(f"Task detected: {task_type}")

            if task_type == "bootstrap":
                answer = 0

            elif task_type == "uv":
                answer = solve_uv(decoded_text)

            elif task_type == "github":
                answer = await solve_github_tree(decoded_text)

            else:
                # LLM handles md / csv / image / audio reasoning
                answer = await ask_llm(decoded_text)

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
# API ENDPOINT
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
    uvicorn.run(app, host="0.0.0.0", port=10000)
