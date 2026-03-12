# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Syncofy — a SaaS platform for pharmaceutical and physician KOL (Key Opinion Leader) intelligence in hematology. This is a single-file React application with no build system, package manager, or test framework. All dependencies are loaded via CDN/external imports.

## Files

- **syncofy_platform.jsx** — Production React component (~736 lines). This is the primary working file.
- **syncofy_platform_annotated.jsx** — Same code with extensive inline documentation and an open-items checklist. Treat as reference; keep in sync with production file when making changes.
- **syncofy_pan_hematology_handout.html** — Standalone printable 1-page marketing handout (HTML/CSS, no JS except QRCode library).

## Architecture

The platform merges three systems into one React component:

1. **ANCO 2026 Sales Flow** — Multi-step onboarding wizard (Profile → Services → Legal → Payment). Supports two user types: `pharma` and `physician`. Includes NPI verification and Stripe payment link integration.

2. **Supabase AI Engine** — Natural language search over a materialized view (`mv_provider_intelligence`, ~8,953 hematology providers). Queries go through Supabase PostgREST. Claude API calls are proxied via a Supabase Edge Function (`claude-proxy`). Intent detection parses user queries for disease, institution, tier, and name filters.

3. **KOL X Leaderboard** — Paginated, filterable provider rankings with freemium gating and FFPS scoring.

## Key Technical Details

- **No build tool or npm** — designed for direct embedding or deployment via Vite/CRA/static hosting.
- **Backend**: Supabase PostgREST (direct REST calls, no `supabase-js` SDK). RLS policies gate anon reads.
- **AI proxy**: Claude API accessed via `claude-proxy` Supabase Edge Function, not called directly from client.
- **Styling**: Inline CSS-in-JS with a constants object `C` defining the dark theme palette (`bg`, `surface`, `card`, `border`, `indigo`, `teal`, etc.). Fonts: DM Sans, Instrument Serif, JetBrains Mono (Google Fonts via `@import`).
- **Stripe**: Payment links are currently test URLs (see open items in annotated file).

## Development Notes

- No tests, linting, or CI/CD exist. Verification is manual (open in browser).
- To run locally, serve the JSX through any React-compatible dev server (Vite recommended) or embed in an HTML page with React 18+ and a JSX transformer.
- The Supabase anon key in source is a publishable client key (safe to commit). The `ANTHROPIC_API_KEY` lives server-side in the Edge Function environment.
- When editing, keep both `.jsx` files consistent — production and annotated versions should reflect the same logic.
