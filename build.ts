import { Builder } from './buildUtils';

// What goes into each browser package. Exported so the tests build exactly
// what a release ships.
export function addReleaseFiles(builder: Builder): Builder {
  // The MV3 scripts, each an esbuild entry point (shared modules under
  // src/protocol + src/transport are imported, so esbuild bundles them in):
  //   * background — the service worker (it owns the desktop WebSocket client)
  //   * content    — the isolated-world content script (origin oracle + relay)
  //   * inpage     — the single main-world entry: it builds ONE PostMessageTransport
  //                  and installs every provider onto it (EIP-1193 window.ethereum,
  //                  TON Connect, the Solana + Sui Wallet-Standard adapters, the TRON
  //                  shim). The per-provider install modules are bundled in.
  builder.addBuildFile('src/background/background.ts');
  builder.addBuildFile('src/content/content.ts');
  builder.addBuildFile('src/inpage/inpage.ts');

  // The toolbar popup (action.default_popup): a connection-state surface. The TS is
  // bundled like any other entry; the HTML + CSS are copied verbatim.
  builder.addBuildFile('src/popup/popup.ts');
  builder.addStaticFile('src/popup/popup.html');
  builder.addStaticFile('src/popup/popup.css');
  // The pairing page: an extension page the popup opens in its own window. It
  // shares the popup's stylesheet.
  builder.addBuildFile('src/popup/pairing.ts');
  builder.addStaticFile('src/popup/pairing.html');

  builder.addStaticDir('icons');

  // The licence of this code and the notices of the third-party code bundled
  // into it travel inside every package.
  builder.addStaticFile('LICENSE');
  builder.addStaticFile('THIRD_PARTY_NOTICES');
  return builder;
}

if (require.main === module) {
  const builder = addReleaseFiles(
    new Builder({
      watchFlag: process.argv.includes('--watch'),
      devFlag: process.argv.includes('--dev'),
      chromeFlag: process.argv.includes('--chrome'),
      firefoxFlag: process.argv.includes('--firefox'),
    })
  );
  builder.build().catch((error: unknown) => {
    console.error('build failed:', error);
    process.exitCode = 1;
  });
}
