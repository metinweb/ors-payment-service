/**
 * POS Provider Factory
 */

import GarantiProvider from './GarantiProvider.js';
import PaytenProvider from './PaytenProvider.js';
import YKBProvider from './YKBProvider.js';
import AkbankProvider from './AkbankProvider.js';
import VakifbankProvider from './VakifbankProvider.js';
import QNBProvider from './QNBProvider.js';
import DenizbankProvider from './DenizbankProvider.js';
import PayTRProvider from './PayTRProvider.js';
import IyzicoProvider from './IyzicoProvider.js';
import SigmapayProvider from './SigmapayProvider.js';

const PROVIDERS = {
  garanti: GarantiProvider,
  payten: PaytenProvider,
  ykb: YKBProvider,
  akbank: AkbankProvider,
  vakifbank: VakifbankProvider,
  qnb: QNBProvider,
  denizbank: DenizbankProvider,
  paytr: PayTRProvider,
  iyzico: IyzicoProvider,
  sigmapay: SigmapayProvider,
  // NestPay based banks (use PaytenProvider)
  isbank: PaytenProvider,
  halkbank: PaytenProvider,
  ziraat: PaytenProvider,
  teb: PaytenProvider,
  ingbank: PaytenProvider,
  sekerbank: PaytenProvider
};

export function getProvider(transaction, virtualPos) {
  const ProviderClass = PROVIDERS[virtualPos.provider];

  if (!ProviderClass) {
    throw new Error(`Provider not implemented: ${virtualPos.provider}`);
  }

  return new ProviderClass(transaction, virtualPos);
}

export function isProviderSupported(provider) {
  return provider in PROVIDERS && PROVIDERS[provider] !== null;
}

export function getSupportedProviders() {
  return Object.entries(PROVIDERS)
    .filter(([, value]) => value !== null)
    .map(([key]) => key);
}

export default {
  getProvider,
  isProviderSupported,
  getSupportedProviders
};
