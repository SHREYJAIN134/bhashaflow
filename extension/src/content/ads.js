// Advertisement / third-party / peripheral-content detection.
//
// Two tiers:
//  - strong: ads, sponsored content, third-party embeds. Pruned from the scan anywhere on the page.
//  - weak:   sidebars, widgets, related/recommended rails, share bars, comments, popups.
//            Only excluded after main-content regions are known (see region.js), so a legitimate
//            wrapper such as <div class="sidebar-layout"> around the article is never dropped.

const STRONG_SELECTOR = [
  'ins.adsbygoogle', '[data-ad-slot]', '[data-ad-client]', '[data-ad-unit]', '[data-adunit]', '[data-ad]',
  '[data-native-ad]', '[data-google-query-id]', '[id^="google_ads"]', '[id^="div-gpt-ad"]', '[id^="aswift"]',
  'amp-ad', 'amp-embed', 'amp-sticky-ad', 'gpt-ad', 'ad-slot', 'fencedframe',
  '.twitter-tweet', '.instagram-media', '.fb-post', '[data-oembed-url]', '[data-tweet-id]',
  '[aria-label="Advertisement" i]', '[aria-label="Sponsored" i]', '[aria-label="Ad" i]',
].join(',');

const STRONG_TOKENS = new Set([
  'ad', 'ads', 'adv', 'advert', 'adverts', 'advertisement', 'advertisements', 'advertising', 'adslot', 'adunit',
  'adsense', 'adsbygoogle', 'doubleclick', 'taboola', 'outbrain', 'sponsor', 'sponsors', 'sponsored', 'promoted',
]);

// 'ui' furniture is never article prose, even inside the article element.
const UI_TOKENS = new Set([
  'promo', 'promos', 'promotion', 'promotional', 'newsletter', 'subscribe', 'share', 'sharing', 'social',
  'comments', 'comment', 'cookie', 'cookies', 'consent', 'popup', 'modal', 'breadcrumb', 'breadcrumbs',
  'pagination', 'toolbar', 'masthead', 'topbar', 'byline', 'meta', 'metadata', 'timestamp', 'dateline',
]);
// 'rail' content (sidebars, related lists) is only dropped when it is link-heavy, so a legitimate
// note or pull-quote inside an article survives.
const RAIL_TOKENS = new Set([
  'sidebar', 'sidebars', 'widget', 'widgets', 'related', 'recommended', 'recommendations', 'banner',
  'trending', 'popular',
]);

const NEVER_AD = new Set(['html', 'body', 'main', 'article']);
const WRAPS_CONTENT = 'main,article,[role="main"]';

const tokenCache = new WeakMap();

/** Lower-cased word tokens from id/class/test-id style attributes ("adSlot-top" -> ad, slot, top). */
export function attrTokens(el) {
  let tokens = tokenCache.get(el);
  if (tokens) return tokens;
  const raw = [el.id, el.getAttribute('class'), el.getAttribute('data-testid'), el.getAttribute('data-component'),
    el.getAttribute('data-module')].filter(Boolean).join(' ');
  tokens = raw
    ? new Set(raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
    : new Set();
  tokenCache.set(el, tokens);
  return tokens;
}

const adCache = new WeakMap();

/** True if the element is (the root of) an advertisement, sponsored block or third-party embed. */
export function isAdSubtree(el) {
  let verdict = adCache.get(el);
  if (verdict !== undefined) return verdict;
  verdict = false;
  if (el.matches(STRONG_SELECTOR)) {
    verdict = true;
  } else if (!NEVER_AD.has(el.localName) && el.getAttribute('role') !== 'main') {
    for (const t of attrTokens(el)) {
      if (STRONG_TOKENS.has(t)) { verdict = true; break; }
    }
    // A wrapper that holds the real article is never an ad, whatever it is called.
    if (verdict && el.querySelector(WRAPS_CONTENT)) verdict = false;
  }
  adCache.set(el, verdict);
  return verdict;
}

/** 'ui' | 'rail' | null: whether the element itself looks like peripheral page furniture. */
export function peripheralKind(el) {
  if (NEVER_AD.has(el.localName)) return null;
  let kind = null;
  if (el.localName === 'aside' || el.getAttribute('role') === 'complementary') kind = 'rail';
  for (const t of attrTokens(el)) {
    if (UI_TOKENS.has(t)) return 'ui';
    if (RAIL_TOKENS.has(t)) kind = 'rail';
  }
  return kind;
}

export const AD_LABEL = /^(advertisement|advertisements|ad|ads|sponsored|sponsored content|promoted|promoted content|paid content|paid partnership|story continues below advertisement|continue reading below|advertisement\s*[-–—•]\s*continue reading below)$/i;
