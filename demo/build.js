const fs = require('fs'), path = require('path');
const r = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let html = r('demo/template.html');
const parts = { CSS: r('src/renderer/style.css'), LIBS: [r('src/tokenize.js'), r('src/search.js'), r('src/renderer/creature.js')].join('\n'), MOCK: r('demo/mock.js'), RENDERER: r('src/renderer/renderer.js'), DEMO: r('demo/demo.js') };
for (const k in parts) html = html.replace('{{' + k + '}}', () => parts[k]);
fs.writeFileSync(path.join(__dirname, 'gofer-demo.html'), html);
console.log('built', html.length, 'bytes');
