/* Hollowmark — landing interactions (1:1 build) */
import "../styles/base.css";
import "../styles/landing.css";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- align mode (?align=1): overlay reference mockups at 50% ---------- */
if (new URLSearchParams(location.search).has("align")) {
  document.body.classList.add("align");
}

/* arm scroll-reveal hiding synchronously; transitions after first painted frame */
if (!reduceMotion) document.body.classList.add("anim");
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add("ready")));
/* safety: if IO is throttled (background tab at load), reveal everything after load */
window.addEventListener("load", () =>
  setTimeout(() => {
    if (document.visibilityState !== "visible") {
      document.querySelectorAll("[data-reveal]").forEach((n) => n.classList.add("is-visible"));
    }
  }, 1500)
);

/* ---------- nav ---------- */
const nav = document.getElementById("nav")!;
const onScroll = () => nav.classList.toggle("is-scrolled", window.scrollY > 30);
onScroll();
window.addEventListener("scroll", onScroll, { passive: true });

/* ---------- reveal ---------- */
const revealObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add("is-visible");
        revealObserver.unobserve(e.target);
      }
    }
  },
  { threshold: 0.12 }
);
document.querySelectorAll("[data-reveal]").forEach((n) => revealObserver.observe(n));

/* ---------- count-up ---------- */
const countObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      countObserver.unobserve(e.target);
      const el = e.target as HTMLElement;
      const target = Number(el.dataset.count);
      if (reduceMotion) {
        el.textContent = target.toLocaleString("en-US");
        continue;
      }
      const start = performance.now();
      const dur = 1700;
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / dur);
        el.textContent = Math.round(target * (1 - Math.pow(1 - t, 3))).toLocaleString("en-US");
        if (t < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  },
  { threshold: 0.5 }
);
document.querySelectorAll("[data-count]").forEach((n) => countObserver.observe(n));

/* ---------- live countdowns ---------- */
const pad = (n: number) => String(n).padStart(2, "0");

const warTimer = document.getElementById("warTimer");
if (warTimer) {
  const deadline = Date.now() + 3 * 864e5 + 12 * 36e5 + 47 * 6e4 + 22e3;
  const tick = () => {
    const d = Math.max(0, deadline - Date.now());
    warTimer.textContent = `${pad(Math.floor(d / 864e5))}:${pad(Math.floor(d / 36e5) % 24)}:${pad(Math.floor(d / 6e4) % 60)}:${pad(Math.floor(d / 1e3) % 60)}`;
  };
  tick();
  setInterval(tick, 1000);
}

const resetTimer = document.getElementById("resetTimer");
if (resetTimer) {
  const deadline = Date.now() + 27 * 864e5 + 14 * 36e5 + 32 * 6e4;
  const tick = () => {
    const d = Math.max(0, deadline - Date.now());
    resetTimer.textContent = `${Math.floor(d / 864e5)}D ${pad(Math.floor(d / 36e5) % 24)}H ${pad(Math.floor(d / 6e4) % 60)}M`;
  };
  tick();
  setInterval(tick, 30_000);
}

/* ---------- class card select ---------- */
document.querySelectorAll<HTMLElement>("#s02 .card").forEach((card) => {
  card.addEventListener("click", () => {
    document.querySelectorAll("#s02 .card").forEach((c) => c.classList.remove("sel"));
    card.classList.add("sel");
  });
});

/* ---------- hero embers ---------- */
const canvas = document.getElementById("embers") as HTMLCanvasElement | null;
if (canvas && !reduceMotion) {
  const ctx = canvas.getContext("2d")!;
  const COLORS = ["#d4aa55", "#f0cf85", "#6fd9c8", "#9fe9da"];
  const PX = 3;
  let w = 0;
  let h = 0;
  interface Ember { x: number; y: number; vy: number; vx: number; big: boolean; life: number; maxLife: number; color: string }
  let embers: Ember[] = [];
  const spawn = (): Ember => ({
    x: Math.random() * w,
    y: h + 10 + Math.random() * 40,
    vy: 0.22 + Math.random() * 0.6,
    vx: (Math.random() - 0.5) * 0.28,
    big: Math.random() > 0.72,
    life: 0,
    maxLife: 280 + Math.random() * 380,
    color: COLORS[(Math.random() * COLORS.length) | 0]
  });
  const init = () => {
    w = canvas.width = canvas.offsetWidth;
    h = canvas.height = canvas.offsetHeight;
    embers = Array.from({ length: Math.min(64, Math.floor(w / 22)) }, () => {
      const e = spawn();
      e.y = Math.random() * h;
      e.life = Math.random() * e.maxLife;
      return e;
    });
  };
  init();
  window.addEventListener("resize", init);
  let visible = true;
  new IntersectionObserver((en) => (visible = en[0].isIntersecting)).observe(canvas);
  const frame = () => {
    if (visible) {
      ctx.clearRect(0, 0, w, h);
      for (const e of embers) {
        e.life++;
        e.x += e.vx + Math.sin((e.life + e.y) * 0.01) * 0.2;
        e.y -= e.vy;
        if (e.y < -10 || e.life > e.maxLife) Object.assign(e, spawn());
        ctx.globalAlpha = 0.55 * Math.sin(Math.min(e.life / e.maxLife, 1) * Math.PI);
        ctx.fillStyle = e.color;
        const s = PX * (e.big ? 2 : 1);
        ctx.fillRect(Math.round(e.x / PX) * PX, Math.round(e.y / PX) * PX, s, s);
      }
      ctx.globalAlpha = 1;
    }
    requestAnimationFrame(frame);
  };
  frame();
}
