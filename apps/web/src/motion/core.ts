/**
 * The motion core: GSAP with the plugins the reference uses (all free since 3.13), the two eases
 * the reference is built on, and the reduced-motion state every module branches on. Nothing here
 * animates by itself; modules opt elements in through data attributes.
 */
import { gsap } from "gsap";
import { CustomEase } from "gsap/CustomEase";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { InertiaPlugin } from "gsap/InertiaPlugin";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";

gsap.registerPlugin(ScrollTrigger, SplitText, DrawSVGPlugin, CustomEase, InertiaPlugin);

/** The reference's default ease (cubic-bezier 0.625, 0.05, 0, 1) and its fast-start soft-landing "energy" path. */
export const EASE_DEFAULT = "osmo";
export const EASE_ENERGY = "energy";
export const EASE_POP = "elastic.out(1, 0.72)";
export const EASE_STAMP = "elastic.out(1, 0.75)";
export const EASE_REVEAL = "circ.out";

if (!CustomEase.get(EASE_DEFAULT)) CustomEase.create(EASE_DEFAULT, "0.625, 0.05, 0, 1");
if (!CustomEase.get(EASE_ENERGY)) CustomEase.create(EASE_ENERGY, "M0,0 C0.32,0.72 0,1 1,1");
gsap.defaults({ ease: EASE_DEFAULT, duration: 0.6 });

const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const listeners = new Set<(reduced: boolean) => void>();
reducedQuery.addEventListener("change", () => {
  for (const l of listeners) l(reducedQuery.matches);
});

/** True when the visitor asked for less motion; every module sets its final state instead of tweening. */
export const prefersReducedMotion = (): boolean => reducedQuery.matches;
export const onReducedMotionChange = (l: (reduced: boolean) => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Hover effects mount only where a pointer can hover, as the reference does. */
export const hoverCapable = (): boolean => window.matchMedia("(hover: hover) and (pointer: fine)").matches;

export interface Module {
  destroy(): void;
}

/** Runs `enter` once when the element reaches `start` (a ScrollTrigger start string), or at once under reduced motion. */
export function onceInView(el: Element, enter: () => void, start = "top 80%"): Module {
  if (prefersReducedMotion()) {
    enter();
    return { destroy: () => undefined };
  }
  const trigger = ScrollTrigger.create({ trigger: el, start, once: true, onEnter: enter });
  return { destroy: () => trigger.kill() };
}

export { gsap, ScrollTrigger, SplitText };
