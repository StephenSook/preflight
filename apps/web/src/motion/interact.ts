/**
 * Pointer and keyboard interaction modules: the button label dip (`data-button`), the fanned callout
 * cards a pointer picks (`data-callout`), momentum hover through InertiaPlugin (`data-momentum`),
 * and the accordion (`data-accordion`, WAAPI height). Hover effects mount only on hover-capable
 * devices; keyboard focus replays them; reduced motion disables the pointer physics.
 */
import { gsap, hoverCapable, prefersReducedMotion, ScrollTrigger, SplitText, type Module } from "./core.js";

/** The label splits into characters that dip and spring back on hover and on keyboard focus. */
export function initButtons(root: ParentNode = document): Module[] {
  if (prefersReducedMotion()) return [];
  return Array.from(root.querySelectorAll<HTMLElement>("[data-button]")).map((el) => {
    const label = el.querySelector<HTMLElement>(".label") ?? el;
    const split = new SplitText(label, { type: "chars", charsClass: "char", aria: "auto" });
    let playing = false;
    const play = () => {
      if (playing) return;
      playing = true;
      gsap
        .timeline({ onComplete: () => (playing = false) })
        .to(split.chars, { yPercent: 55, scaleY: 0.3, rotate: 17, duration: 0.725 * 0.2, ease: "power2.in", stagger: { amount: 0.225 } })
        .to(split.chars, { yPercent: 0, scaleY: 1, rotate: 0, duration: 0.725 * 0.8, ease: "elastic.out(1, 0.4)", stagger: { amount: 0.225 } }, "<0.1");
    };
    const onFocus = () => {
      if (el.matches(":focus-visible")) play();
    };
    if (hoverCapable()) el.addEventListener("pointerenter", play);
    el.addEventListener("focusin", onFocus);
    return {
      destroy: () => {
        el.removeEventListener("pointerenter", play);
        el.removeEventListener("focusin", onFocus);
        split.revert();
      },
    };
  });
}

/** Four (or so) cards scattered on entry; the pointer's x picks one, which straightens while the others fan away from it. */
export function initCallouts(root: ParentNode = document): Module[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-callout]")).map((group) => {
    const cards = Array.from(group.querySelectorAll<HTMLElement>("[data-callout-card]"));
    if (cards.length === 0) return { destroy: () => undefined };
    const scatter = cards.map((_, i) => ({ x: gsap.utils.random(-5, 5), y: gsap.utils.random(-5, 5), r: gsap.utils.random(-7.5, 7.5), i }));
    if (prefersReducedMotion()) {
      cards.forEach((c) => c.classList.add("is-in"));
      return { destroy: () => undefined };
    }
    gsap.set(cards, { yPercent: 150, xPercent: (i) => scatter[i]?.x ?? 0, rotation: (i) => scatter[i]?.r ?? 0 });
    let entered = false;
    const enter = () => {
      if (entered) return;
      entered = true;
      gsap.to(cards, { yPercent: (i) => scatter[i]?.y ?? 0, duration: 1.05, ease: "elastic.out(1, 0.72)", stagger: 0.088, onComplete: () => cards.forEach((c) => c.classList.add("is-in")) });
    };
    const st = ScrollTrigger.create({ trigger: group, start: "top 75%", once: true, onEnter: enter });
    let picked = -1;
    const pick = (index: number) => {
      if (index === picked) return;
      picked = index;
      cards.forEach((card, i) => {
        const s = scatter[i];
        if (!s) return;
        if (i === index) gsap.to(card, { xPercent: 0, yPercent: 0, rotation: 0, scale: 1.075, duration: 0.6, ease: "elastic.out(1, 0.75)", zIndex: 3 });
        else gsap.to(card, { xPercent: s.x + 45 / (index - i), yPercent: s.y, rotation: s.r, scale: 1, duration: 0.6, ease: "elastic.out(1, 0.75)", zIndex: 1 });
      });
    };
    const rest = () => {
      picked = -1;
      cards.forEach((card, i) => {
        const s = scatter[i];
        if (s) gsap.to(card, { xPercent: s.x, yPercent: s.y, rotation: s.r, scale: 1, duration: 0.6, ease: "elastic.out(1, 0.75)", zIndex: 1 });
      });
    };
    const onMove = (e: PointerEvent) => {
      const rect = group.getBoundingClientRect();
      const t = gsap.utils.clamp(0, 0.999, (e.clientX - rect.left) / rect.width);
      pick(Math.floor(t * cards.length));
    };
    const onFocus = (e: FocusEvent) => {
      const i = cards.findIndex((c) => c === e.target || c.contains(e.target as Node));
      if (i >= 0) pick(i);
    };
    if (hoverCapable()) {
      group.addEventListener("pointermove", onMove);
      group.addEventListener("pointerleave", rest);
    }
    group.addEventListener("focusin", onFocus);
    group.addEventListener("focusout", rest);
    return {
      destroy: () => {
        st.kill();
        group.removeEventListener("pointermove", onMove);
        group.removeEventListener("pointerleave", rest);
        group.removeEventListener("focusin", onFocus);
        group.removeEventListener("focusout", rest);
      },
    };
  });
}

