const { updateFeedUrl } = require('./electron/startup-update.cjs');

const updateUrl = updateFeedUrl(process.env.LYCANSYNC_PACKAGED_UPDATE_URL
  || (process.env.LYCANSYNC_PACKAGED_API_URL ? new URL('/downloads/', process.env.LYCANSYNC_PACKAGED_API_URL).href : ''));

module.exports = {
  appId: 'com.lycansync.desktop',
  productName: 'LycanSync',
  protocols: [{ name: 'LycanSync 邀请', schemes: ['lycansync'] }],
  electronDist: 'node_modules/electron/dist',
  directories: { output: '../../release/desktop', buildResources: '../../release/build-resources' },
  extraMetadata: { main: 'electron/main.cjs' },
  publish: { provider: 'generic', url: updateUrl },
  files: [
    'dist/**/*',
    'electron/main.cjs',
    'electron/activity-helper.cjs',
    'electron/startup-update.cjs',
    'electron/server-settings.cjs',
    'electron/access-links.cjs',
    'electron/preload.cjs',
    'electron/voice-overlay.cjs',
    'electron/voice-overlay-preload.cjs',
    'electron/media-helper.cjs',
    'electron/media-diagnostics.cjs',
    'electron/native-video-thumbnails.cjs',
    'node_modules/**/*',
  ],
  extraResources: [
    { from: '../../release/desktop/THIRD-PARTY-NOTICES.txt', to: 'THIRD-PARTY-NOTICES.txt' },
    { from: '../../release/build-resources/server-config.json', to: 'server-config.json' },
    { from: '../../native/media-helper/target/release/lycansync-media.exe', to: 'media-helper/lycansync-media.exe' },
    { from: '../../native/media-bridge/target/x86_64-pc-windows-msvc/release/lycansync_shared_texture_bridge.dll', to: 'media-bridge/lycansync_shared_texture_bridge.dll' },
    { from: '../../native/activity-helper/target/release/lycansync-activity.exe', to: 'activity-helper/lycansync-activity.exe' },
  ],
  win: { target: [{ target: 'nsis', arch: ['x64'] }], signAndEditExecutable: false },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    packElevateHelper: false,
    allowToChangeInstallationDirectory: true,
    runAfterFinish: true,
    installerLanguages: ['zh_CN'],
    include: 'electron/installer.nsh',
    createDesktopShortcut: true,
    artifactName: 'LycanSync-${version}-windows-x64-setup.${ext}',
  },
};
