# Benchmark report: Gemini 3.6 Flash (Phase 3 live run)

Run: 2026-11-04, `npm run bench -- --provider openai-compat`, model `gemini-3.6-flash` via the OpenAI-compatible endpoint, `REASONING_EFFORT=none`, temperature 0.3, prompt `hinglish-v1`, the existing 25 cases in batches of 5 (as the extension sends them). Raw rows: `benchmark/results/openai-compat-1793792137763.json` (git-ignored). One run, no `--judge`.

## Recommendation

**Proceed with Gemini 3.6 Flash, but adjust the prompt (to `hinglish-v2`) and re-run this benchmark before building on it.**
It never failed and kept every placeholder, term, number and acronym intact, and most output is genuinely conversational. The defects are grammatical and stylistic, they are repetitive, and they are the kind a prompt change fixes: Hindi gender agreement, an occasional garbled or over-literal phrase, and a stiff "-ein" register. No case changed a fact. The provider is not the problem; the main open risk is speed (below), which no provider choice fixes by itself.

## Measured results

| Metric | Result |
|---|---|
| Cases passing all structural checks | 25 / 25 (placeholders, numbers, acronyms, no Devanagari, length) |
| Failures / truncations / empty replies | 0 / 0 / 0 |
| Retries (transient errors) | 0 |
| Repair passes | 1 item was rejected by the validator on the first try and fixed on the second. The run did not record which item (likely the 13.5 s request). |
| Model calls | 6 for 25 cases (5 requests + 1 repair) |
| Term preservation (automatic) | 24 / 25. The one miss is a false alarm: "Newton ka second law" is fine Hinglish, the scorer wanted the literal "Newton's second law" |
| Total duration (sequential) | 30.4 s |
| Latency per 5-item request | 2.6, 2.7, 5.7, 6.0, 13.5 s (p50 5.7 s, p95 13.5 s) |
| Tokens | 6,124 in / 1,301 out (84% of input is the repeated system prompt at this batch size) |
| Cost | **$0.0095** for 25 cases ($0.00038 per case) at $0.75 in / $3.75 out per 1M tokens, confirmed on Google's pricing page |
| Measured effective speed | about 43 output tokens/s end to end |

**Price warning:** Google's page lists these rates only through 31 Dec 2026. From 1 Jan 2027 they double ($1.50 / $7.50). Hinglish text is 1.21x longer than the English in characters and about 1.5x in tokens, which matches the earlier estimate.

**Page-level projection (from measurements, not a measured page):** a 60-block article is about 17k input and 8k output tokens, so about $0.044 per page now and about $0.088 from January. At 43 tokens/s, sequential batches take roughly 3 minutes per page; 4 in parallel about 45-50 s. That is far from the 500-1500 ms goal. Only a small first batch can land that fast, so Phase 4 (parallel batches, viewport-first, caching) is mandatory, not optional.

## Quality review (against the English and my reference renderings)

Reviewer: the assistant that wrote this report, not a panel of native speakers. Treat the grading below as a first pass and have a Hindi reader confirm the "bad" list.

**Overall:** about 19 of 25 outputs are natural and correct, 6 have a small defect. Nothing is a mistranslation. The outputs match or beat the references in several places (for example `boil hota hai`, `faaltu ki cheezon`).

### Good

| Case | Gemini output | Why it works |
|---|---|---|
| dict-1 (spec example) | Ye word court of law ke context mein use hota hai, especially US aur kuch doosre countries mein. Iska matlab hai kisi public official par officially serious crime karne ka allegation lagana jab woh abhi bhi apne office mein ho. | Follows the requested definition pattern; keeps law/US/official terms. |
| mixed-2 | ⟦3⟧List⟦/3⟧ ke har element par ⟦2=code⟧ apply karne ke liye ⟦1⟧map()⟦/1⟧ function ka use karein. | Reordered for Hindi word order, all tokens intact, so the DOM links/code survive. |
| tech-5 | PostgreSQL data ko tables mein store karta hai, aur har table mein ek primary key hoti hai jo har row ko uniquely identify karti hai. | Natural, terms kept. |
| long-3 | Jab aap apne browser mein koi web address type karte hain, toh woh pehle ek DNS server se domain name ko IP address mein translate karne ko kehta hai. ... | Long paragraph stays fluent and complete. |
| hi-2 | 'Bandh' word ka use Hindi mein political parties dwara bulayi gayi general strike ko describe karne ke liye kiya jata hai. | Keeps the Hindi loanword, correct meaning. |

### Bad or awkward

| Case | Gemini output | Problem |
|---|---|---|
| dict-3 | ... **koi kaam ka kaam** karne ke bajaye faaltu ki cheezon mein time waste karna. | Garbled phrase ("useful kaam" became nonsense). The worst defect found. |
| edu-4 | ... **aisi model** ko train karti hai ... | Wrong gender: model is masculine, "aisa model". |
| dict-2 | **unexpected** tarike se ya chance se **aisi events** ... | Adds "unexpected" (not in the source) and wrong gender ("aise events"). |
| tech-1 | ... jo program **dwara ab reference nahi ki ja rahi ho** ... | Over-literal passive; speech would be "jis par program ab reference nahi karta". |
| edu-2 | Inflation wo rate hai **jispar** goods aur services ke prices ... | "jispar" is malformed (jis par / jisse). |
| amb-1 | **River ka bank** lambi grass se dhaka hua tha | Context makes it understandable, but "bank" alone reads as the financial bank to many Indian readers; "kinara" is clearer. Passed the automatic sense check. |
| Register (tech-2, mixed-2, mixed-3, tech-3) | ... set **karein**, ... ka use **karein**, ... **padhein** | Consistently formal "-ein" imperatives, stiffer than the "conversational teacher" target; references use "karo/padh lo". |

## Proposed prompt and harness changes (not applied; awaiting your go-ahead)

1. **Gender and agreement:** add a rule to check Hindi gender agreement ("aisa model", "aise events") and give one fix-style example.
2. **No additions:** add "do not add qualifiers that are not in the source (for example 'unexpected')", reinforced by the existing no-additions rule.
3. **Register:** ask for friendly spoken imperatives (karo, dekho, padh lo) instead of formal "-ein".
4. **Avoid literal passives:** prefer active speech over "dwara ... ki ja rahi"; add an example.
5. **Ambiguous nouns:** when the heading shows a non-technical sense (river bank), prefer the clear Hindi word (kinara).
6. **Definitions without a parenthetical:** add a second dictionary example in the style of dict-3.
7. **Scorer:** treat "Newton ka second law" as passing (use "second law" as the required term), and log which item needed repair.
8. Re-run the same 25 cases (about one US cent) and compare, ideally with a Hindi reader or a second model as judge; Gemini judging its own output is biased.

## Caveats

25 short cases, one run at temperature 0.3, so results will vary run to run. Short batches overstate quality relative to long, messy real pages. The extension has not yet been run end to end against Gemini on a real page. Latency here is sequential single requests from one machine and network.
