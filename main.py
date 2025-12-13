import os
import time
import base64
import json
import logging
import re
import tempfile
from typing import Any, Dict
from urllib.parse import urljoin, urlparse

import httpx
import pandas as pd
import numpy as np
from PIL import Image
from bs4 import BeautifulSoup
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from dotenv import load_dotenv

# =====================
# ENV
# =====================
load_dotenv()

SECRET_KEY = os.getenv("SECRET_KEY")
USER_EMAIL = os.getenv("USER_EMAIL")
AI_PIPE_TOKEN = os.getenv("AI_PIPE_TOKEN")
AI_PIPE_URL = os.getenv("AI_PIPE_URL")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o")

GLOBAL_SUBMIT_URL = "https://tds-llm-analysis.s-anand.net/submit"
TIME_LIMIT = 170

if not all([SECRET_KEY, USER_EMAIL, AI_PIPE_TOKEN, AI_PIPE_URL]):
    raise RuntimeError("Missing required env vars")

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
    for s in soup.find_all("script"):
        if s.string and "atob(" in s.string:
            encoded = s.string.split("atob(", 1)[1]
            encoded = encoded.split(")", 1)[0].strip("`'\"")
            return base64.b64decode(encoded).decode("utf-8", errors="ignore")
    return soup.get_text("\n", strip=True)


async def ask_llm(prompt: str) -> Any:
    headers = {"Authorization": f"Bearer {AI_PIPE_TOKEN}"}
    async with httpx.AsyncClient(timeout=40) as client:
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
# ROUTER
# =====================
def route_task(url: str, text: str) -> str:
    u = url.lower()
    t = text.lower()
    if url.endswith("/project2"):
        return "bootstrap"
    if "audio" in u:
        return "audio"
    if "heatmap" in u or "image" in u:
        return "image"
    if "csv" in u:
        return "csv"
    if "gh" in u or "github" in t:
        return "github"
    if "uv" in u:
        return "uv"
    return "llm"


# =====================
# SOLVERS
# =====================
async def solve_uv(text: str) -> str:
    match = re.search(r"(https?://[^\s]+uv\.json\?email=[^\s]+)", text)
    return f'uv http get {match.group(1)} -H "Accept: application/json"'


async def solve_audio(url: str, text: str) -> str:
    audio_url = re.search(r"https?://[^\s]+\.wav", text).group(0)
    with tempfile.NamedTemporaryFile(suffix=".wav") as f:
        data = httpx.get(audio_url).content
        f.write(data)
        f.flush()
        import whisper
        model = whisper.load_model("base")
        result = model.transcribe(f.name)
        return result["text"].strip()


async def solve_image(text: str) -> str:
    img_url = re.search(r"https?://[^\s]+\.png", text).group(0)
    img = Image.open(httpx.get(img_url, stream=True).raw).convert("RGB")
    pixels = np.array(img).reshape(-1, 3)
    avg = np.mean(pixels, axis=0).astype(int)
    return f"#{avg[0]:02x}{avg[1]:02x}{avg[2]:02x}"


async def solve_csv(text: str) -> Any:
    csv_url = re.search(r"https?://[^\s]+\.csv", text).group(0)
    df = pd.read_csv(csv_url)
    return json.loads(df.to_json(orient="records"))


async def solve_github(text: str) -> int:
    repo = re.search(r"github.com/([^/\s]+/[^/\s]+)", text).group(1)
    prefix = re.search(r"prefix[:\s]+([^\s]+)", text).group(1)
    api = f"https://api.github.com/repos/{repo}/git/trees/main?recursive=1"
    tree = httpx.get(api).json()["tree"]
    count = sum(
        1 for f in tree if f["path"].startswith(prefix) and f["path"].endswith(".md")
    )
    return count + (len(USER_EMAIL) % 2)


# =====================
# CORE
# =====================
async def solve_quiz(start_url: str) -> Dict[str, Any]:
    start = time.time()
    current = start_url
    last = {}

    async with httpx.AsyncClient(timeout=40) as client:
        while current:
            if time.time() - start > TIME_LIMIT:
                raise TimeoutError()

            r = await client.get(current)
            r.raise_for_status()
            text = extract_text_from_js(r.text)

            task = route_task(current, text)
            logger.info(f"Task detected: {task}")

            if task == "bootstrap":
                answer = 0
            elif task == "uv":
                answer = await solve_uv(text)
            elif task == "audio":
                answer = await solve_audio(current, text)
            elif task == "image":
                answer = await solve_image(text)
            elif task == "csv":
                answer = await solve_csv(text)
            elif task == "github":
                answer = await solve_github(text)
            else:
                answer = await ask_llm(text)

            payload = {
                "email": USER_EMAIL,
                "secret": SECRET_KEY,
                "url": current,
                "answer": answer,
            }

            resp = await client.post(GLOBAL_SUBMIT_URL, json=payload)
            resp.raise_for_status()
            last = resp.json()
            current = last.get("url")

    return last


# =====================
# API
# =====================
@app.post("/quiztasks")
async def quiztasks(req: Request):
    body = await req.json()
    if body.get("secret") != SECRET_KEY:
        return JSONResponse(403, {"error": "bad secret"})
    result = await solve_quiz(body["url"])
    return JSONResponse(200, result)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
