export interface SearchParams {
  q: string;
  count: number;
  country?: string;
  search_lang?: string;
  freshness?: "day" | "week" | "month" | "year";
  safesearch?: "off" | "moderate" | "strict";
}

export interface SearchResult {
  title: string;
  url: string;
  description: string;
  position: number;
}

export interface ConnectedSession {
  sessionId: string;
  cdpUrl: string;
  browser: any;
  page: any;
  createdAt: number;
  useCount: number;
}


