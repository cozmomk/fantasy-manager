import globals from 'globals';

// The rules that catch real bugs in this code base (undefined names, dead code, bad assignments, shadowing),
// listed explicitly so no extra package is needed.
const bugRules = {
  'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
  'no-redeclare': 'error', 'no-const-assign': 'error', 'no-dupe-keys': 'error', 'no-dupe-args': 'error',
  'no-dupe-else-if': 'error', 'no-duplicate-case': 'error', 'no-unreachable': 'error', 'no-unsafe-finally': 'error',
  'no-cond-assign': 'error', 'no-self-assign': 'error', 'no-self-compare': 'error', 'no-sparse-arrays': 'error',
  'no-func-assign': 'error', 'no-import-assign': 'error', 'no-inner-declarations': 'off',
  'no-shadow-restricted-names': 'error', 'no-unsafe-negation': 'error', 'use-isnan': 'error', 'valid-typeof': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }], 'no-extra-boolean-cast': 'error', 'no-loss-of-precision': 'error',
  'no-useless-escape': 'warn', 'no-prototype-builtins': 'warn', 'require-atomic-updates': 'off',
  eqeqeq: ['warn', 'always', { null: 'ignore' }], 'no-use-before-define': ['error', { functions: false, classes: true, variables: false }],
};

export default [
  { ignores: ['node_modules/', 'data/', '.browser-profile/'] },
  {
    // the Chrome extension content script runs in a page, as a classic script
    files: ['extension/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.browser, chrome: 'readonly' } },
    rules: bugRules,
  },
  {
    // node scripts and tests
    files: ['scripts/**/*.js', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
    rules: bugRules,
  },
];
