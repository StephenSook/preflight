# Frontend design checkpoint, Sat 2026-09-05 20:00

Prepared 2026-09-04 (Fri) after reading the reference document end to end (33,283 lines, both
prompts), running a Playwright harness against the referenced site at 1440 and 390 px (46 frames,
two videos, computed styles), fetching its three external stylesheets and scripts, and reading every
custom motion module. Nothing in `apps/web` has been built yet; that was the agreement. This page is
what the checkpoint decides on.

Local captures (ignored by git): `docs/design-reference/aardvark/{desktop-1440,mobile-390}/`.

## 1. What the reference actually does (measured, not guessed)

### Stack
- Webflow markup, custom code served by Slater; GSAP 3.15 with ScrollTrigger, SplitText, CustomEase,
  InertiaPlugin and DrawSVGPlugin (all free since GSAP 3.13); Lenis 1.3.17 smooth scroll (lerp 0.2,
  autoRaf, anchors); Barba 2.10 page transitions with prefetch; Smooothy drag sliders; MiniSearch.
- Everything is data-attribute driven (`data-button`, `data-call-out`, `data-plop-in`,
  `data-hero-sequence`, ...). Each `init*` module queries its attribute inside the current page
  container, so the same code runs on first load and after every Barba swap.
- Reduced motion is honoured in every module through `gsap.matchMedia` and a live
  `prefers-reduced-motion` listener. Hover effects only mount on `(hover: hover) and (pointer: fine)`.
  Keyboard focus (`focusin` with `:focus-visible`) replays the hover timelines.

### Eases and defaults
- Default ease `osmo` = cubic-bezier(0.625, 0.05, 0, 1); default duration 0.6 s; stagger 0.05.
- `energy` = SVG path `M0,0 C0.32,0.72 0,1 1,1` (fast start, soft landing) for fades and slides.
- `elastic.out(1, 0.72)` and `elastic.out(1, 0.75)` for every pop, stamp and card; `elastic.in` for
  exits; `circ.out` for clip-path reveals; `expo.out` for the canvas hero settle.

### The load sequence (the part you liked most)
1. A fixed full-screen layer (z 2000) holds one SVG squiggle path in violet with `stroke-width: 70%`
   and the logo mark in white (15 em on desktop, 5 em on mobile).
2. DrawSVG runs the path from `0% 100%` to `100% 100%` over 1.25 s (delay 0.65 s) while the stroke
   thins to 8% at 95%: the violet fills the screen, then wipes away along the squiggle.
3. The logo pops in (`scale 0, rotate -64, alpha 0` to `1, 0, 1`, elastic 0.65 s) and pops out
   (`scale 0, rotate 64`, elastic.in 0.6 s, delay 0.5 s).
4. At `start + 1.1 s` the header slides down from `yPercent -100` (energy, 0.5 s, delay 0.5 s), the
   hero background reveals through `clip-path: ellipse(20% 0% at 100% 100%)` to
   `ellipse(150% 130% at 100% 100%)` (circ.out 1.1 s), the headline words stamp in from
   `yPercent -10, xPercent 40, scaleY 0.1, scaleX 0.85, rotate 8, opacity 0` (elastic, 0.875 s,
   stagger 0.088 s), paragraph and button fade up (energy, 0.35 s), the handwritten note reveals per
   character (`rotate 22, x -0.25em, y 0.5em`, elastic 0.75 s, stagger 0.016 s), the floating
   product photo swings in (`y 5em, rotate -43` to `rotate -21`, elastic 0.75 s) and the canvas hero
   settles (`scale 1.15, rotate 6` to identity, expo.out 0.85 s).
5. Page transitions replay the same squiggle: leave draws it in with the stroke swelling to 70%,
   enter wipes it out and runs the hero intro again from `startEnter + 0.4 s`.

### Scroll and interaction modules (parameters worth keeping)
- Canvas frame sequences: frames named `base + zero-padded index + .webp`, loaded first, last, then by
  bisection so any scroll position has a nearby frame; `createImageBitmap`, cover-fit draw, DPR-aware
  resize, ScrollTrigger play/pause; a scrubbed variant drives text timelines at 30%, 60% and 81% of
  progress; reduced motion draws a single static frame.
