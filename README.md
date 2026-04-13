# Affiliate API Auto Tests

This project now contains two layers:

1. A Playwright API regression suite
2. A local full-stack API testing platform with frontend + backend

## Current scope

- `POST /api/affiliate/referral-code/create`
- `GET /api/affiliate/referral-code/list`
- `POST /api/affiliate/referral-code/update`
- `POST /api/affiliate/referral-code/set-default`
- `GET /api/affiliate/code-info/:code`

## Install

```bash
npm install
```

## Start the local platform

```bash
npm start
```

Then open:

```text
http://localhost:3006
```

## Platform capabilities

- Manage interfaces in the UI
- Add and edit cases under each interface
- Build multi-step scenarios with variable extraction / variable reference / step assertions
- Maintain base URL and auth profiles
- Run with case-level auth or temporarily override all authenticated cases to a selected account
- Configure AI URL / API key / model
- Run all cases with one click
- Store run history locally
- Generate AI analysis for the latest run or any selected run
- Upload API docs and let AI append interfaces and test cases automatically

## Playwright regression suite

Run the code-based regression suite:

```bash
npm test
```

Open the Playwright HTML report:

```bash
npm run report
```

## Data storage

Local JSON files:

- `data/settings.json`
- `data/interfaces.json`
- `data/runs.json`
- `data/scenarios.json`
- `data/ai-reports/*.md`

## Notes

- The UI runner validates business JSON payloads (`code`, `data`, `message`) and supports basic expectations:
  - `httpStatus`
  - `businessCode`
  - `messageIncludes`
- AI integration is designed for an OpenAI-compatible `chat/completions` endpoint.
- API document import currently works best with text-based docs such as `md`, `txt`, `json`, and `yaml`.
- The default seed data already includes the current affiliate referral APIs and two test users.
