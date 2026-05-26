# Hand Instrument

Interactive audiovisual instrument built with Next.js, Tone.js, and MediaPipe Hands.

The app:

- captures webcam video,
- tracks one hand in real time,
- maps wrist height to oscillator frequency,
- maps finger spread to output volume, and
- renders a stylized halftone star field plus hand landmarks.

## Getting started

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000` and click **Enable Webcam**.

## Scripts

- `pnpm dev` – start local development server
- `pnpm lint` – run ESLint
- `pnpm build` – production build
- `pnpm start` – run production server

## Notes

- Camera and audio permissions are required.
- For best results, test in a browser tab (not embedded preview surfaces that block camera access).
