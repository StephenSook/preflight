/**
 * Scroll modules: Lenis smooth scroll (lerp 0.2, anchors), the header compacting after 50 px,
 * `data-plop-in` and `data-sticker` entrances, the background pulse on faint SVG arcs
 * (`data-pulse`, only while in view), the footer parallax (`data-footer-parallax`), and counters
 * that count up in view (`data-counter`). Every module has its reduced-motion branch.
 */
import Lenis from "lenis";
import { EASE_POP, gsap, onceInView, prefersReducedMotion, ScrollTrigger, type Module } from "./core.js";

export function initSmoothScroll(): Module {
  if (prefersReducedMotion()) return { destroy: () => undefined };
  const lenis = new Lenis({ lerp: 0.2, autoRaf: true, anchors: true });
  const sync = () => ScrollTrigger.update();
  lenis.on("scroll", sync);
  gsap.ticker.lagSmoothing(0);
  return { destroy: () => lenis.destroy() };
}

export function initHeaderCompact(root: ParentNode = document): Module {
  const header = root.querySelector<HTMLElement>("[data-header]");
  if (!header) return { destroy: () => undefined };
  const onScroll = () => header.toggleAttribute("data-scrolling-started", window.scrollY > 50);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
  return { destroy: () => window.removeEventListener("scroll", onScroll) };
}

/** Plop-in: scale 0, rotate -20, y -4em to a resting rotate the element names (default 0). */
export function initPlopIn(root: ParentNode = document): Module[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-plop-in]")).map((el) => {
    const rest = Number(el.dataset["plopIn"] ?? "0") || 0;
    if (prefersReducedMotion()) {
      el.style.visibility = "visible";
      el.style.transform = `rotate(${rest}deg)`;
      return { destroy: () => undefined };
    }
    gsap.set(el, { scale: 0, rotate: -20, y: "-4em", visibility: "visible" });
    return onceInView(el, () => gsap.to(el, { scale: 1, rotate: rest, y: 0, duration: 0.7, ease: EASE_POP }));
  });
}

/** Stickers: a random tilt from -33 to 33 degrees and scale 0 to identity, staggered within a group. */
export function initStickers(root: ParentNode = document): Module[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-sticker-group]")).map((group) => {
    const items = Array.from(group.querySelectorAll<HTMLElement>("[data-sticker]"));
    items.forEach((el) => {
      const rest = Number(el.dataset["sticker"] ?? "0") || 0;
      el.style.setProperty("--rest", `${rest}deg`);
    });
    if (prefersReducedMotion()) {
      items.forEach((el) => {
        el.style.visibility = "visible";
        el.style.transform = `rotate(var(--rest))`;
      });
      return { destroy: () => undefined };
    }
    gsap.set(items, { scale: 0, rotate: () => gsap.utils.random(-33, 33), visibility: "visible" });
    return onceInView(group, () => gsap.to(items, { scale: 1, rotate: (i) => Number(items[i]?.dataset["sticker"] ?? "0") || 0, duration: 0.85, ease: EASE_POP, stagger: 0.072 }));
  });
}

/** SVG paths pulse their stroke and rotate a degree or two, only while the section is in view. */
export function initPulse(root: ParentNode = document): Module[] {
  if (prefersReducedMotion()) return [];
  return Array.from(root.querySelectorAll<HTMLElement>("[data-pulse]")).map((section) => {
    const paths = section.querySelectorAll("[data-pulse-path]");
    if (paths.length === 0) return { destroy: () => undefined };
    const tween = gsap.fromTo(paths, { strokeWidth: 0.5, rotate: 0, transformOrigin: "50% 50%" }, { strokeWidth: 6, rotate: 2, duration: 3, ease: "sine.inOut", yoyo: true, repeat: -1, stagger: { each: 0.4, repeat: -1, yoyo: true }, paused: true });
    const st = ScrollTrigger.create({ trigger: section, start: "top bottom", end: "bottom top", onToggle: (self) => (self.isActive ? tween.play() : tween.pause()) });
    return {
      destroy: () => {
        st.kill();
        tween.kill();
      },
    };
  });
}

/** The footer's blocks rise from below and the product visual swings in as the footer scrolls into view, scrubbed. */
export function initFooterParallax(root: ParentNode = document): Module[] {
  if (prefersReducedMotion()) return [];
  return Array.from(root.querySelectorAll<HTMLElement>("[data-footer-parallax]")).map((footer) => {
    const blocks = footer.querySelectorAll<HTMLElement>("[data-footer-block]");
    const visual = footer.querySelector<HTMLElement>("[data-footer-visual]");
    const tl = gsap.timeline({ scrollTrigger: { trigger: footer, start: "top bottom", end: "top top", scrub: 0.2 } });
    if (blocks.length > 0) tl.fromTo(blocks, { y: "-12.5em" }, { y: 0, ease: "none", stagger: 0.05 }, 0);
    if (visual) tl.fromTo(visual, { scale: 0.9, xPercent: -35, y: "17.5em", rotate: 30 }, { scale: 1, xPercent: 0, y: 0, rotate: -8, ease: "none" }, 0);
    return { destroy: () => tl.kill() };
  });
}

/** A number counts up from zero when it enters the view; the target is the element's text at the time. */
export function initCounters(root: ParentNode = document): Module[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-counter]")).map((el) => {
    const target = Number(el.textContent?.replace(/[^0-9.]/g, "") ?? "0");
    if (!Number.isFinite(target) || prefersReducedMotion()) return { destroy: () => undefined };
    const format = (n: number) => Math.round(n).toLocaleString("en-US");
    el.textContent = "0";
    const state = { n: 0 };
    return onceInView(el, () => {
      gsap.to(state, { n: target, duration: 1.2, ease: "power3.out", onUpdate: () => (el.textContent = format(state.n)) });
    });
  });
}
