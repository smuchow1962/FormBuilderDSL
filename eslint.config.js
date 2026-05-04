import js from '@eslint/js';

export default [
    js.configs.recommended,
    { ignores: ['**/node_modules/**'] },
    {
        files: ['src/**/*.js', 'tests/**/*.js', 'scripts/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                console: 'readonly',
                process: 'readonly'
            }
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }]
        }
    }
];