- Callout cards: scattered by `xPercent/yPercent +-5, rotation +-7.5`, enter from `yPercent +150`
  (elastic 1.05 s, stagger 0.088); the pointer's x position picks a card, which straightens and
  scales 1.075 while the others fan by `45 / (index - i)` percent.
- Momentum hover: pointer velocity x25 becomes an InertiaPlugin throw (clamped to 1080 px), torque
  becomes rotation velocity (clamped 60 deg), resistance 160.
- Plop-in: `scale 0, rotate -20, y -4em` to `rotate 11` (elastic 0.7 s) at `top 80%`.
- Benefits and gift stickers: `rotate random(-33, 33), scale 0` to identity (elastic 0.85 s, stagger
  0.072); gift lands at `rotate -21`.
- Badge: two stacked items drop with elastic 1 s, 9 ms apart.
- Background animation: SVG paths pulse `stroke-width 0 to 60` and `rotate 0 to 2` (sine.inOut 3 s,
  yoyo) only while in view.
- Buttons: pill (`.button`) and split pill plus icon square (`.button-alt`); hover splits the label
  into characters that dip (`yPercent 55, scaleY 0.3, rotate 17`, power2.in at 20%) and spring back
  (`elastic.out(1, 0.4)`), 0.725 s, stagger amount 0.225.
- Handwritten in-view text: per-character elastic reveal, stagger 0.016.
- Tagline on a curve: `textPath startOffset` scrubbed over scroll.
- Footer parallax: top and bottom blocks from `y -12.5em`, the product visual from
  `scale 0.9, xPercent -35, y 17.5em, rotate 30`, overlay 0.55 to 0, scrub 0.2, clamped triggers.
- Emoji rain: 40 elements, random scale 0.4 to 1.1, 0.8 to 1.8 s fall, cleaned up after 2.75 s.
- Accordion: WAAPI height animation, 450 ms, cubic-bezier(.32, .72, 0, 1).
- Header compacts after 50 px of scroll (`data-scrolling-started`).
- Contrast helper: text on coloured cards flips to black or white from the card's luminance.

### Type, colour, layout (from computed styles)
- Display: Champ ExtraBold 700 (h1 120 px at 1440, tracking -1%, line-height 0.8; h2 78 px; h3 30 px).
  Body: Degular 500/600/700 (root 12 px with em scaling; paragraphs 18 to 24 px). Handwritten: Hello
  Organichand (annotations at 0.75 opacity, rotated 4 deg, periwinkle). Both display and body faces
  are commercial (Type Network / Adobe Fonts), so we need alternatives or a licence.
- Palette: yellow #ffd24a, pale yellow #faed8f, orange #f9a220, bright pink #fd48f2, soft pink
  #ffdbfd, cyan #1ce8ed, pale blue #a4f6f8, periwinkle #9982de, violet #3b308f, wine #670a2e, green
  #2de124, magenta #ff008c, black, white. Sections are full-bleed colour blocks with large rounded
  corners, organic wave SVGs in pale tints, studio renders of the product floating at an angle, black
  line illustrations on coloured cards, halftone dot patterns.
- Layout: 12 columns, 1.5 em margins, header 6.625 em, centred pill navigation, logo left, socials
  right, `--vw` custom property so every size scales with the viewport.

## 2. The Preflight adaptation (proposal)

The reference proves a bright, elastic, hand-annotated language can carry a serious product. For a
compliance interlock the risk is reading as a toy, so the proposal keeps the energy on the public
site and lets the product surfaces stay quiet and exact. Two surfaces, one motion library.

### Concept: preflight as in aviation
The name already says it. A pilot's preflight is a checklist; the tower says "cleared", "hold short"
or "no-go". Those map exactly onto pass, hold and block, and the metaphor is legible to a
non-engineer judge in one line. It also gives us imagery nobody else in the field will have: a
handset on a runway, checklist ticks in handwriting, tower phrasing in the copy.

### Tokens (proposal A, recommended)
- Verdict triad, identical on both surfaces and never used for anything else: blocked #E5484D,
  held #F5A524, passed #30A46C (from the spec's cockpit palette).
- Site: paper #FFF4D6 (page), sky #A4E4FF and pale sky #DDF4FF (calm blocks), cobalt #1F4BFF
  (interactive, annotations), safety orange #FF7A1A (primary call to action), ink #0B0D0F, white.
