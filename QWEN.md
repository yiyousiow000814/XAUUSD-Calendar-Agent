# XAUUSD News Automation Agents Documentation (Qwen Edition)

This document mirrors `AGENTS.md` and adds Qwen-specific tips.

## Agent Defaults (Repository-Wide Behavior)
- **Purpose**: Define repository-wide agent behavior and safety policies.
- **Maintenance Reminder**: Keep `AGENTS.md` and `QWEN.md` synchronized whenever you adjust shared policies. Model-specific notes may live only in `QWEN.md`, but common guidance must stay identical.
- **Check**: When editing shared policies, update both files in the same PR.
- **Document Language**: Write instructions in English. Examples may contain other languages when it improves clarity.
- **Natural English Only**: Compose guidance directly in fluent English; avoid machine-translated phrasing.
- **Language**: During day-to-day work reply in Simplified Chinese by default. If a request is prefixed with `[EN]`, respond in English.
- **Terminology Preservation**: Do not translate proper nouns such as `Selenium`, `XAUUSD`, `PostgreSQL`, or API names.
- **Location References (Replies)**: Prefer file/module names (e.g., `prob_gate`) over explicit paths or line numbers.
- **Date/Time Format**: Always use day-month-year ordering; never use month-day-year in outputs or docs.
- **Known Issues Format**: Use numbered lists (e.g., `1. item`), not bullet lists (e.g., `- item`).
- **Evidence Requirement**: Every conclusion must be backed by reproducible commands or scrape steps. Describe the original state (A), the change you made, and the resulting state (B).
- **GitHub Language Convention**: PR and issue titles stay in English. Descriptions and regular comments default to Simplified Chinese, unless the request explicitly begins with `[EN]`.
- **PR Comment Policy**: Do not create PR comments unless the user explicitly asks for them.
- **Check**: PR review verifies English in `AGENTS.md` and Simplified Chinese default in bot replies.
- **Docs/Comments Tone**: Avoid historical/comparative notes (e.g., "previously...", "no longer...", "used to..."); describe current behavior directly.
- **Git/GitHub Operations**: Assume credentials exist. If a command fails, rely on the terminal output for next steps rather than re-confirming access.
- **Execution Strategy**:
  - Seek confirmation before destructive actions (history rewrites, mass deletions, force pushes).
  - Routine steps (opening branches/PRs, syncing remotes, running formatters or lint) do not require extra approval.
- **Codex Skills**: If Codex skills are installed locally (usually under `$CODEX_HOME/skills/`), the `commit-push-pr-workflow` skill provides a standardized commit + push + draft PR workflow aligned with this repo's conventions (see the skill doc for step-by-step commands).
- **Branch & PR Habits**:
  - Use prefixes such as `feat/*`, `fix/*`, `docs/*`, or `chore/*`.
  - If custom naming is required, follow the instruction; otherwise default to `main` as the target branch.
  - Never commit directly to `main`; always ship changes through a pull request.
  - Default PRs to draft; convert to ready only when the change is reviewable.
- **Cross-Platform Compatibility**: Ensure scripts run on both Linux and Windows (e.g., avoid hard-coded paths, document external binaries).
- **Data Safety**: Never commit API keys, cookies, browser profiles, or raw scraped data. Store temporary artifacts under ignored directories (e.g., `tmp/`) and clean them up before committing.
- **Automation Context**: When scraping fails, record failing selectors, HTTP status codes, or rate-limit behaviour so future maintainers can reproduce the issue quickly.

## Codex Execution Policy
- Avoid running commands that generate binary artifacts. When unavoidable, exclude them from commits.
- `.exe` are build outputs. They must remain gitignored and must never be committed.
- After completing the verification checklist for a task (format/lint/tests as applicable), run `app/installer/build_installer.ps1` to regenerate the installer executables locally.
- Publish installer executables via GitHub Releases assets, not in the repository.
- If `app/installer/build_installer.ps1` fails due to the app being open or files being locked, force close the running app/process and re-run the build immediately.

