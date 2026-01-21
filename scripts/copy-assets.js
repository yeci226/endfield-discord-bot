const fs = require("fs");
const path = require("path");

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

const srcAssets = path.join(__dirname, "../src/assets");
const distAssets = path.join(__dirname, "../dist/assets");

if (fs.existsSync(srcAssets)) {
  console.log("Copying assets...");
  copyDir(srcAssets, distAssets);
  console.log("Assets copied successfully.");
} else {
  console.warn("Source assets directory not found.");
}
