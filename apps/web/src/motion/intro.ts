/**
 * The load sequence (checkpoint decision 4): a fixed layer draws the runway centreline across the
 * screen with DrawSVG while the stroke swells and then thins, the handset mark pops in and out
 * with the elastic pair, and the layer wipes away. Played once per session; later loads resolve at
 * once so the hero reveals without the layer. Reduced motion: no layer at all.
 */
import { EASE_POP, gsap, prefersReducedMotion } from "./core.js";

const KEY = "preflight:intro-played";

export function introPlayed(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function markPlayed(): void {
  try {
    sessionStorage.setItem(KEY, "1");
  } catch {
    // Storage may be unavailable; the intro then plays on every load, which is the reference's behaviour.
  }
}

/** Resolves when the hero may begin its own reveal (start + 1.1 s in the reference's timing), and removes the layer when done. */
export function playIntro(layer: HTMLElement): Promise<void> {
  if (prefersReducedMotion() || introPlayed()) {
    layer.remove();
    return Promise.resolve();
  }
  const path = layer.querySelector<SVGPathElement>("[data-intro-path]");
  const mark = layer.querySelector<HTMLElement>("[data-intro-mark]");
  if (!path || !mark) {
    layer.remove();
    return Promise.resolve();
  }
  markPlayed();
  layer.hidden = false;
  return new Promise((resolve) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      resolve();
    };
    const tl = gsap.timeline({
      onComplete: () => {
        layer.remove();
        release();
      },
    });
    // The centreline draws across the screen while its stroke fills the viewport, then thins to a line.
    tl.set(path, { drawSVG: "0% 0%", strokeWidth: "70%" });
    tl.to(path, { drawSVG: "0% 100%", duration: 1.25, ease: "power3.inOut" }, 0.35);
    tl.to(path, { strokeWidth: "8%", duration: 0.5, ease: "power2.in" }, 1.25);
    tl.to(path, { drawSVG: "100% 100%", duration: 0.55, ease: "power2.inOut" }, 1.55);
    // The mark pops in, holds, pops out.
    tl.fromTo(mark, { scale: 0, rotate: -64, autoAlpha: 0 }, { scale: 1, rotate: 0, autoAlpha: 1, duration: 0.65, ease: EASE_POP }, 0.5);
    tl.to(mark, { scale: 0, rotate: 64, autoAlpha: 0, duration: 0.6, ease: "elastic.in(1, 0.75)" }, 1.55);
    // The hero starts before the layer is gone, as the reference overlaps them.
    tl.call(release, [], 1.1);
    tl.to(layer, { autoAlpha: 0, duration: 0.3 }, 2.05);
  });
}