## Clipboard Screenshots
- Pasted images named `codex-clipboard-*.png` are saved in `%TEMP%` (e.g., `%USERPROFILE%\AppData\Local\Temp`) rather than root `/temp`.
- If a request includes clipboard screenshots, open them with the image viewer tool before responding and explicitly note in the response that they were reviewed.
- When a UI issue is found via images or ui-check artifacts, expand ui-check coverage (new assertions, screenshots, or multi-step scenarios) so the issue becomes detectable in future runs. Keep improving the subjective review loop based on those artifacts.
- For each UI change, run `npm run ui:check` and generate a fresh `app/tests-ui/artifacts/ui-check/report.html`.
- After each UI change, randomly sample 5 Light/Dark `ui-check` images and review them one by one; if any issue is found, fix it, re-run `ui:check`, then randomly sample another 5 Light/Dark images and repeat until no issues remain. System Light/Dark can be skipped unless a discrepancy is suspected.

## UI Maintainability
- If a single file exceeds 800 lines, recommend splitting it into smaller, focused modules.
- Keep component styles co-located with the component (e.g., `SettingsModal.css`, `Select.css`), and reserve global styles for tokens and base rules only.

## Code Style Requirements
We rely on automated tools to keep the Python codebase consistent and readable:

- **Black** formats code automatically.
- **isort** groups and orders imports.
- **Flake8** enforces PEP 8 and highlights potential issues.

### Configuration Files
- `pyproject.toml` provides the shared settings for both `black` and `isort`.
- `.flake8` defines ignore rules and the maximum line length for linting.
- `.pre-commit-config.yaml` specifies the `pre-commit` hooks that run these tools.

### Required Tool Usage
1. Install the tools:
   ```bash
   pip install black isort flake8 pre-commit
   ```
2. Format the code:
   ```bash
   black .
   isort .
   ```
3. Lint the code:
   ```bash
   flake8 .
   ```
4. (Optional) Enable automatic checks:
   ```bash
   pre-commit install
   ```

Important: run **isort → black → flake8** before commit/push, and ensure all checks pass.

Run these steps after every code change.

### CI/CD Integration
GitHub Actions runs the same formatting and linting checks on each push and pull request to enforce quality automatically.

## PR/Issue Comment and Description Format (Important)
To avoid literal `\n` appearing on GitHub, follow these conventions:

- **Language Requirements**: Descriptions and comments default to Simplified Chinese; titles must stay in English. Automatically generated Codex replies (reviews or regular comments) should also be in Chinese unless the request starts with `[EN]`.
- Use `--body-file` or standard input for multi-line content. Avoid `--body` with escaped newlines.
- Recommended pattern using a here document (Bash/Zsh):

  ```bash
  # Add a new comment
  gh pr comment <number> -F - <<'EOF'
  Summary:
  - line 1
  - line 2

  Notes:
  - more lines
  EOF

  # Edit your most recent comment
  gh pr comment <number> --edit-last -F - <<'EOF'
  ...multi-line content...
  EOF
  ```

- PowerShell note: do not type `EOF` when using stdin; end interactive input with `Ctrl+Z` then `Enter`, otherwise `EOF` becomes literal text in the PR body/comment.

- PowerShell equivalent patterns:

  ```powershell
  # Add a new comment
  @'
  Summary:
  - line 1
  - line 2

  Notes:
  - more lines
  '@ | gh pr comment <number> -F -

  # Edit your most recent comment
  @'
  ...multi-line content...
  '@ | gh pr comment <number> --edit-last -F -

  # Update PR description
  @'
  # Keep the title unchanged; update only the body
  <markdown body>
  '@ | gh pr edit <number> --body-file -
  ```

- Updating the PR description:

  ```bash
  gh pr edit <number> --body-file - <<'EOF'
  # Keep the title unchanged; update only the body
  <markdown body>
  EOF
  ```

- If you need to use a file:

  ```bash
  printf 'line1\n\nline2\n' > /tmp/msg.md
  gh pr comment <number> --body-file /tmp/msg.md
  ```

These conventions apply to all automated and manual interactions in this repository.

## Qwen-Specific Notes
- Qwen tends to produce long responses - lead with the conclusion, then outline the supporting steps so output stays scannable.
- When documenting Selenium flows, mention both CSS/XPath selectors and fallback heuristics to ease future maintenance if the site changes.
- Prefer bullet lists when returning event calendars or headline summaries so readers can digest the information quickly.

## Suggested Workflow (Qwen)
1. Create a branch from `main` with a scoped name.
2. Modify or add automation scripts/documentation.
3. Run `isort`, `black`, then `flake8`; log unavoidable lint debt in your notes.
4. Update `README.md` if behaviour or dependencies change.
5. Push, open a PR, and summarise the change set in Chinese.
6. Where practical, validate the automation against the target website/data source and describe the outcome for reviewers.
