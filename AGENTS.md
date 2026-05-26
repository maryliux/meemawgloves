# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

This is a single Next.js 16 (App Router) application located in `hand-instrument-app/`. It is a client-side webcam-based musical instrument using MediaPipe Hands and Tone.js. There is no backend, no database, and no environment variables required.

### Running the dev server

```bash
cd hand-instrument-app
pnpm dev
```

Server starts on http://localhost:3000.

### Lint

The `pnpm lint` script calls `eslint .` but ESLint is neither installed as a dependency nor configured. Running `pnpm lint` will fail. If you need linting, install eslint and add a config first.

### Build

```bash
pnpm build
```

TypeScript type errors are ignored in production builds (`next.config.mjs` sets `typescript.ignoreBuildErrors: true`).

### Testing

There are no automated tests in this project. Verify changes by running `pnpm build` and visually inspecting the app at http://localhost:3000.

### Key caveats

- The app requires a webcam and microphone via `navigator.mediaDevices.getUserMedia`. In headless/VM environments without a camera, clicking "Enable Webcam" will show a "Camera Access Blocked" error — this is expected behavior.
- MediaPipe Hands model files are loaded from `cdn.jsdelivr.net` at runtime — internet access is required.
- The `pnpm-lock.yaml` lockfile uses pnpm. Do not switch to npm or yarn.
- The `sharp` package build script is ignored by pnpm (see build warning during install); this does not affect development.
