# Contributing

Thank you for your interest in contributing to chatgpt-webui-mcp!

## Commit Message Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/) format for commit messages.

### Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `build`: Build system changes
- `ci`: CI/CD changes
- `chore`: Maintenance tasks
- `revert`: Revert a previous commit

### Scopes

Common scopes (examples):
- `mcp`: MCP server changes
- `client`: ChatGPT WebUI client changes
- `tools`: Tool-related changes
- `deps`: Dependency updates
- `config`: Configuration changes

### Subject

- Use imperative mood ("add" not "added", "fix" not "fixed")
- Start with lowercase letter
- Maximum 72 characters
- No period at end

### Body

- Explain what and why, not how
- Wrap at 72 characters per line
- Optional for single-line commits

### Footer

- Reference issues: `Closes #123` or `Fixes #456`
- Add Nightshift task tracking (if applicable):
  - `Nightshift-Task: <task-id>`
  - `Nightshift-Ref: https://github.com/marcus/nightshift`

### Examples

```
feat(mcp): add image generation support

Add create_image mode to chatgpt_webui_prompt tool.
This enables image generation through ChatGPT WebUI.

Closes #15

Nightshift-Task: feature:image-generation
Nightshift-Ref: https://github.com/marcus/nightshift
```

```
fix(client): handle delayed image download extraction

Extract image URLs from response even if download completes
after initial response processing.

Fixes #23
```

## Development

### Setup

```bash
npm install
npm run build
```

### Running

```bash
npm run dev      # Watch mode with tsx
npm run start    # Run compiled output
```

### Testing

```bash
npm run typecheck   # TypeScript type checking
npm run self-test   # Run self-test suite
```

### Linting

Commit messages are validated using [commitlint](https://commitlint.js.org/):

```bash
npm run lint:commit    # Lint commit messages (requires .git/COMMIT_EDITMSG)
```

Note: Set up a git hook to automatically lint commit messages:

```bash
npx husky install
npx husky add .husky/commit-msg 'npx --no -- commitlint --edit $1'
```

## Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/your-feature`)
3. Follow the commit message convention
4. Push to your fork (`git push origin feat/your-feature`)
5. Open a pull request

Ensure all tests pass and your code follows the existing style.
