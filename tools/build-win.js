'use strict';
/* Build Gofer for Windows.
     node tools/build-win.js                         installer + portable zip (unsigned unless Azure vars are set)
     node tools/build-win.js --publish always        …and upload them to the GitHub Release for this version
     node tools/build-win.js --store                 Microsoft Store package (.appx/MSIX; the Store signs it)
   On Windows (the release pipeline) electron-builder makes the installer natively and signs through
   Azure Artifact Signing when AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_PROFILE and
   AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET are set.
   Elsewhere it builds the app folder + zip; make the installer with makensis (see README). */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(ROOT, 'stage');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const STORE = flag('--store');
const PUBLISH = opt('--publish', 'never');
const ON_WINDOWS = process.platform === 'win32';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const sh = (cmd, cwd) => execSync(cmd, { cwd: cwd || ROOT, stdio: 'inherit' });
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const ghRepo = (process.env.GITHUB_REPOSITORY || (pkg.repository && pkg.repository.url || '').replace(/^.*github\.com[/:]|\.git$/g, '')).split('/');

// 0) the model, pinned and verified
if (process.env.GOFER_SKIP_MODEL_FETCH) console.log('  • using ./model as-is (GOFER_SKIP_MODEL_FETCH)');
else sh('node tools/fetch-model.js' + (process.env.CI && fs.existsSync(path.join(ROOT, 'model.lock.json')) ? ' --require-lock' : ''));

// 1) stage: app files + Windows x64 production dependencies + model
rm(STAGE); fs.mkdirSync(STAGE);
for (const d of ['src', 'assets', 'model']) fs.cpSync(path.join(ROOT, d), path.join(STAGE, d), { recursive: true });
fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify({
  name: 'gofer', productName: 'Gofer', version: pkg.version, description: pkg.description, author: { name: 'Mr. Interactive' }, license: 'UNLICENSED',
  main: 'src/main.js', dependencies: pkg.dependencies, repository: pkg.repository
}, null, 2));
sh('npm install --omit=dev --os=win32 --cpu=x64 --no-audit --no-fund --no-package-lock', STAGE);

// 2) prune runtime files Gofer never loads
const ortDist = path.join(STAGE, 'node_modules', 'onnxruntime-web', 'dist');
const keep = new Set(['ort.node.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']);
for (const f of fs.readdirSync(ortDist)) if (!keep.has(f)) rm(path.join(ortDist, f));
const napi = path.join(STAGE, 'node_modules', '@napi-rs');
if (fs.existsSync(napi)) for (const d of fs.readdirSync(napi)) if (d.startsWith('canvas-') && !d.includes('win32-x64')) rm(path.join(napi, d));
for (const junk of ['pdfjs-dist/web', 'pdfjs-dist/types', 'pdfjs-dist/image_decoders']) rm(path.join(STAGE, 'node_modules', junk));

// 3) package
const azure = process.env.AZURE_SIGNING_ENDPOINT && process.env.AZURE_SIGNING_ACCOUNT && process.env.AZURE_SIGNING_PROFILE
  ? { publisherName: process.env.AZURE_SIGNING_PUBLISHER || 'Sean Rogers', endpoint: process.env.AZURE_SIGNING_ENDPOINT, codeSigningAccountName: process.env.AZURE_SIGNING_ACCOUNT, certificateProfileName: process.env.AZURE_SIGNING_PROFILE }
  : null;
if (ON_WINDOWS && !STORE) console.log(azure ? '  • signing with Azure Artifact Signing' : '  • NOT signing (Azure signing variables not set)');

const icon = path.join(ROOT, 'buildres', 'icon.ico');
const config = {
  appId: 'com.mrinteractive.gofer', productName: 'Gofer', copyright: 'Mr. Interactive',
  directories: { app: STAGE, output: path.join(ROOT, 'release'), buildResources: path.join(ROOT, 'buildres') },
  electronVersion: require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version,
  asar: false, npmRebuild: false, nodeGypRebuild: false, buildDependenciesFromSource: false,
  publish: ghRepo.length === 2 && ghRepo[0] ? [{ provider: 'github', owner: ghRepo[0], repo: ghRepo[1], releaseType: 'release' }] : null,
  win: {
    target: STORE ? [{ target: 'appx', arch: ['x64'] }] : (ON_WINDOWS ? [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }] : [{ target: 'zip', arch: ['x64'] }]),
    icon, executableName: 'Gofer', artifactName: 'Gofer-${version}-win-x64-portable.${ext}',
    signAndEditExecutable: ON_WINDOWS, ...(azure && !STORE ? { azureSignOptions: azure } : {})
  },
  nsis: { oneClick: true, perMachine: false, runAfterFinish: true, createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: 'Gofer',
    installerIcon: icon, uninstallerIcon: icon, deleteAppDataOnUninstall: false, artifactName: 'Gofer-Setup-${version}.${ext}' },
  appx: {
    identityName: process.env.STORE_IDENTITY_NAME || 'MrInteractive.Gofer',
    publisher: process.env.STORE_PUBLISHER || 'CN=00000000-0000-0000-0000-000000000000',
    publisherDisplayName: process.env.STORE_PUBLISHER_DISPLAY_NAME || 'Mr. Interactive',
    applicationId: 'Gofer', displayName: 'Gofer', backgroundColor: '#dbe6f3', languages: ['en-US'], addAutoLaunchExtension: true,
    artifactName: 'Gofer-${version}-store.${ext}'
  },
  // off Windows electron-builder can't edit the exe; set icon + version info ourselves (pure JS)
  afterPack: ON_WINDOWS ? undefined : async (ctx) => {
    const ResEdit = require('resedit');
    const exe = path.join(ctx.appOutDir, 'Gofer.exe');
    const exeObj = ResEdit.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true }); const r = ResEdit.NtExecutableResource.from(exeObj);
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icon));
    const groups = ResEdit.Resource.IconGroupEntry.fromEntries(r.entries);
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(r.entries, groups.length ? groups[0].id : 1, groups.length ? groups[0].lang : 1033, iconFile.icons.map((i) => i.data));
    for (const vi of ResEdit.Resource.VersionInfo.fromEntries(r.entries)) {
      const [a, b, c] = pkg.version.split('.').map(Number);
      vi.setFileVersion(a, b, c, 0, 1033); vi.setProductVersion(a, b, c, 0, 1033);
      vi.setStringValues({ lang: 1033, codepage: 1200 }, { FileDescription: 'Gofer', ProductName: 'Gofer', CompanyName: 'Mr. Interactive', OriginalFilename: 'Gofer.exe', InternalName: 'Gofer', LegalCopyright: 'Mr. Interactive' });
      vi.outputToResourceEntries(r.entries);
    }
    r.outputResource(exeObj); fs.writeFileSync(exe, Buffer.from(exeObj.generate()));
    console.log('  • exe icon and version info set');
  }
};
if (STORE) delete config.publish;

const builder = require('electron-builder');
builder.build({ targets: builder.Platform.WINDOWS.createTarget(null, builder.Arch.x64), config, publish: STORE ? 'never' : PUBLISH })
  .then((out) => console.log('\nbuilt:\n' + out.map((p) => '  ' + p).join('\n')))
  .catch((e) => { console.error(e); process.exit(1); });
