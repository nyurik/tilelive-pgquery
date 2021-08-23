module.exports = {
  env: {
    mocha: true,
  },
  parserOptions: {
    ecmaVersion: 11,
  },
  rules: {
    // It is okay to import devDependencies in tests.
    'import/no-extraneous-dependencies': [2, { devDependencies: true }],
  },
};
