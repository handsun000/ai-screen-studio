const path = require("path");
const fs = require("fs");

/**
 * Injects bundled portable binaries (Python, FFmpeg, Playwright Chromium)
 * into process.env.PATH and process.env.PLAYWRIGHT_BROWSERS_PATH.
 * Works seamlessly in both local dev mode and packaged Electron (.exe) mode.
 */
function setupBundledEnvironment(baseDir) {
  const rootDir = baseDir || path.resolve(__dirname, "..");

  // Search candidate paths for the bundled 'bin' directory
  const candidates = [
    // 1. Packaged Electron extraResources: <installDir>/resources/bin
    process.resourcesPath ? path.join(process.resourcesPath, "bin") : "",
    // 2. Packaged Electron app root fallback: <installDir>/resources/app/resources/bin
    process.resourcesPath ? path.join(process.resourcesPath, "app", "resources", "bin") : "",
    // 3. Local workspace development mode: <rootDir>/resources/bin
    path.join(rootDir, "resources", "bin"),
  ].filter(Boolean);

  let activeBinDir = "";
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      activeBinDir = c;
      break;
    }
  }

  if (!activeBinDir) {
    return {
      activeBinDir: "",
      hasBundledPython: false,
      hasBundledFFmpeg: false,
      hasBundledBrowser: false,
    };
  }

  const ffmpegDir = path.join(activeBinDir, "ffmpeg");
  const pythonDir = path.join(activeBinDir, "python");
  const browserDir = path.join(activeBinDir, "browser");

  const prependList = [];
  const hasBundledPython = fs.existsSync(path.join(pythonDir, "python.exe"));
  const hasBundledFFmpeg = fs.existsSync(path.join(ffmpegDir, "ffmpeg.exe"));
  const hasBundledBrowser = fs.existsSync(browserDir);

  if (hasBundledPython) prependList.push(pythonDir);
  if (hasBundledFFmpeg) prependList.push(ffmpegDir);

  if (prependList.length > 0) {
    const existingPath = process.env.PATH || "";
    // Avoid double prepending
    const currentTokens = existingPath.split(path.delimiter);
    const needed = prependList.filter((p) => !currentTokens.includes(p));
    if (needed.length > 0) {
      process.env.PATH = `${needed.join(path.delimiter)}${path.delimiter}${existingPath}`;
    }
  }

  if (hasBundledBrowser && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = browserDir;
  }

  return {
    activeBinDir,
    hasBundledPython,
    hasBundledFFmpeg,
    hasBundledBrowser,
  };
}

module.exports = { setupBundledEnvironment };
