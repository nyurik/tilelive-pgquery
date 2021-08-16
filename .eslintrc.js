module.exports = {
  extends: 'kartotherian',
  env: {
    node: 1,
  },
  globals: {
    exampleGlobalVariable: true,
  },
  rules: {
    'prefer-destructuring': ['error', {
      AssignmentExpression: {
        array: false,
        object: false,
      },
    }],
  },
};
