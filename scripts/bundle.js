'use strict';
// Tiny CommonJS bundler: inlines src/index.js and everything it requires
// (relative paths only) into one self-contained expression for n8n Code nodes.
const fs = require('fs');
const path = require('path');

function bundle(entryAbs, asKey) {
  const root = path.dirname(entryAbs);
  const mods = {};
  const order = [];

  function visit(abs) {
    const id = path.relative(root, abs).replace(/\\/g, '/');
    if (mods[id]) return id;
    const src = fs.readFileSync(abs, 'utf8');
    mods[id] = { src, deps: {} };
    order.push(id);
    const re = /require\((['"])(\.{1,2}\/[^'"]+)\1\)/g;
    let m;
    while ((m = re.exec(src))) {
      let target = path.resolve(path.dirname(abs), m[2]);
      if (!target.endsWith('.js')) target += '.js';
      mods[id].deps[m[2]] = visit(target);
    }
    return id;
  }
  const entryId = visit(entryAbs);

  const parts = order.map((id) => {
    const deps = JSON.stringify(mods[id].deps);
    return `  ${JSON.stringify(id)}: [function (module, exports, require) {\n${mods[id].src}\n}, ${deps}]`;
  });

  const open = asKey ? `const lib = { ${JSON.stringify(asKey)}: (function () {` : 'const lib = (function () {';
  const close = asKey ? '})() };' : '})();';
  return `// ---- bundled from src/ by scripts/build-workflows.js — edit src/, not this ----
${open}
  const __mods = {
${parts.join(',\n')}
  };
  const __cache = {};
  function __load(id) {
    if (__cache[id]) return __cache[id].exports;
    const module = { exports: {} };
    __cache[id] = module;
    const [fn, deps] = __mods[id];
    fn(module, module.exports, (name) => {
      if (deps[name]) return __load(deps[name]);
      throw new Error('module not bundled: ' + name);
    });
    return module.exports;
  }
  return __load(${JSON.stringify(entryId)});
${close}
// ---- end bundle ----
`;
}

module.exports = { bundle };
