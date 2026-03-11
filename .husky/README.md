# Git Hooks

This directory contains Git hooks managed by Husky.

## Hooks

- `commit-msg`: Validates commit messages using commitlint to ensure they follow the Conventional Commits specification.

## Setup

The hooks are automatically installed via the `prepare` script in package.json:

```bash
npm run prepare
```

Or manually:

```bash
npx husky install
```
