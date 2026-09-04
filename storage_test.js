const fs = require('fs');

const source = fs.readFileSync('./grayscale_line_tool.js', 'utf8');

const requiredChecks = [
  'localStorage',
  'saveCurrentImageToStorage',
  'restoreSavedImageFromStorage',
  'grayscale-line-tool:image'
];

const missing = requiredChecks.filter((token) => !source.includes(token));
if (missing.length > 0) {
  throw new Error(`Missing required persistence hooks: ${missing.join(', ')}`);
}

console.log('Persistence hooks detected.');
