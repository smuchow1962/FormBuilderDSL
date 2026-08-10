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
                process: 'readonly',
                structuredClone: 'readonly'
            }
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }]
        }
    },
    {
        // Jest injects describe / test / it / expect as globals; the suite no
        // longer imports them from node:test.
        files: ['tests/**/*.js'],
        languageOptions: {
            globals: {
                describe: 'readonly',
                test: 'readonly',
                it: 'readonly',
                expect: 'readonly',
                beforeEach: 'readonly',
                afterEach: 'readonly',
                beforeAll: 'readonly',
                afterAll: 'readonly'
            }
        }
    }
];
