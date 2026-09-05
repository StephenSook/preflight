/**
 * The public site. Order of events on load: fonts, then the intro layer (once per session), then
 * the hero reveal at the reference's offset, then every scroll and interaction module, then the
 * live numbers from the host. The hero graph and the sandbox run the engine in this browser.
 */
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./styles/base.css";
import "./styles/site.css";
import { PROPERTIES } from "@preflight/engine";
import { brokenAnswer, menuReply } from "@preflight/reference";
import { prefersReducedMotion } from "./motion/core.js";
import { revealHero } from "./motion/hero.js";
import { initAccordions, initButtons, initCallouts, initMomentum } from "./motion/interact.js";
import { introPlayed, playIntro } from "./motion/intro.js";
import { initFooterParallax, initHeaderCompact, initPlopIn, initPulse, initSmoothScroll, initStickers } from "./motion/scroll.js";
import { initHandwritten, initStamp } from "./motion/text.js";
import { initDial } from "./site/dial.js";
import { renderHeroGraph, renderVerdictList } from "./site/hero-graph.js";
import { hydrateLive } from "./site/live.js";
import { initSandbox } from "./site/sandbox.js";

const html = document.documentElement;
if (prefersReducedMotion()) html.classList.add("reduced");
if (introPlayed() || prefersReducedMotion()) html.classList.add("no-intro");

async function boot(): Promise<void> {
  // The hero graph is drawn before anything moves, so the intro reveals a finished picture.
  const graphHost = document.querySelector<HTMLElement>("[data-hero-graph]");
  if (graphHost) {
    const paths = renderHeroGraph(graphHost);
    const timeout = paths.find((p) => p.name === "timeout");
    const list = document.querySelector<HTMLElement>("[data-hero-verdicts]");
    if (timeout && list) list.replaceChildren(renderVerdictList(timeout.verdicts, Object.fromEntries(PROPERTIES.map((p) => [p.id, p.title]))));
  }
  // The problem section shows the same two objects the graph drew, with the red line marked.
  const objectHost = document.querySelector<HTMLElement>("[data-object]");
  if (objectHost) {
    const answer = brokenAnswer("https://preflight-api-rc34.onrender.com/reference");
    const reply = menuReply(undefined, "scheduler");
    const lines = [`// the answer object`, ...JSON.stringify(answer, null, 2).split("\n"), "", `// what /reference/menu returns when nobody presses a key`, ...JSON.stringify(reply, null, 2).split("\n")];
    objectHost.replaceChildren(
      ...lines.flatMap((line, i) => {
        const node = document.createElement("span");
        node.textContent = line;
        if (/"action": "talk"/.test(line) && i > lines.length - 8) node.className = "hl";
        return [node, document.createTextNode("\n")];
      }),
    );
  }
  const sandbox = document.querySelector<HTMLElement>("[data-sandbox]");
  if (sandbox) initSandbox(sandbox);
  const dial = document.querySelector<HTMLElement>("[data-dial]");
  if (dial) initDial(dial);
  void hydrateLive();

  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
  html.classList.add("fonts-ready");
  const layer = document.querySelector<HTMLElement>("[data-intro]");
  if (layer) await playIntro(layer);
  html.classList.add("is-ready");
  revealHero();
  initSmoothScroll();
  initHeaderCompact();
  initStamp();
  initHandwritten();
  initButtons();
  initCallouts();
  initMomentum();
  initPlopIn();
  initStickers();
  initPulse();
  initFooterParallax();
  initAccordions();
}

void boot();
