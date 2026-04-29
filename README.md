# Multi-Platform Content Syndicator Agent

A local-first Node.js CLI MVP designed to extract content from a URL, use LLM (OpenAI) to generate an engaging Markdown article, and syndicate it to multiple blogging platforms (Dev.to, Telegra.ph, Medium) after manual approval, then logging the results to Google Sheets.

## Features

- **Web Scraping:** Uses Playwright and Mozilla Readability to extract clean article content and images from any URL.
- **LLM Re-writing:** Re-writes and formats the extracted content into publish-ready Markdown using OpenAI.
- **Human-in-the-Loop (HITL):** Pauses execution to preview the generated title and content. Requires manual confirmation before publishing.
- **Damping/Brake (Rate Limiting):** Applies 5-15s random sleep between API requests to mitigate spam-flagging risks.
- **Google Sheets Sync:** Automatically logs timestamp, original URL, generated title, and published URLs to your Google Sheet.

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy the `.env.example` to `.env`:

```bash
cp .env.example .env
```

Fill in the `.env` values:

- `OPENAI_API_KEY`: Get from [OpenAI Dashboard](https://platform.openai.com/api-keys).
- `DEVTO_API_KEY`: Generate an API key from your Dev.to Settings -> Extensions.
- `MEDIUM_INTEGRATION_TOKEN`: Generate from Medium Settings -> Security and Apps -> Integration Tokens.
- `GOOGLE_APPLICATION_CREDENTIALS_JSON`: Create a Google Cloud Project, enable Google Sheets API, create a Service Account, generate a JSON key, and minify it (or pass the path to the file if modified in code). Provide the raw JSON string here.
- `GOOGLE_SHEET_ID`: The ID of your Google Sheet (found in the URL: `https://docs.google.com/spreadsheets/d/<THIS_IS_THE_ID>/edit`). *Don't forget to share your Sheet with the email address of the Service Account (e.g., `xxx@your-project.iam.gserviceaccount.com`).*

**Note on Telegra.ph:** Telegra.ph adapter handles its own anonymous account creation. No token is needed in `.env`.

### 3. Run the Agent

```bash
npm start
```

## Example Usage

1. **Input:** `https://example.com/some-great-article`
2. **LLM Output:** "A highly engaging title based on the original" and generated markdown.
3. **Approve:** Type `y` or `N`.
4. **Publishing:** 
   - Publishes to Telegra.ph... sleeps for 8s.
   - Publishes to Dev.to... sleeps for 12s.
   - Publishes to Medium...
5. **Google Sheets Sync:** Appends a row with the generated links.

## Limitations / Out of Scope (MVP v0.1)

- Supports 3 MVP platforms only. WordPress, Tumblr, etc. are deferred to future iterations.
- Playwright is used for scraping, but publishing relies entirely on APIs.
- Captcha bypass and automated browser publishing are not handled in this version.
- Ensure your Google Service Account has `Editor` access to the target Google Sheet.
