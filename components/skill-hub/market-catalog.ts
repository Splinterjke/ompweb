/**
 * Built-in market catalog: curated skill repositories shown on the market tab.
 */

import type { HubKey } from './locales';

export interface MarketCatalogEntry {
  repo: string;
  descriptionKey: HubKey;
}

export const MARKET_CATALOG: readonly MarketCatalogEntry[] = [
  { repo: 'anthropics/skills', descriptionKey: 'market.catalog.anthropics' },
  { repo: 'obra/superpowers', descriptionKey: 'market.catalog.superpowers' },
  { repo: 'mattpocock/skills', descriptionKey: 'market.catalog.mattpocock' },
  { repo: 'nexu-io/open-design', descriptionKey: 'market.catalog.openDesign' },
];
