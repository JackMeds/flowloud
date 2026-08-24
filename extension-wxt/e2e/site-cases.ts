export type SiteKind = 'flarum' | 'discourse' | 'article';
export type SiteScenario = 'continuation' | 'extraction';

export interface RealSiteCase {
  id: string;
  url: string;
  kind: SiteKind;
  scenario: SiteScenario;
  timeoutMs: number;
  minSegments: number;
  requiresAuth: boolean;
  allowedPageNoise: RegExp[];
}

export const COMMON_PAGE_NOISE = [
  /cloudflareinsights\.com\/beacon/iu,
  /ERR_BLOCKED_BY_CLIENT/iu,
  /Tracking Prevention blocked/iu,
  /XSLTProcessor.*deprecated/iu,
  /apple-mobile-web-app-capable.*deprecated/iu,
  /Images loaded lazily/iu,
  /Forced reflow/iu,
];

export const REAL_SITE_CASES: RealSiteCase[] = [
  {
    id: 'viva-reported-continuation',
    url: 'https://bbs.viva-la-vita.org/d/47653/3',
    kind: 'flarum',
    scenario: 'continuation',
    timeoutMs: 45_000,
    minSegments: 3,
    requiresAuth: false,
    allowedPageNoise: COMMON_PAGE_NOISE,
  },
  {
    id: 'viva-long-thread',
    url: 'https://bbs.viva-la-vita.org/d/23351',
    kind: 'flarum',
    scenario: 'extraction',
    timeoutMs: 45_000,
    minSegments: 3,
    requiresAuth: false,
    allowedPageNoise: COMMON_PAGE_NOISE,
  },
  {
    id: 'linux-do-discourse',
    url: 'https://linux.do/t/topic/997705',
    kind: 'discourse',
    scenario: 'extraction',
    timeoutMs: 45_000,
    minSegments: 3,
    requiresAuth: false,
    allowedPageNoise: COMMON_PAGE_NOISE,
  },
  {
    id: 'wikipedia-article',
    url: 'https://zh.wikipedia.org/wiki/语音合成',
    kind: 'article',
    scenario: 'extraction',
    timeoutMs: 45_000,
    minSegments: 3,
    requiresAuth: false,
    allowedPageNoise: COMMON_PAGE_NOISE,
  },
];

export function targetSiteCase(url: string, scenario: string): RealSiteCase {
  const known = REAL_SITE_CASES.find((item) => item.url === url);
  if (known) return { ...known, scenario: scenario === 'extraction' ? 'extraction' : known.scenario };
  return {
    id: 'user-target',
    url,
    kind: 'article',
    scenario: scenario === 'extraction' ? 'extraction' : 'continuation',
    timeoutMs: 45_000,
    minSegments: scenario === 'extraction' ? 2 : 3,
    requiresAuth: false,
    allowedPageNoise: COMMON_PAGE_NOISE,
  };
}
