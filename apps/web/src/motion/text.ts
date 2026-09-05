/**
 * In-view text: `data-stamp` stamps a heading in word by word; `data-handwritten` reveals an
 * annotation per character. Both split with SplitText (aria: auto keeps the text readable), run
 * once when 80% of the viewport reaches them, and set their final state under reduced motion.
 */
import { EASE_STAMP, gsap, onceInView, prefersReducedMotion, SplitText, type Module } from "./core.js";

export function initStamp(root: ParentNode = document): Module[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-stamp]")).map((el) => {
    if (prefersReducedMotion()) {
      el.style.visibility = "visible";
      return { destroy: () => undefined };
    }
    const split = new SplitText(el, { type: "words", wordsClass: "word", aria: "auto" });
    gsap.set(split.words, { yPercent: -10, xPercent: 40, scaleY: 0.1, scaleX: 0.85, rotate: 8, opacity: 0 });
    el.style.visibility = "visible";
    const view = onceInView(el, () => {
      gsap.to(split.words, { yPercent: 0, xPercent: 0, scaleY: 1, scaleX: 1, rotate: 0, opacity: 1, duration: 0.875, ease: EASE_STAMP, stagger: 0.088 });
    });
    return {
      destroy: () => {
        view.destroy();
        split.revert();
      },
    };
  });
}

export function initHandwritten(root: ParentNode = document): Module[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-handwritten]")).map((el) => {
    if (prefersReducedMotion()) {
      el.style.visibility = "visible";
      return { destroy: () => undefined };
    }
    const split = new SplitText(el, { type: "chars", charsClass: "char", aria: "auto" });
    gsap.set(split.chars, { rotate: 22, x: "-0.25em", y: "0.5em", opacity: 0 });
    el.style.visibility = "visible";
    const view = onceInView(el, () => {
      gsap.to(split.chars, { rotate: 0, x: 0, y: 0, opacity: 1, duration: 0.75, ease: EASE_STAMP, stagger: 0.016 });
    });
    return {
      destroy: () => {
        view.destroy();
        split.revert();
      },
    };
  });
}
