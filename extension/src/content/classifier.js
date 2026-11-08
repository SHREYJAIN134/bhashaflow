// Text-level and subtree-level rules deciding what may be rewritten.
// Anything not clearly explanatory English prose is protected: false negatives beat false positives.
// Every verdict carries a reason code so wrong decisions can be diagnosed (controller.explain()).

import { AD_LABEL } from './ads.js';

const DEVANAGARI = /[ऀ-ॿ]/;
const STOPWORDS = new Set(
  'the a an is are was were be been of to in on for with and or that this it as by from at which can has have will not'.split(' '),
);
export const MIN_WORDS = 6;

const POS_LABEL = /^(noun|verb|adjective|adverb|pronoun|preposition|conjunction|interjection|determiner|exclamation|abbreviation|auxiliary verb|modal verb|phrasal verb|proper noun|prefix|suffix|numeral|article|transitive verb|intransitive verb|plural noun|symbol|contraction)\b[^.]*$/i;

const ALWAYS_PROTECTED = [
  'script', 'style', 'noscript', 'template', 'head', 'svg', 'math', 'iframe', 'object', 'embed', 'canvas',
  'textarea', 'input', 'select', 'option', 'datalist', 'button', 'label', 'summary',
  'code', 'pre', 'kbd', 'samp', 'var', 'tt',
  'nav', 'footer',
  '[contenteditable]:not([contenteditable="false"])',
  '[aria-hidden="true"]', '[hidden]', '[translate="no"]', '.notranslate',
  '[role="navigation"]', '[role="button"]', '[role="menu"]', '[role="menubar"]', '[role="tablist"]',
  '[role="toolbar"]', '[role="banner"]', '[role="contentinfo"]', '[role="search"]', '[role="textbox"]',
].join(',');
export const HEADINGS = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
const HINDI_LANG = '[lang|="hi"]';

/** True if the element and everything under it must never be touched. */
export function isProtectedSubtree(el, opts) {
  if (el.matches(ALWAYS_PROTECTED)) return true;
  if (opts.preserveHeadings && el.matches(HEADINGS)) return true;
  if (opts.preserveHindi && el.matches(HINDI_LANG)) return true;
  return false;
}

function isVisible(el) {
  if (typeof el.checkVisibility === 'function') return el.checkVisibility();
  const style = el.ownerDocument.defaultView.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

const skip = (reason) => ({ eligible: false, reason });

/**
 * Text-level verdict for a run (see inline.js). Context-level decisions (main content vs
 * sidebar/ad) are made afterwards by region.js; an eligible verdict here means "reads like prose".
 */
export function classifyRun(run, opts) {
  const { host, plain } = run;
  if (host.closest('a')) return skip('link-text');
  if (!isVisible(host)) return skip('hidden');
  if (run.collision) return skip('token-collision');

  const words = plain.split(' ');
  if (plain.length <= 40 && AD_LABEL.test(plain)) return skip('ad-label');
  if (plain.length <= 40 && words.length <= 4 && POS_LABEL.test(plain)) return skip('dictionary-label');
  if (words.length < MIN_WORDS) return skip('too-short');
  if (run.linkLen / plain.length >= 0.8) return skip('link-text');

  if (opts.preserveHindi && DEVANAGARI.test(plain)) return skip('hindi');

  const letters = plain.match(/\p{L}/gu) || [];
  const latin = plain.match(/[A-Za-z]/g) || [];
  if (letters.length === 0 || latin.length / letters.length < 0.8) return skip('not-english');
  if (!words.some((w) => STOPWORDS.has(w.toLowerCase().replace(/[^a-z]/g, '')))) return skip('not-prose');

  if (opts.preserveTechnical) {
    if (/^(https?:\/\/|www\.)\S+$/i.test(plain) || /^\S+@\S+\.\S+$/.test(plain)) return skip('technical');
    const symbols = plain.replace(/[\p{L}\p{N}\s.,;:'"()\-!?]/gu, '').length;
    if (symbols / plain.length > 0.2) return skip('technical');
  }
  return { eligible: true, reason: 'prose', text: run.template };
}
