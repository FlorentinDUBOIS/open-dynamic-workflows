import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        crypto: 'readonly',
        __dirname: 'readonly',
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['packages/vscode-extension/**/*.js', 'packages/codex-adapter/**/*.js', 'packages/antigravity-adapter/**/*.js', 'packages/openclaw-adapter/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
    },
  },
  {
    // Orchestration scripts run inside the odw sandbox, where the runtime
    // primitives are injected globals (see daemon/src/guest-prelude.js).
    files: ['examples/workflows/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        agent: 'readonly',
        parallel: 'readonly',
        pipeline: 'readonly',
        verify: 'readonly',
        loop: 'readonly',
        phase: 'readonly',
        log: 'readonly',
        checkpoint: 'readonly',
        compact: 'readonly',
        summarize: 'readonly',
        budget: 'readonly',
        args: 'readonly',
        context: 'readonly',
      },
    },
  },
  {
    ignores: ['**/node_modules/**', 'coverage/**', '**/*.min.js'],
  },
];
