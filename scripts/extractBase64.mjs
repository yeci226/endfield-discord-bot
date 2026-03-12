/**
 * extractBase64.mjs
 * Usage: node extractBase64.mjs <file-or-dir> [output-dir]
 *
 * Scans one or more JS files for base64-encoded content and saves decoded files.
 * Handles:
 *   - data URIs:  data:image/png;base64,XXXX
 *   - Standalone long base64 strings (≥ 256 chars of valid base64)
 */

import fs from "fs";
import path from "path";

const [, , input, outputDir = "base64_output"] = process.argv;

if (!input) {
  console.error("Usage: node extractBase64.mjs <js-file-or-dir> [output-dir]");
  process.exit(1);
}

// Collect JS files to scan
function collectFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    return fs
      .readdirSync(target)
      .filter((f) => f.endsWith(".js"))
      .map((f) => path.join(target, f));
  }
  return [target];
}

const files = collectFiles(input);
if (files.length === 0) {
  console.error("No .js files found at:", input);
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });

// MIME type → extension map
const mimeToExt = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/avif": "avif",
  "font/woff": "woff",
  "font/woff2": "woff2",
  "font/ttf": "ttf",
  "application/json": "json",
  "application/octet-stream": "bin",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "video/mp4": "mp4",
};

// Detect file type from first bytes (magic numbers)
function detectExt(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "gif";
  if (buf[0] === 0x52 && buf[4] === 0x57) return "webp";
  if (buf[0] === 0x00 && buf[1] === 0x01) return "ttf";
  if (buf[0] === 0x77 && buf[1] === 0x4f && buf[2] === 0x46) return "woff";
  if (buf.slice(0, 4).toString() === "wOF2") return "woff2";
  if (buf[0] === 0x7b) return "json"; // {
  return "bin";
}

let totalSaved = 0;
const seen = new Set();

for (const file of files) {
  const baseName = path.basename(file, ".js");
  console.log(`\nScanning: ${file}`);
  const content = fs.readFileSync(file, "utf8");

  // --- Pass 1: data URIs ---
  const dataUriRe = /data:([a-zA-Z0-9][a-zA-Z0-9!#$&\-^_]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*);base64,([A-Za-z0-9+/]+=*)/g;
  let match;
  let count = 0;

  while ((match = dataUriRe.exec(content)) !== null) {
    const mime = match[1];
    const b64 = match[2];
    if (seen.has(b64)) continue;
    seen.add(b64);

    const buf = Buffer.from(b64, "base64");
    const ext = mimeToExt[mime] || detectExt(buf);
    const outName = `${baseName}_datauri_${++count}.${ext}`;
    const outPath = path.join(outputDir, outName);
    fs.writeFileSync(outPath, buf);
    console.log(`  [data URI] ${outName}  (${buf.length} bytes, ${mime})`);
    totalSaved++;
  }

  // --- Pass 2: standalone long base64 strings (quoted) ---
  // Look for quoted strings that are purely base64 chars and long enough to be files
  const standaloneRe = /["'`]([A-Za-z0-9+/]{256,}={0,2})["'`]/g;
  let count2 = 0;

  while ((match = standaloneRe.exec(content)) !== null) {
    const b64 = match[1];
    if (seen.has(b64)) continue;
    // Must be valid base64 length (multiple of 4 after padding)
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    seen.add(b64);

    try {
      const buf = Buffer.from(padded, "base64");
      // Skip if decoded looks like random noise (no recognisable magic)
      const ext = detectExt(buf);
      if (ext === "bin" && buf[0] < 0x08) continue; // likely not a real file

      const outName = `${baseName}_raw_${++count2}.${ext}`;
      const outPath = path.join(outputDir, outName);
      fs.writeFileSync(outPath, buf);
      console.log(`  [raw b64 ] ${outName}  (${buf.length} bytes)`);
      totalSaved++;
    } catch {
      // skip invalid base64
    }
  }

  if (count + count2 === 0) {
    console.log("  (no base64 found)");
  }
}

console.log(`\nDone. Saved ${totalSaved} file(s) to ./${outputDir}/`);
