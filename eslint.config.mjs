import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', 'node_modules/**', '.vscode-test/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { require: 'readonly', process: 'readonly', __dirname: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Layer rule: core is pure TypeScript and must never touch the VS Code API.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [{ name: 'vscode', message: 'src/core must not import vscode (layer rule).' }] }],
    },
  },
  {
    // Git is always spawned with execFile and an argument array, never through a shell.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: "CallExpression[callee.property.name='exec']", message: 'Use execFile with an argument array.' },
        { selector: "CallExpression[callee.property.name='execSync']", message: 'Use execFile with an argument array.' },
        { selector: "Property[key.name='shell'][value.value=true]", message: 'Never spawn through a shell.' },
      ],
    },
  },
);
