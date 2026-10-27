// Compiles the C# scanner that the Rust one replaces (scanner/StrataScan.cs) with the C# compiler that ships with
// Windows (.NET Framework 4.x), into bin/StrataScan.exe. Only used to compare the two (scripts/parity.js, CI);
// the app uses bin/strata-scan.exe (scripts/build-scanner.js). On Linux the old scanner is plain JavaScript.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'win32') process.exit(0);

const root = path.join(__dirname, '..');
const src = path.join(root, 'scanner', 'StrataScan.cs');
const out = path.join(root, 'bin', 'StrataScan.exe');

if (process.argv.includes('--if-missing') && fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) {
  process.exit(0);
}

const windir = process.env.WINDIR || 'C:\Windows';
const csc = ['Framework64', 'Framework']
  .map((d) => path.join(windir, 'Microsoft.NET', d, 'v4.0.30319', 'csc.exe'))
  .find((p) => fs.existsSync(p));
if (!csc) {
  console.error('Could not find the .NET Framework C# compiler (csc.exe). Strata needs Windows with .NET Framework 4.x.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
try {
  execFileSync(csc, [
    '/nologo', '/optimize+', '/platform:anycpu', '/target:exe',
    '/r:System.Management.dll',
    `/out:${out}`, src,
  ], { stdio: 'inherit' });
  console.log(`Built ${path.relative(root, out)}`);
} catch (e) {
  process.exit(1);
}