/** Pointer velocity becomes a throw with torque (InertiaPlugin), clamped as the reference clamps it. */
export function initMomentum(root: ParentNode = document): Module[] {
  if (prefersReducedMotion() || !hoverCapable()) return [];
  return Array.from(root.querySelectorAll<HTMLElement>("[data-momentum]")).map((el) => {
    let last: { x: number; y: number; t: number } | null = null;
    const onEnter = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY, t: performance.now() };
    };
    const onMove = (e: PointerEvent) => {
      if (!last) return;
      const now = performance.now();
      const dt = Math.max(1, now - last.t);
      const vx = ((e.clientX - last.x) / dt) * 1000 * 25;
      const vy = ((e.clientY - last.y) / dt) * 1000 * 25;
      last = { x: e.clientX, y: e.clientY, t: now };
      const clamp = gsap.utils.clamp(-1080, 1080);
      const rect = el.getBoundingClientRect();
      const lever = (e.clientY - (rect.top + rect.height / 2)) / rect.height;
      gsap.to(el, {
        inertia: {
          x: { velocity: clamp(vx) * 0.05, end: 0 },
          y: { velocity: clamp(vy) * 0.05, end: 0 },
          rotation: { velocity: gsap.utils.clamp(-60, 60, (clamp(vx) / 1080) * 60 * -lever), end: 0 },
          resistance: 160,
        },
      });
    };
    const onLeave = () => {
      last = null;
    };
    el.addEventListener("pointerenter", onEnter);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return {
      destroy: () => {
        el.removeEventListener("pointerenter", onEnter);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerleave", onLeave);
      },
    };
  });
}

/** A details-like accordion: the trigger toggles `aria-expanded`, the panel's height animates with WAAPI (450 ms, the reference's curve). */
export function initAccordions(root: ParentNode = document): Module[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-accordion]")).map((item) => {
    const trigger = item.querySelector<HTMLButtonElement>("[data-accordion-trigger]");
    const panel = item.querySelector<HTMLElement>("[data-accordion-panel]");
    if (!trigger || !panel) return { destroy: () => undefined };
    const setOpen = (open: boolean, animate: boolean) => {
      trigger.setAttribute("aria-expanded", String(open));
      item.classList.toggle("is-open", open);
      const from = panel.getBoundingClientRect().height;
      panel.hidden = !open;
      const to = open ? panel.scrollHeight : 0;
      if (!animate || prefersReducedMotion()) return;
      panel.hidden = false;
      panel.style.overflow = "hidden";
      const anim = panel.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 450, easing: "cubic-bezier(.32,.72,0,1)" });
      anim.onfinish = () => {
        panel.style.overflow = "";
        panel.hidden = !open;
      };
    };
    setOpen(trigger.getAttribute("aria-expanded") === "true", false);
    const onClick = () => setOpen(trigger.getAttribute("aria-expanded") !== "true", true);
    trigger.addEventListener("click", onClick);
    return { destroy: () => trigger.removeEventListener("click", onClick) };
  });
}
