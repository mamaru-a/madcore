/**
 * Entry point for the full live E2E suite.
 * Implementation lives in modular files under `test/live/`.
 *
 *   SERVER_URL=https://… JOIN_URI='https://i.delta.chat/#…' bun run test:live-full
 */
import './live/run.ts';
