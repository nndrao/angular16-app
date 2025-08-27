const fs = require('fs');
const path = require('path');

// Ensure assets/lib directory exists
const assetsLibDir = path.join(__dirname, '../src/assets/lib');
if (!fs.existsSync(assetsLibDir)) {
  fs.mkdirSync(assetsLibDir, { recursive: true });
}

// Copy STOMP.js library from node_modules to assets
const sourcePath = path.join(__dirname, '../node_modules/@stomp/stompjs/bundles/stomp.umd.min.js');
const destPath = path.join(assetsLibDir, 'stomp.umd.min.js');

try {
  fs.copyFileSync(sourcePath, destPath);
  console.log('✅ STOMP.js library copied to assets/lib/');
} catch (error) {
  console.error('❌ Failed to copy STOMP.js library:', error.message);
  process.exit(1);
}
