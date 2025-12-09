const fs = require("fs");
const path = require("path");

async function loadUapfPackage(filePath) {
  const absolutePath = path.resolve(filePath);
  const raw = await fs.promises.readFile(absolutePath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse UAPF package ${absolutePath}: ${err && err.message ? err.message : String(err)}`);
  }
  return { manifest, filePath: absolutePath };
}

async function validatePackage(_pkg) {
  return;
}

module.exports = { loadUapfPackage, validatePackage };
