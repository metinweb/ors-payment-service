/**
 * POS Provider Factory
 */

import GarantiProvider from './GarantiProvider.js';
import PaytenProvider from './PaytenProvider.js';

const PROVIDERS = {
  garanti: GarantiProvider,
  payten: PaytenProvider,
  // TODO: Implement other providers
  akbank: null,
  ykb: null,
  vakifbank: null,
  qnb: null,
  denizbank: null,
  paytr: null,
  iyzico: null,
  sigmapay: null
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
