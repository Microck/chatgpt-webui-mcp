export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert']],
    'scope-enum': [2, 'always', ['mcp', 'client', 'tools', 'deps', 'config', '*']],
    'subject-case': [2, 'always', 'lower-case'],
    'subject-max-length': [2, 'always', 72],
    'header-max-length': [2, 'always', 100],
    'footer-max-line-length': [0],
    'body-max-line-length': [0]
  }
};
