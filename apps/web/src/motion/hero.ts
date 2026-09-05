/**
 * The hero reveal (the reference's timing, our drawing): header slides down, the paper block reveals
 * through the bottom-right ellipse, the headline stamps in word by word, paragraph and buttons fade
 * up on the energy ease, the handwritten note reveals per character, the product visual swings in.
 */
import { EASE_ENERGY, EASE_POP, EASE_REVEAL, EASE_STAMP, gsap, prefersReducedMotion, SplitText } from "./core.js";

export function revealHero(root: Document | HTMLElement = document): void {
  const header = root.querySelector<HTMLElement>("[data-header]");
  const hero = root.querySelector<HTMLElement>("[data-hero]");
  if (!hero) return;
  const headline = hero.querySelector<HTMLElement>("[data-hero-headline]");
  const fades = hero.querySelectorAll<HTMLElement>("[data-hero-fade]");
  const hand = hero.querySelector<HTMLElement>("[data-hero-hand]");
  const visual = hero.querySelector<HTMLElement>("[data-hero-visual]");
  const background = hero.querySelector<HTMLElement>("[data-hero-bg]");

  if (prefersReducedMotion()) {
    hero.classList.add("is-revealed");
    header?.classList.add("is-revealed");
    return;
  }

  const tl = gsap.timeline({ defaults: { ease: EASE_ENERGY } });
  if (header) tl.fromTo(header, { yPercent: -100 }, { yPercent: 0, duration: 0.5, clearProps: "transform" }, 0.5);
  if (background) tl.fromTo(background, { clipPath: "ellipse(20% 0% at 100% 100%)" }, { clipPath: "ellipse(150% 130% at 100% 100%)", duration: 1.1, ease: EASE_REVEAL, clearProps: "clipPath" }, 0);
  if (headline) {
    const split = new SplitText(headline, { type: "words", wordsClass: "word", aria: "auto" });
    gsap.set(headline, { visibility: "visible" });
    tl.fromTo(split.words, { yPercent: -10, xPercent: 40, scaleY: 0.1, scaleX: 0.85, rotate: 8, opacity: 0 }, { yPercent: 0, xPercent: 0, scaleY: 1, scaleX: 1, rotate: 0, opacity: 1, duration: 0.875, ease: EASE_STAMP, stagger: 0.088 }, 0.15);
  }
  if (fades.length > 0) tl.fromTo(fades, { y: "1.5em", opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, stagger: 0.08, clearProps: "transform" }, 0.6);
  if (hand) {
    const chars = new SplitText(hand, { type: "chars", charsClass: "char", aria: "auto" });
    gsap.set(hand, { visibility: "visible" });
    tl.fromTo(chars.chars, { rotate: 22, x: "-0.25em", y: "0.5em", opacity: 0 }, { rotate: 0, x: 0, y: 0, opacity: 1, duration: 0.75, ease: EASE_STAMP, stagger: 0.016 }, 0.9);
  }
  if (visual) tl.fromTo(visual, { y: "5em", rotate: -43, opacity: 0 }, { y: 0, rotate: -12, opacity: 1, duration: 0.75, ease: EASE_POP }, 0.7);
  tl.call(() => {
    hero.classList.add("is-revealed");
    header?.classList.add("is-revealed");
  });
}
