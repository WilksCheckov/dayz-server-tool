'use strict';
// Which DLLs a Windows exe imports (PE import table), and which of them cannot be found the way the loader looks:
// the exe's folder, then the system folders. Lets the pre-launch check name the missing DLL instead of guessing.
const fs = require('fs');
const path = require('path');

function imports(exe) {
  const b = fs.readFileSync(exe);
  if (b.readUInt16LE(0) !== 0x5a4d) throw new Error('not an exe');
  const pe = b.readUInt32LE(0x3c);
  if (b.readUInt32LE(pe) !== 0x4550) throw new Error('no PE header');
  const sections = b.readUInt16LE(pe + 6), optSize = b.readUInt16LE(pe + 20), opt = pe + 24;
  const magic = b.readUInt16LE(opt); const is64 = magic === 0x20b;
  const ddOff = opt + (is64 ? 112 : 96);
  const impRva = b.readUInt32LE(ddOff + 8), impSize = b.readUInt32LE(ddOff + 12);
  if (!impRva) return [];
  const secTab = opt + optSize; const secs = [];
  for (let i = 0; i < sections; i++) { const o = secTab + i * 40; secs.push({ va: b.readUInt32LE(o + 12), vsize: b.readUInt32LE(o + 8), raw: b.readUInt32LE(o + 20), rawSize: b.readUInt32LE(o + 16) }); }
  const toOff = rva => { const s = secs.find(x => rva >= x.va && rva < x.va + Math.max(x.vsize, x.rawSize)); return s ? rva - s.va + s.raw : null; };
  const names = []; let o = toOff(impRva); if (o === null) return [];
  for (let i = 0; i < impSize / 20; i++) {
    const nameRva = b.readUInt32LE(o + 12); if (!nameRva) break;
    const no = toOff(nameRva); if (no === null) break;
    const end = b.indexOf(0, no); names.push(b.toString('latin1', no, end)); o += 20;
  }
  return names;
}
// DLLs the exe imports that exist neither next to it nor in the Windows system folders.
function missing(exe) {
  const dir = path.dirname(exe);
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const roots = [dir, path.join(sysRoot, 'System32'), path.join(sysRoot, 'SysWOW64')];
  const out = [];
  for (const name of imports(exe)) {
    // api-ms-win-* / ext-ms-* are API sets resolved by the loader, never files on disk
    if (/^(api|ext)-ms-/i.test(name)) continue;
    if (!roots.some(r => fs.existsSync(path.join(r, name)))) out.push(name);
  }
  return out;
}
// what package provides a DLL, for the fix text
function provider(dll) {
  const n = dll.toLowerCase();
  if (/^(vcruntime|msvcp|concrt|vccorlib|msvcr1[0-9]0)/.test(n)) return 'the Microsoft Visual C++ 2015-2022 x64 runtime (vc_redist.x64.exe)';
  if (/^(x3daudio|xapofx|xinput1_[1-3]|d3dx|d3dcompiler_4[0-3]|xaudio2_[0-7])/.test(n)) return 'the DirectX End-User Runtime (dxwebsetup / directx_Jun2010_redist)';
  if (/^(steam_api|steamclient|tier0|vstdlib)/.test(n)) return 'the server files themselves (validate the install)';
  if (/^beserver/.test(n)) return 'BattlEye (battleye\\BEServer_x64.dll)';
  return 'an unknown package';
}
module.exports = { imports, missing, provider };
