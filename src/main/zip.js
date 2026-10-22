'use strict';
// Zip helpers on top of the bsdtar that ships with Windows (handles long paths, no dependencies).
const path = require('path');
const { spawn } = require('child_process');

function tar(args) {
  return new Promise((resolve, reject) => {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const proc = spawn(exe, args, { windowsHide: true });
    let err = '';
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim() || `tar exit ${code}`)));
  });
}

// Zip the contents of a directory (not the directory itself).
const zipDir = (dir, zipPath) => tar(['-a', '-c', '-f', zipPath, '-C', dir, '.']);
// Zip specific files/folders relative to a base directory.
const unzip = (zipPath, destDir) => tar(['-x', '-f', zipPath, '-C', destDir]);

module.exports = { tar, zipDir, unzip };
