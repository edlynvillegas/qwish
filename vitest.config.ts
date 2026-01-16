import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Shared configuration
    globals: true,
    environment: 'node',
    
    // Define separate "projects" for Unit and Integration tests
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts', 'src/**/*.vitest.ts'],
          exclude: ['src/tests/integration/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/tests/integration/**/*.vitest.ts'],
          // This project only runs if the environment variable is set
          globalSetup: './vitest.setup.ts',
          setupFiles: [], // Add logic here if you need per-file setup
        },
      },
    ],
  },
});