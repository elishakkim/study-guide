# Study Guide — Flashcards & Quizzes

A zero-dependency, static web app for studying system-design material as flashcards, multiple-choice questions, quizzes, and summaries. Open a folder of study-guide JSON files and review them interactively. Progress is saved locally in your browser.

## Features

- **Flashcards** — flip, shuffle, and mark cards as "known"
- **Quizzes** — multiple-choice, true/false, and fill-in-the-blank with instant grading and scoring
- **More study modes** — ordering, mix-and-match, scenarios, short-answer, active recall, and interview-style prompts
- **Composable renderer** — any additional JSON sections render automatically as readable reference cards
- **Book grouping** — chapters are grouped and switchable by book
- **Local progress** — known cards, quiz answers, and last location persist via `localStorage` (no server or database)

## Run it

It's a static site. Serve it over `http://` so the study guides load automatically:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

> Note: opening `index.html` directly via `file://` won't auto-load the files (browsers block local `fetch`). Use the local server, or use the in-app folder/file picker.

## Load your own content

Click **Change folder** to open any folder of `.json` study guides, or pick individual files. Files served from `json_docs/` are auto-loaded on startup.

## Tech

Plain HTML, CSS, and vanilla JavaScript. No build step, no dependencies.

## Content notice

The study-guide JSON files summarize concepts from copyrighted books and are intended for personal study use only.
