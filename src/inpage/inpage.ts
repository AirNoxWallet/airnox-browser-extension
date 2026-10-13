// The single injected main-world entry. It builds ONE PostMessageTransport and
// wires every provider onto it, so the page has one window `message` listener
// for all RPC traffic and one pending map instead of five. The transport is shared through
// this module's CLOSURE — it is never exposed on `window`, so it stays a private
// object exactly like the per-provider transports it replaces.
//
// It also builds the one touch reporter every provider calls when the page first
// reaches for it (see activity.ts), and the one registry of the globals the
// providers install, which answers the content script's probe for who holds each
// of them now (see held_globals.ts).
//
// Each provider still filters desktop pushes by namespace, then by chain URN —
// the shared transport fans every push out to all registered handlers; see
// transport.ts. The manifest runs this file as a MAIN-world content script at
// document_start, built as the sole inpage entry (build.ts).

import {
  PageHolders,
  PageTouch,
  PAGE_TO_CONTENT,
  isHolderProbe,
} from '../protocol/bridge';
import { createTouchReporter } from './activity';
import { InjectedGlobals } from './held_globals';
import { installEvmProvider } from './provider';
import { installSolanaWallet } from './solana_inpage';
import { installSuiWallet } from './sui_inpage';
import { installTonConnect } from './tonconnect_inpage';
import { installTronShim } from './tron_inpage';
import { PostMessageTransport } from './transport';

const transport = new PostMessageTransport();

// One reporter for all five providers: whichever surface the page reaches for
// first tells the content script that THIS tab wants web3, so the toolbar can
// show wallet state here and stay blank on tabs that never asked (activity.ts).
// It rides the same page->content channel as a request but carries no id, so the
// content script relays it and answers nothing.
const reportTouch = createTouchReporter(() => {
  const frame: PageTouch = { channel: PAGE_TO_CONTENT, touch: true };
  window.postMessage(frame, '*');
});

const globals = new InjectedGlobals(window);

installEvmProvider(transport, reportTouch, globals);
installTonConnect(transport, reportTouch, globals);
installSolanaWallet(transport, reportTouch);
installSuiWallet(transport, reportTouch);
installTronShim(transport, reportTouch, globals);

// The content script asks who holds each provider global when the popup opens
// on this tab. A separate listener from the transport's: a probe is not RPC
// traffic, and answering it touches no provider.
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || !isHolderProbe(event.data)) {
    return;
  }
  const frame: PageHolders = {
    channel: PAGE_TO_CONTENT,
    holders: globals.report(),
  };
  window.postMessage(frame, '*');
});
