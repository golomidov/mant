# Contributing

Use Bun 1.4.4, React, TypeScript, Vite, and Oxlint. Use Bun APIs, including `bun:sqlite` for SQLite. Keep the app a client-rendered SPA; do not introduce Node.js scripts, Babel, PostCSS, Python, or SSR.

Install dependencies with `bun install --frozen-lockfile`. Before opening a pull request, run:

```sh
bun test
bun run lint
bun run build
```

Keep changes focused. Add regression coverage for behavior changes; avoid tests that simply repeat the implementation. Describe the problem, the resulting behavior, and how you checked it. For capture issues, include the macOS version, call application, selected sources, and routing setup, using synthetic or redacted examples.

The ordinary suite needs no API key. Live checks are optional and make paid requests:

```sh
bun run test:live /absolute/path/to/short-recording.wav
bun --no-env-file scripts/conversation-goals-smoke.ts --live
```

## README videos

Use two or three short MP4 videos encoded with H.264. Keep each below 10 MB to work with GitHub's free-plan upload limit.

On GitHub, open a new issue or pull request comment editor and drag in the video. Wait for the upload, then copy the generated `https://github.com/user-attachments/assets/...` URL. You do not need to submit the comment. In the README's Demos section, paste that URL on its own line, surrounded by blank lines, below a descriptive heading. Preview the README to check the player, then remove the “coming soon” text and template comment.

Videos are hosted by GitHub and play in the README. Keep the video binaries out of Git history. Use demonstrations without personal conversations, names, or credentials.

References: [GitHub attachments](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files) and [inline video Markdown](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli).
