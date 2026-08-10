// Jest configuration for FormBuilderDSL.
//
// The package is pure ESM ("type": "module") and ships untranspiled source,
// so there is nothing to transform: `transform: {}` disables babel-jest
// entirely and Jest loads src/ and tests/ as native ES modules. That requires
// Node's VM-modules flag, which the npm scripts supply by invoking Jest as
// `node --experimental-vm-modules node_modules/jest/bin/jest.js` — spelled out
// that way (rather than NODE_OPTIONS=...) so the scripts work unchanged on
// Windows cmd.exe, PowerShell, and POSIX shells.
//
// Coverage thresholds are the same numbers the retired c8 config carried.

export default {
    testEnvironment: 'node',

    // Native ESM: no transpilation step.
    transform: {},

    testMatch: ['<rootDir>/tests/**/*.test.js'],

    // Realm-binds structuredClone; see the file header for why.
    setupFiles: ['<rootDir>/tests/jest.setup.js'],

    coverageProvider: 'v8',
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov', 'html'],
    collectCoverageFrom: ['src/**/*.js', '!src/version-generated.js'],
    coverageThreshold: {
        global: {
            lines: 85,
            branches: 75,
            functions: 85,
            statements: 85
        }
    }
};
