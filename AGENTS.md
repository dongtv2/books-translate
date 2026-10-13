# Repository Guidelines

## Project Structure & Module Organization

This repository is a Vite/React frontend with an Express/SQLite backend. Frontend routes live in `src/pages/`, reusable UI in `src/components/`, and shared browser logic in `src/lib/`, `src/hooks/`, and `src/context/`. Backend startup and persistence are in `server/index.js` and `server/db.js`; API endpoints are grouped under `server/routes/`, with authentication, importers, LLM adapters, and speech services in their corresponding `server/` subdirectories. Static files belong in `public/`, brand assets in `design/`, and generated frontend output in `dist/` (do not edit it directly). Runtime data is stored under `server/data/` and should not be committed.

## Build, Test, and Development Commands

- `npm install` installs JavaScript dependencies.
- `npm run dev` starts the Vite client and watched Express server together. The client is at `http://localhost:5173`; API requests proxy to port 3001.
- `npm run build` creates the production frontend in `dist/`.
- `npm start` serves the production app and API through Express.
- `npm run lint` runs Oxlint.
- `npm run preview` previews the built frontend through Vite.

There is no repository-level automated test script currently. For changes, run lint and build as appropriate, then manually exercise the affected page or API with representative data.

## Coding Style & Naming Conventions

Use the existing JavaScript ES module style. React components and page modules use PascalCase filenames (for example, `ParagraphCard.jsx`); utilities and server modules use camelCase (for example, `vocabMatch.js`). Use two-space indentation and keep UI components focused on a clear responsibility. Follow nearby patterns for API errors, SQLite queries, and React hooks. Oxlint is configured with React and Oxc rules; resolve errors and avoid introducing hook-rule warnings.

## Testing Guidelines

No dedicated test framework or coverage threshold is configured. When adding tests, colocate them with the relevant module or use a clearly named test directory, and document any new test command in `package.json`. Until then, verify changes with `npm run lint`, `npm run build`, and focused manual checks. For database or import changes, use disposable sample data rather than personal `server/data/` content.

## Commit & Pull Request Guidelines

Git history is not available in this checkout, so no established commit-message convention can be confirmed. Write short imperative commit subjects (for example, `Fix chapter import headings`). Pull requests should explain user-visible behavior, summarize implementation and data/schema impacts, list verification performed, and include screenshots for visual changes. Link related issues when available.

## Security & Configuration

Start from `.env.example`; keep real credentials and local database files out of commits. Configure AI providers in the app where supported, and do not log API keys, passwords, or session secrets. Treat imported book content as untrusted input and preserve the server's permission checks on protected API routes.
