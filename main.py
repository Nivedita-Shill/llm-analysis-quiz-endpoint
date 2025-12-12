import os
import httpx
import subprocess
import sys
import logging
from typing import Optional, Dict, Any
from fastapi import FastAPI, BackgroundTasks, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configuration
SECRET_KEY = os.getenv("SECRET_KEY")
AI_PIPE_TOKEN = os.getenv("AI_PIPE_TOKEN")
AI_PIPE_URL = os.getenv("AI_PIPE_URL", "https://api.pip.ai/v1/chat/completions")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o") # Or "gpt-4-turbo", etc.

app = FastAPI()

class QuizRequest(BaseModel):
    email: str
    secret: str
    url: str

async def generate_and_run_solver(data: QuizRequest):
    """
    Background task that:
    1. Asks an LLM to write a Python script to solve the quiz loop.
    2. Executes that script in a subprocess.
    """
    user_email = data.email
    start_url = data.url
    
    logger.info(f"Processing task for {user_email} at {start_url}")

    # --- THE PROGRAMMER PROMPT ---
    # This instructs the LLM to write the recursive solver script
    prompt = f"""
You are an expert Python script generator. Your task is to write a standalone **Python 3 script** that solves a sequence of data science quizzes.

The script must define a function that loops recursively or iteratively to handle multiple quiz steps.
The script will be executed in an environment where the following variables are available:
- `AI_PIPE_TOKEN`: API Token for the LLM.
- `USER_EMAIL`: The user's email ({user_email}).
- `SECRET_KEY`: The user's secret key.
- `START_QUIZ_URL`: The initial URL to visit ({start_url}).

**Script Requirements:**
1. **Imports:** Use `httpx`, `os`, `json`, `base64`, `time`, `re`.
2. **Time Limit:** The script must run a loop. Inside the loop, check if `time.time() - start_time > 150` (seconds). If so, exit gracefully.
3. **Fetch & Parse:** - GET the current quiz URL.
   - Extract the **Question** and **Submission URL** from the HTML. 
   - handle cases where content is inside `innerHTML = atob(...)` (Base64 encoded).
4. **Solve (LLM Call):**
   - Call the LLM API ({AI_PIPE_URL}) using `AI_PIPE_TOKEN` to answer the extracted question.
   - The prompt to the inner LLM should be simple: "Answer this question concisely: [Question]".
5. **Submit:**
   - POST the answer to the extracted Submission URL.
   - Payload format: `{{ "email": "{user_email}", "secret": os.getenv("SECRET_KEY"), "url": current_quiz_url, "answer": llm_answer }}`.
6. **Iterate:**
   - Parse the submission response JSON.
   - If it contains a `"url"` key, update the `current_quiz_url` and **repeat the loop**.
   - If no URL is returned or `correct` is False (and no new URL), exit.

**Output Format:**
- Return ONLY the raw Python code. 
- Do NOT use Markdown formatting (no ```python).
- Do NOT add explanations.
"""

    # 1. Generate the Script
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                AI_PIPE_URL,
                headers={"Authorization": f"Bearer {AI_PIPE_TOKEN}"},
                json={
                    "model": LLM_MODEL,
                    "messages": [{"role": "system", "content": prompt}],
                    "temperature": 0.1
                }
            )
            response.raise_for_status()
            
            # Extract code (handling potential markdown wrappers just in case)
            generated_code = response.json()["choices"][0]["message"]["content"]
            generated_code = generated_code.replace("```python", "").replace("```", "").strip()
            
    except Exception as e:
        logger.error(f"Failed to generate script: {e}")
        return

    # 2. Save Code to File
    filename = f"solver_{user_email.split('@')[0]}.py"
    with open(filename, "w") as f:
        f.write(generated_code)
    
    # 3. Execute the Script
    env_vars = os.environ.copy()
    env_vars["START_QUIZ_URL"] = start_url
    env_vars["USER_EMAIL"] = user_email
    # SECRET_KEY and AI_PIPE_TOKEN are already in os.environ, but ensuring they are passed
    
    try:
        logger.info(f"Running generated script: {filename}")
        result = subprocess.run(
            [sys.executable, filename],
            env=env_vars,
            capture_output=True,
            text=True,
            timeout=170 # Hard timeout slightly larger than the internal 150s check
        )
        logger.info("Script finished.")
        logger.info(f"STDOUT: {result.stdout}")
        if result.stderr:
            logger.error(f"STDERR: {result.stderr}")
            
    except subprocess.TimeoutExpired:
        logger.error("Script timed out externally.")
    except Exception as e:
        logger.error(f"Error executing script: {e}")
    finally:
        # Cleanup
        if os.path.exists(filename):
            os.remove(filename)

@app.post("/quiztasks")
async def handle_quiz_task(request: Request, background_tasks: BackgroundTasks):
    # Manual JSON parsing to handle potential errors gracefully as per spec
    try:
        body = await request.json()
    except:
        return JSONResponse(status_code=400, content={"detail": "Invalid JSON"})

    # Validation
    if body.get("secret") != SECRET_KEY:
        return JSONResponse(status_code=403, content={"detail": "Invalid Secret"})
    
    try:
        data = QuizRequest(**body)
    except:
        return JSONResponse(status_code=400, content={"detail": "Missing fields"})

    # Add to background tasks
    background_tasks.add_task(generate_and_run_solver, data)
    
    return JSONResponse(status_code=200, content={"message": "Task received. Processing."})

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
