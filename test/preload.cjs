const Module = require('node:module');
const path = require('node:path');
const original = Module._load;
const stub = {
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }), isTrusted: true },
  env: { language: 'en' },
};
Module._load = function (id, ...args) {
  if (id === 'vscode') return stub;
  if (id === '@xmcl/unzip') id = path.join(__dirname, '../node_modules/@xmcl/unzip/dist/index.js');
  if (id === '@xmcl/core/utils') id = path.join(__dirname, '../src/compat/xmcl-utils.ts');
  return original.call(this, id, ...args);
};
