🚀 LLM Analysis Quiz Solver

This project implements an automated, iterative agent designed to solve a sequence of data sourcing, preparation, and analysis quizzes using a Large Language Model (LLM) within a strict time limit. The application is built using FastAPI to serve a public endpoint and executes the quiz-solving logic in the background via a dynamically generated Python script.

📝 Project Overview

The primary goal is to accept a quiz task via a POST request, rapidly analyze the initial quiz page, and then enter an iterative loop to solve multiple linked quizzes until the task sequence is complete or the 3-minute time limit is reached.

Key features include:

API Endpoint: An asynchronous FastAPI server (/quiztasks) for receiving evaluation requests.

Secret Validation: Verification of the submission secret for security.

Dynamic Code Generation: Uses a powerful LLM to dynamically write a specialized, self-contained Python script (the "Solver") optimized for the quiz structure.

Time Management: The Solver script includes an internal check to ensure the entire execution stops before the 180-second deadline.

Iterative Solving: The Solver automatically parses submission responses to find the next quiz URL and continue the sequence until completion.

⚙️ Setup and Installation
Follow these steps to get your project running locally.

1. Prerequisites
You must have Python 3.8+ installed.

2. Clone the Repository
Bash

git clone YOUR_REPO_URL
cd llm-analysis-quiz-solver
3. Install Dependencies
All required libraries are listed in requirements.txt.

Bash

pip install -r requirements.txt
4. Environment Configuration
Create a file named .env in the root directory and populate it with your credentials:

Ini, TOML

# .env file
# The secret provided in the Google Form
SECRET_KEY="your_google_form_secret_string" 

# Your token for the LLM service (e.g., AIPipe)
AI_PIPE_TOKEN="your_ai_pipe_access_token" 

# The email associated with your token/quiz submission
USER_EMAIL="24f1001642@ds.study.iitm.ac.in" 

# Optional: Configuration for the LLM service
AI_PIPE_URL=https://api.pip.ai/v1/chat/completions
LLM_MODEL=gpt-4o 
Note: Do not commit the .env file to your repository.

▶️ Running the Application
Execute the main server file using Uvicorn:

Bash

python main.py
# Or: uvicorn main:app --host 0.0.0.0 --port 8000
The application will start running on http://0.0.0.0:8000. You must use a public deployment method (like a cloud service or ngrok) to expose this endpoint to the project evaluators.

💻 System Design: The Dual-LLM Strategy
The application uses a Two-Tier LLM Architecture to ensure flexibility and robust execution .

The Programmer LLM (Static Prompt): This is the LLM call made from within main.py. Its role is to generate a fully functional, self-contained Python script. It handles the complex logic (time tracking, recursive fetching, extraction methods like Base64 decoding, and error handling).

The Solver LLM (Dynamic Call): This is the LLM call made inside the generated script. Its role is simple: to answer the specific data analysis question extracted from the quiz page. This separation ensures the logic is resilient while keeping the analysis focused and fast.

📜 Repository Compliance
Public Repository: This repository is set to public access for evaluation.

License: The project is distributed under the MIT License.
