import type { WarmCDPContext } from '../pool/types.js';

export interface SearchParams {
  q: string;
  count: number;
  num?: number;
  page?: number;
  country?: string;
  gl?: string;
  search_lang?: string;
  hl?: string;
  freshness?: 'day' | 'week' | 'month' | 'year';
  tbs?: string;
  safesearch?: 'off' | 'moderate' | 'strict';
  autocorrect?: boolean;
  location?: string;
  maxPages?: number;
  featureRich?: boolean;
}

export interface SearchResult {
  title: string;
  url: string;
  description: string;
  position: number;
}

export interface SerpSitelink {
  title: string;
  link: string;
}

export interface SerpOrganicResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
  date?: string;
  sitelinks?: SerpSitelink[];
}

export interface SerpPeopleAlsoAskResult {
  question: string;
  snippet?: string;
  title?: string;
  link?: string;
}

export interface SerpRelatedSearchResult {
  query: string;
}

export interface SerpTopStoryResult {
  title: string;
  link: string;
  source?: string;
  date?: string;
  imageUrl?: string;
}

export interface SerpKnowledgeGraphResult {
  title?: string;
  type?: string;
  imageUrl?: string;
  description?: string;
  descriptionSource?: string;
  descriptionLink?: string;
  attributes?: Record<string, string>;
}

export interface SerpAnswerBoxResult {
  title?: string;
  answer?: string;
  snippet?: string;
  source?: string;
  sourceLink?: string;
}

export interface SearchExecutionConfig {
  timeoutMs: number;
  networkIdleMs: number;
  stabilityPollMs: number;
  stabilityChecks: number;
  minContentLength: number;
  abortSignal?: { aborted: boolean };
}

export interface SearchExecutionResult {
  results: SearchResult[];
  organic: SerpOrganicResult[];
  peopleAlsoAsk?: SerpPeopleAlsoAskResult[];
  relatedSearches?: SerpRelatedSearchResult[];
  topStories?: SerpTopStoryResult[];
  knowledgeGraph?: SerpKnowledgeGraphResult;
  answerBox?: SerpAnswerBoxResult;
  blocked: boolean;
  finalUrl: string;
  statusCode: number;
  navigations: number;
  totalTimeMs: number;
}

export type CdpInput = string | WarmCDPContext;
