import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['dashboard/tests/**/*.test.ts'], environment: 'node' } });
