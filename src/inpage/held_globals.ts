// The provider globals this extension installs on the page's window, and who
// holds each of them now.
//
// We never take a global another wallet or the browser already holds, and we
// never keep one from a wallet that wants it after us:
//   - a global that exists when we install is left alone, whatever it holds;
//     only a browser built-in wallet or another extension can have put it there
//     before our document_start script;
//   - ours is configurable, so a wallet that redefines it takes it;
//   - ours has a setter that gives way: a plain assignment, which is how several
//     wallets install theirs (and in strict code would throw against a getter
//     with no setter), replaces ours with an ordinary data property holding what
//     was assigned.
// What we do instead is answer, when the popup asks, who holds each global, so
// the popup can tell the user that another web3 wallet controls the page.
//
// Only OWN properties of the window count: every wallet installs its provider on
// the window itself, while an inherited `window.ethereum` is the DOM's named
// access to an element with that id, not a wallet.
//
// The answer reads property DESCRIPTORS only, never the value behind another
// wallet's getter: a getter is code, and calling a foreign one could do anything
// (some wallets build or route their provider on access). Reading our own getter
// would also report a touch for a page that asked for nothing.

import {
  GlobalHolder,
  HolderReport,
  PROVIDER_GLOBALS,
  ProviderGlobal,
} from '../protocol/bridge';
import { TouchReporter } from './activity';

// Taken when this script runs, at document_start, before any page script: a page
// or a later wallet that replaces these cannot make a report lie, or make our
// setter do something else.
const ownDescriptor = Object.getOwnPropertyDescriptor;
const defineProperty = Object.defineProperty;
const createObject = Object.create;
// Descriptors with no prototype: defineProperty reads `get`, `value` and the
// rest through the descriptor's prototype chain, so an object literal would pick
// up keys a page planted on Object.prototype (and throw, or install them).
const dataDescriptor = (value: unknown): PropertyDescriptor => {
  const d = createObject(null) as Record<string, unknown>;
  d.value = value;
  d.writable = true;
  d.enumerable = true;
  d.configurable = true;
  return d;
};
const accessorDescriptor = (
  get: () => unknown,
  set: (v: unknown) => void
): PropertyDescriptor => {
  const d = createObject(null) as Record<string, unknown>;
  d.get = get;
  d.set = set;
  d.configurable = true;
  return d;
};
// Which kind a descriptor is, decided by its OWN keys: a data descriptor has no
// `get` key, so testing `d.get` would fall through to whatever a page put on
// Object.prototype. Once the kind is known, the field read is an own one (the
// engine gives an accessor descriptor both `get` and `set`, a data one `value`).
const isAccessor = (d: PropertyDescriptor): boolean =>
  ownDescriptor(d, 'get') !== undefined;

export class InjectedGlobals {
  // The getter we installed for each global we hold.
  private readonly getters = new Map<ProviderGlobal, () => unknown>();

  constructor(private readonly target: object) {}

  // Install `value` as `key`, unless the global already exists.
  define(key: ProviderGlobal, value: unknown, onTouch: TouchReporter): void {
    if (ownDescriptor(this.target, key) !== undefined) {
      return;
    }
    const target = this.target;
    // A getter, not a value: a dApp asks whether a wallet is installed by
    // reading the global, and that read is this tab's "I want web3" signal
    // (activity.ts). The same object comes back on every read.
    const get = (): unknown => {
      onTouch();
      return value;
    };
    // Gives the global to whoever assigns it. Not a read, so not a touch.
    const set = (assigned: unknown): void => {
      defineProperty(target, key, dataDescriptor(assigned));
    };
    defineProperty(target, key, accessorDescriptor(get, set));
    this.getters.set(key, get);
  }

  // Who holds `key` now: our getter, something else (a data property with a
  // value, or any accessor that is not ours), or nothing usable.
  holder(key: ProviderGlobal): GlobalHolder {
    const d = ownDescriptor(this.target, key);
    if (d === undefined) {
      return 'none';
    }
    if (isAccessor(d)) {
      const ours = this.getters.get(key);
      return ours !== undefined && d.get === ours ? 'airnox' : 'other';
    }
    // A falsy value is what a dApp's `if (window.ethereum)` reads as "no
    // wallet". Truthiness is not a property read, so even a Proxy is not asked.
    return d.value ? 'other' : 'none';
  }

  report(): HolderReport {
    const out = {} as Record<ProviderGlobal, GlobalHolder>;
    for (const key of PROVIDER_GLOBALS) {
      out[key] = this.holder(key);
    }
    return out;
  }
}
