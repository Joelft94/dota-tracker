import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
export default {
  images: { unoptimized: true },
  // The repo root also has a lockfile (the poller); pin the root to this directory
  // so Turbopack doesn't guess.
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
};