- Dashboard: the spec's cockpit set unchanged: canvas #0B0D0F, surface #14181C, text #E8EDF2 and
  #8B98A5, interactive #4C8DFF, plus the triad.
- Alternative B: lift the reference palette almost as is (yellow, pink, cyan). Alternative C: dark
  everywhere. I recommend A because it is ours, it photographs well behind a phone, and the triad
  stays unambiguous against paper and sky.

### Type
- Display: Bricolage Grotesque 800 (free, variable, chunky, tight tracking) in place of Champ.
- Body: Manrope 500 to 700 in place of Degular. Mono: JetBrains Mono for verdicts, citations and
  every number (the spec's choice). Handwritten: Caveat 600 for annotations.
- All self-hosted woff2, `font-display: swap`, an `is-ready` class after `document.fonts.ready`
  gates the intro so nothing stamps in before the display face is present.

### Motion library (re-implemented, not copied)
TypeScript modules under `apps/web/src/motion/`, data-attribute driven like the reference, each with
a `prefers-reduced-motion` branch and a destroy function: `transition`, `heroIntro`, `stampText`,
`handwritten`, `button`, `callout`, `plopIn`, `sticker`, `momentumHover`, `backgroundPulse`,
`frameSequence`, `footerParallax`, `accordion`, `counter`. GSAP 3.15 (SplitText, DrawSVG, Inertia,
CustomEase), Lenis. Single-page site, so no Barba: fewer moving parts and one less thing to break in
the film. The dashboard is a separate route in the same Vite app and reuses the library with its
motion budget turned down.

### The load sequence for Preflight
Same choreography and timing as the reference (about 1.9 s before the hero settles), different
drawing: a runway centreline draws across the screen with DrawSVG, the handset mark pops in and out
with the elastic pair, then the paper hero reveals through the bottom-right ellipse and the headline
stamps in word by word. The film opens on exactly this, so it is worth the 1.9 s. Reduced motion:
instant, no layer.

### Public site storyboard (sections, each mapped to a reference pattern)
1. Hero (paper): "Watch a call that would break federal law stop before the network ever hears it,
   then ring the moment the flow is fixed." Handwritten note: "no model decides". Visual options:
   (a) a 120-frame webp canvas sequence of a handset that rings, then goes dark, looping at 24 fps
   like the reference hero (generated, then cleaned); (b) the real flow graph assembling itself,
   drawn from the engine's own output; (c) real dashboard footage. Recommend (a) for the hero and (b)
   as the "how it works" visual, so the product's own artefact appears above the fold too.
2. The problem, on a real object (sky block): a real NCCO from the corpus, one branch lit blocked
   red, a handwritten "this line breaks 47 CFR 64.1200(b)(3)".
3. The block, live (paper with a safety-orange sticker): counters from `/api/summary` plopping in,
   the ledger head, "recomputed on every load". Real numbers only.
4. How it works (pale sky): four fanned callout cards, pointer picks one: read the flow, compile
   the statute, decide before the dial, write the receipt. Line illustrations in ink.
5. Dial it yourself (cobalt block, white text): the public number huge in the display face, the
   browser softphone, the consent gate explained in one sentence. Momentum hover on the number card.
6. Sandbox (paper, mono): paste an object, verdicts and citations in under a second, no account.
7. Evidence (cockpit dark block): ledger head, the `rekor-cli` command, the reconciliation count;
   background pulse on faint SVG arcs like a radar sweep.
8. Honest limits (paper): accordion, the same text as the README.
9. Footer parallax: the number, the repo, the handset visual swinging in from `rotate 30`.

### Dashboard rules
Six screens in spec order, cockpit palette, no handwriting except empty states. Three colours mean
three states and nothing else; every row carries colour, a text token and a dot. One signature
motion: the block (row settles red, the citation underline draws with DrawSVG, the handset icon
dims). Elastic insertion for new rows, momentum hover on actions, everything keyboard reachable and
announced as text. Reduced motion respected throughout.

### Accessibility and performance budget
Contrast AA everywhere (the reference's luminance helper is worth keeping for coloured cards);
`aria: "auto"` on SplitText; focus-visible replays hover; axe zero serious; Lighthouse 90+; frame
sequences at most 120 frames and about 60 KB each, bisection-loaded; fonts subset and self-hosted.

### Imagery plan
The reference uses studio renders of its product. Ours is a phone call, so the product image is a
handset. Candidates to bring to the checkpoint: two or three generated handset renders on paper and
sky backgrounds (kie.ai first, Higgsfield if quality falls short), plus our own wave and runway SVGs
drawn by hand. Real screen captures remain the film's evidence; generated art is garnish on the
site only.

## 3. Decisions for the checkpoint
1. Palette: A (paper, sky, cobalt, safety orange plus the triad), B (reference bright), or C (dark).
2. Fonts: the free stack above, or licence Champ and Degular.
3. Hero visual: (a) handset frame sequence, (b) procedural graph, (c) footage.
4. Load sequence: keep the full 1.9 s intro, or a 1.2 s cut.
5. Handwritten annotations: keep (recommended), and which phrases.
6. Single-page site with a dashboard route (recommended) or multi-page with transitions.
7. Public number in the footer: the real 943 number (recommended).

## 4. What is prepared by the checkpoint, and what waits for it
Prepared: this document, the captures and computed styles, a token file for A and B, the generated
handset candidates, the section copy drafted from the fact sheet. Waiting: all `apps/web` code, per
the agreement that no frontend is built before the checkpoint.

## 5. Decisions taken (Sat 2026-09-05, morning; Stephen delegated the checkpoint)

Stephen's instruction: take every item except the phone number. The seven decisions, each with the
reason it beat its alternatives, so the build can start and the film can plan on them.

1. **Palette: A.** Paper, sky, cobalt, safety orange on the site; the spec's cockpit set on the
   dashboard; the verdict triad identical on both and used for nothing else. B would read as a copy
   of the reference and C would flatten the film's contrast between the bright site and the dark
   dashboard. The dashboard body face changes from Inter to Manrope so both surfaces share one
   voice (the mono stays JetBrains Mono).
2. **Fonts: the free stack.** Bricolage Grotesque 800 (display), Manrope 500 to 700 (body), JetBrains
   Mono (verdicts, citations, every number), Caveat 600 (annotations). Self-hosted woff2, subset to
   latin, `font-display: swap`, the intro gated on `document.fonts.ready`. Licensing Champ and Degular
   would cost money and a day, and the free faces carry the same chunky-plus-refined pairing.
3. **Hero visual: (b), the product's own artefact.** The hero draws a real call-control object from
   the corpus as a flow graph, lets the engine run in the browser, and lights the one branch that
   breaks 47 CFR 64.1200(b)(3) in the verdict red with the citation printed. It is real, it is
   unique to this product, and it needs no generated frames. A generated handset still (candidate A,
   paper and runway) is the floating product image in the dial section and the footer, as garnish.
   A frame sequence (a) stays a possible upgrade if time remains after the dashboard and the film.
4. **Load sequence: the full 1.9 s, once per session.** The runway centreline draws, the handset
   mark pops in and out, the paper hero reveals through the ellipse and the headline stamps in word
   by word. `sessionStorage` marks it played; later loads in the same session go straight to a
   0.6 s hero reveal. Reduced motion: no layer, final state. The film opens on the full sequence.
5. **Handwritten annotations: keep, five phrases.** "no model decides" (hero), "this line breaks
   47 CFR 64.1200(b)(3)" (the red branch), "the phone stayed silent" (the live block sticker),
   "measured, not assumed" (card 3, beside the 868 ms and 1,009 ms figures), "nothing held, nothing
   hidden" (the held queue's empty state, the only handwriting on the dashboard). Caveat 600, cobalt
   at 0.8 opacity, rotated 4 degrees, `aria-hidden` with the same sense carried in the copy.
6. **Single-page site, two more entries, no Barba.** One Vite app with three entries: `/` the site,
   `/app/` the dashboard (six screens on hash routes), `/phone/` the page a phone opens for the
   softphone and the held-queue notifications. Page transitions have nothing to transition between;
   fewer moving parts in the film.
7. **The real number in the footer and in section 5:** +1 943 244 5023, the reference flow behind it
   on purpose, with the consent gate's one-sentence explanation beside it.

Also fixed here so nothing waits on another checkpoint: hero headline option A; the section order
of the storyboard as drafted in `copy.md`; every number on the site read from `/api/summary`,
`/api/campaign` and `/api/ledger/head` on load, never typed in; the dashboard's motion budget is
the row insertion, the block signature and the button spring, nothing else.
