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

# Load environment variables from .env file
load_dotenv()

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- Configuration ---
# Load all required variables from the environment
SECRET_KEY = os.getenv("SECRET_KEY")
AI_PIPE_TOKEN = os.getenv("AI_PIPE_TOKEN")
# FIX 1: Ensure USER_EMAIL is loaded globally from the .env file
USER_EMAIL = os.getenv("USER_EMAIL")
# Note: AI_PIPE_URL will use your environment variable override (e.g., https://aipipe.org/...)
AI_PIPE_URL = os.getenv("AI_PIPE_URL", "https://api.pip.ai/v1/chat/completions")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o") # Or "gpt-3.5-turbo", etc.

app = FastAPI()

class QuizRequest(BaseModel):
    email: str
    secret: str
    url: str

async def generate_and_run_solver(data: QuizRequest):
    """
    Background task that:
    1. Asks an LLM to write a Python script to solve the quiz loop (The Programmer LLM).
    2. Executes that script in a subprocess.
    """
    # The email and URL come from the incoming request payload
    user_email = data.email
    start_url = data.url
    
    logger.info(f"Processing task for {user_email} at {start_url}")

    # --- THE PROGRAMMER PROMPT ---
    # This instructs the LLM to write the recursive solver script with required logging
    prompt = f"""
You are an expert Python script generator. Your task is to write a single, standalone Python 3 script using the standard 'requests' library (do NOT use 'httpx' or 'asyncio') that solves a sequence of data science quizzes.

The script MUST define a single function, `solve_quiz_sequence()`, and call it at the end of the script.

### QUIZ GOALS AND LOGIC
1. Start: The script begins at the URL: {start_url}.
2. Loop: It must continually POST to the submission endpoint (https://tds-llm-analysis.s-anand.net/submit) until no 'url' key is returned in the response.
3. Authentication: Use the email '{user_email}' and the secret '{{secret}}'.
4. Answer Generation: For each new task URL, the script must fetch the HTML content using 'requests', extract the task, generate the correct answer, and submit it. The script must use 'BeautifulSoup' for HTML parsing.

### CRITICAL LOGGING REQUIREMENTS (MUST USE print() TO STDOUT)
The script MUST print informative status messages to STDOUT at every step so the calling program can monitor progress.

1. Start: Print the starting URL.
    * Format: print(f"START: Initial URL is {{start_url}}")
2. Submission: Before every POST request, print the current task number and the answer found.
    * Format: print(f"TASK {{task_number}}: Submitting to {{current_url}} with Answer: {{answer}}")
3. Success/Failure: After every submission, print the server's response content.
    * Format: print(f"RESPONSE: {{response.text}}")
4. Robust Request and Error Handling: The script MUST perform two checks:
    - Request Failure (Try/Except): It must wrap every 'requests.get' or 'requests.post' in a single `try...except requests.exceptions.RequestException` block. If the request fails (e.g., timeout, connection error), it must print the full exception: print(f"ERROR: REQUEST FAILED: {{e}}") and then exit the loop immediately with the FAILURE status.
    - Content Check (Post-Request): After a successful request, it MUST check the HTTP status code. If `response.status_code` is NOT 200, or if the content is not parsable, the script MUST print: print(f"ERROR: BAD RESPONSE: Status {{response.status_code}}. Content: {{response.text}}") and exit the loop immediately with the FAILURE status.
5. Stop Condition: The script must explicitly report its reason for exiting the loop.
    * SUCCESS Stop: If the response does NOT contain a 'url' key, print: print("FINAL STATUS: ***QUIZ SEQUENCE COMPLETE***")
    * FAILURE Stop: If a task response is incorrect or an error occurs, print: print("FINAL STATUS: !!!SEQUENCE FAILED/STOPPED!!!")

Your entire output must be only the complete, runnable Python code block.
"""
    # 1. Generate the Script
    try:
        # Use httpx.AsyncClient without 'verify=False' since DNS is resolved now
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
    
    # FIX 2: Explicitly pass global secrets to the subprocess environment
    env_vars["SECRET_KEY"] = SECRET_KEY 
    env_vars["AI_PIPE_TOKEN"] = AI_PIPE_TOKEN
    
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
        # Logs the detailed output from the generated solver script!
        logger.info(f"STDOUT: {result.stdout}") 
        if result.stderr:
            logger.error(f"STDERR: {result.stderr}")
            
    except subprocess.TimeoutExpired:
        logger.error("Script timed out externally.")
    except Exception as e:
        logger.error(f"Error executing script: {e}")
    finally:
        # Cleanup: Ensure temporary file is deleted
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
    # When deploying to Render, change port to 10000
    uvicorn.run(app, host="0.0.0.0", port=8000)
