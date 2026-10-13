// "This page wants web3" — the earliest honest signal that a tab should show
// wallet state in the toolbar.
//
// A page reaches for the wallet long before it sends a request: it reads
// window.ethereum to decide whether to render a Connect button, dispatches
// eip6963:requestProvider, or announces a Wallet-Standard app. Those touches are
// what make a tab a dApp tab, so each injected surface reports one — the badge
// then lights on the tabs that asked for a wallet and stays blank everywhere
// else (background/web3_tabs.ts paints it; a real RPC is detected in the service
// worker from the request frame itself and needs no reporting from here).
//
// Reported ONCE per document: reading window.ethereum is a hot path for some
// dApps (a poll loop, a React render), and the SW learns nothing from the second
// touch that it did not learn from the first. The dedupe is per page load, so a
// fresh document re-reports and re-lights its tab.
//
// The reporter is a plain function everywhere it is used, so a provider never
// depends on how (or whether) the touch reaches the content script.
export type TouchSink = () => void;
export type TouchReporter = () => void;

export function createTouchReporter(sink: TouchSink): TouchReporter {
  let reported = false;
  return () => {
    if (reported) {
      return;
    }
    // Latch BEFORE the sink: a throwing sink (a dead extension context) must not
    // leave the reporter armed to fire on every subsequent property read.
    reported = true;
    sink();
  };
}
