# 🤖 Job Agent Bot

An AI-powered Telegram bot that automates the tedious parts of job applications. Send it a job description and it will analyze the role, score your fit, draft a tailored email, generate a cover letter, and even auto-fill Google Forms — all with a human-in-the-loop review before anything gets sent.

## ✨ Features

- **📊 Match Scoring** — AI evaluates how well your profile matches each job description
- **✍️ Email Drafting** — Generates professional application emails with multiple tone options (confident, formal, friendly)
- **📄 Cover Letter Generation** — Creates tailored PDF cover letters for each application
- **📝 Google Form Auto-Fill** — Scrapes form questions, generates profile-tailored answers, and lets you review before submitting
- **🔑 Google Sign-In** — Supports persistent browser sessions for forms requiring authentication
- **📋 Application Tracking** — Track all your applications and update statuses (sent, interview, offer, rejected, etc.)
- **🔐 Encrypted Credentials** — Email passwords are encrypted with AES-256-GCM before storage
- **⚡ Smart Caching** — Form questions and answers are cached by form ID to save tokens and speed up repeat submissions for users
- **👥 Multi-User** — Each user gets their own profile, resume, links, email config, and application history

## 🏗️ Architecture

```
job-agent-bot/
├── index.ts                        # Application entrypoint
├── prisma/
│   └── schema.prisma               # Database schema (PostgreSQL)
├── scripts/
│   └── test-form-pipeline.ts       # Standalone form pipeline test
└── src/
    ├── bot/                        # Telegram bot layer
    │   ├── handlers/
    │   │   ├── callbacks.ts        # Inline keyboard button handlers
    │   │   ├── commands.ts         # Slash command handlers
    │   │   └── messages.ts         # Free-text message handling (JD parsing, form flows)
    │   ├── botInstance.ts          # Bot init, menu commands, error handler
    │   ├── state.ts                # In-memory session state (pending emails, form reviews)
    │   ├── types.ts                # Session & context types
    │   └── utils.ts                # Helpers (URL parsing, form previews, role extraction)
    ├── config/
    │   └── env.ts                  # Environment variable validation (Zod)
    ├── data/
    │   ├── cv.ts                   # Default CV/profile template
    │   ├── db.ts                   # Prisma database access layer
    │   └── profile.ts              # User profile resolution helpers
    ├── integrations/
    │   ├── email.ts                # SMTP email sending (Nodemailer)
    │   └── googleForms/
    │       ├── aiPlanner.ts        # AI answer generation for form questions
    │       ├── formSubmitter.ts    # Playwright-based form field filling & submission
    │       ├── scraper.ts          # Headless browser form question scraper
    │       ├── session.ts          # Persistent browser profile management
    │       ├── types.ts            # Google Forms type definitions
    │       └── utils.ts            # Form utility helpers
    ├── services/
    │   ├── ai.ts                   # AI client initialization (Groq)
    │   ├── coverLetter.ts          # PDF cover letter generation
    │   ├── drafter.ts              # AI email draft generation & revision
    │   ├── matcher.ts              # AI job-profile match scoring
    │   └── parser.ts               # Job description parser
    └── types/
        └── job.ts                  # Shared job-related types
```

## 🚀 Getting Started

### Prerequisites

- **Node.js** v18+
- **PostgreSQL** database (or a hosted service like [Neon](https://neon.tech))
- **Telegram Bot Token** — create one via [@BotFather](https://t.me/BotFather)
- **Groq API Key** — get one at [groq.com](https://console.groq.com)

### Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/Damilarr/job-agent-bot.git
   cd job-agent-bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```
   Fill in your `.env`:
   ```env
   TELEGRAM_BOT_TOKEN=your_bot_token
   GROQ_API_KEY=your_groq_key
   DATABASE_URL=postgresql://user:password@host:5432/dbname
   EMAIL_ENCRYPTION_KEY=your_random_64char_hex_string
   HEADLESS=true
   ```

   > Generate an encryption key with:
   > ```bash
   > node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   > ```

4. **Set up the database**
   ```bash
   npx prisma db push
   npx prisma generate
   ```

5. **Start the bot**
   ```bash
   npm start
   ```

## 💬 Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Initialize the bot and see your setup checklist |
| `/set_email` | Connect your Gmail (with app password) for sending applications |
| `/set_resume` | Upload your resume PDF |
| `/set_profile` | Set your profile/CV text for AI matching |
| `/set_links` | Configure GitHub, LinkedIn, portfolio & custom links |
| `/my_applications` | View tracked applications and update statuses |
| `/my_status` | See your setup status and recent activity |
| `/download_resume` | Download your uploaded resume |
| `/download_cover_letter` | Download the last generated cover letter |
| `/connect_google` | Connect Google account for form applications requiring sign-in |
| `/update_status [id] [status]` | Update an application status |

## 📖 How It Works

1. **Send a job description** → The bot parses it, scores your match, drafts an email, and generates a cover letter
2. **Review & edit** → Edit the draft, change the tone, rename your resume attachment
3. **Send** → The bot sends the email with attachments via your connected Gmail
4. **Google Forms** → If the JD contains a Google Form link, the bot scrapes the questions, generates AI answers, shows you a preview, and submits after your approval

## 🛡️ Security

- Email passwords are encrypted with **AES-256-GCM** before database storage
- Encryption key is derived from your `EMAIL_ENCRYPTION_KEY` environment variable
- All database queries use **Prisma ORM** (no raw SQL, no injection risk)
- Sensitive files (`.env`, uploads, browser profiles) are excluded via `.gitignore`
- Google browser sessions are stored locally in `.browser_profiles/` with per-user isolation
