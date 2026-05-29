# CamSync Agent Guide

## Project Summary

CamSync is a mobile-first static web app for comparing a security camera's displayed time against the device clock and recording the time drift. It runs fully client-side and stores records in the browser's IndexedDB.

## Working Rules

- Respond to the user in Japanese.
- Check existing files and patterns before editing.
- Keep the app dependency-free unless the user explicitly asks for a larger framework or build setup.
- Preserve the single-file app structure unless a refactor clearly requires splitting files.
- Do not introduce server-side storage; records are intended to stay on the user's device.
- Treat exported Markdown as a user-facing record format. Keep import/export compatibility when changing labels or fields.
- After changes, verify with a browser where practical. If only static checks are possible, report that clearly.

## Current Architecture

- Main app: `index.html`
- UI: inline HTML and CSS
- Logic: inline vanilla JavaScript
- Persistence: IndexedDB database `CamSyncDB`, object store `records`
- Main screens: calculator, history, info

## Product Intent

The app is for documenting the time offset of security camera footage. Important fields include reference time, camera time, drift, camera location, viewing date, extraction date/time range, witness information, and notes.
