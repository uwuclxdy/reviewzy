/* ambient layer: the cursor-reactive dot grid and the trailing pointer ring.
   Two of the three sanctioned ambient effects, on by default, desktop fine-pointer only,
   silent under `prefers-reduced-motion`.

   Load as `<script type="module" src="cursor.js"></script>` after cursor.css. The rules
   module is imported relative to THIS file, so the pair works from any subpath with no
   page-side configuration. Serving is not optional: module imports die on file://. */

import { SEMANTIC_POINTER, SEMANTIC_BLOCKED, collectCursorSelectors } from './cursor-rules.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
// the CSS hides the ring at `(hover: none), (pointer: coarse)`, so the boot gate has to
// agree with it: a stylus is a fine pointer that cannot hover, and booting there armed the
// hidden cursor for a ring the stylesheet had already hidden - a page with no pointer at all
const fine = matchMedia('(pointer: fine) and (hover: hover)').matches;

// ---- cursor-reactive dot grid ----
{
  // The canvas is created here rather than pasted into every page. It is fixed at z-index -1,
  // so DOM position changes nothing about what it paints, and a hand-pasted element is a step
  // every page can skip: five of this system's own pages shipped with no ambient layer at all.
  let canvas = document.getElementById('bg-dots');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'bg-dots';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(canvas);
  }
  const ctx = canvas.getContext('2d');
  const interactive = fine && !reduced;          // touch / reduced get a still grid
  const gap = 40, R = 150;
  const mouse = { x: 0, y: 0, active: false };
  let w, h, dots = [], scheduled = false;

  /* THE GRID READS ITS TWO COLOURS OFF THE TOKENS, never a baked constant. The shipped
     constants were `[54, 56, 71]` and `[104, 187, 239]`, which are dark-theme `--line` and
     `--accent` resolved, so a Latte page painted a dark grid on a near-white surface.
     `getComputedStyle().color` serializes an oklch value back as oklch in Chrome 152, so
     the resolver is a 1x1 canvas: fillStyle takes any CSS colour the engine knows and
     getImageData hands back the sRGB bytes. `var(--x)` is NOT a colour to fillStyle, so the
     custom property is read as text first; a value fillStyle rejects leaves the previous
     one standing, which is what the sentinel catches. */
  const swatch = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const resolve = (prop, fallback) => {
    const css = getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
    if (!css) return fallback;
    swatch.fillStyle = '#000000';
    swatch.fillStyle = css;
    if (swatch.fillStyle === '#000000' && css !== '#000000') return fallback;
    swatch.fillRect(0, 0, 1, 1);
    const d = swatch.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  let base = [54, 56, 71], lit = [104, 187, 239];
  /* The resting alpha is a token so a page whose SUBJECT is the grid can raise it
     without a second grid or a copy of this module. The lift keeps its 0.80 peak
     whatever the floor, so a raised floor shortens the spotlight's travel rather
     than pushing it past the top of the ramp. */
  const REST = 0.24, PEAK = 0.80;
  let rest = REST;
  const readTokens = () => {
    base = resolve('--line', base);
    lit = resolve('--accent', lit);
    const raw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dot-rest'));
    rest = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), PEAK) : REST;
  };
  // the pitch, so CSS can align to the grid instead of restating 40 with no guard
  document.documentElement.style.setProperty('--dot-gap', gap + 'px');

  const build = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dots = [];
    const cols = Math.ceil(w / gap) + 1, rows = Math.ceil(h / gap) + 1;
    const ox = (w - (cols - 1) * gap) / 2, oy = (h - (rows - 1) * gap) / 2;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) dots.push({ bx: ox + x * gap, by: oy + y * gap });
  };
  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    const on = interactive && mouse.active;
    const shx = on ? (mouse.x - w / 2) / w * 10 : 0, shy = on ? (mouse.y - h / 2) / h * 10 : 0; // parallax
    for (const d of dots) {
      const px = d.bx + shx, py = d.by + shy;
      let a = rest, r = 1.15, c = base;
      if (on) {
        const dist = Math.hypot(px - mouse.x, py - mouse.y);
        if (dist < R) {
          const f = (1 - dist / R) ** 2;            // tight, eased spotlight
          a = rest + f * (PEAK - rest); r = 1 + f * 1.6;
          c = base.map((b, i) => Math.round(b + (lit[i] - b) * f));
        }
      }
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${a})`; ctx.fill();
    }
  };
  const schedule = () => { if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; draw(); }); } };

  readTokens(); build(); draw();
  if (interactive) {
    /* Every pointer track in this file rides `pointermove`, never `mousemove`.
       Cancelling a `pointerdown` default suppresses the compatibility mouse
       events for that pointer's whole active state, and this file cancels one
       on `a[href]` while the drawn scrollbar cancels one on its thumb, so both
       the grid and the ring froze for the length of any press-drag. Measured on
       the reference sheet, 8 moves under a held press: mousemove 0, pointermove
       8, against 8 and 8 with no button down. */
    addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = true; schedule();
    }, { passive: true });
    document.documentElement.addEventListener('mouseleave', () => { mouse.active = false; schedule(); });
  }
  addEventListener('resize', () => { build(); draw(); });
  // the theme toggle writes data-theme on the root, and the grid's two colours move with it
  new MutationObserver(() => { readTokens(); schedule(); })
    .observe(document.documentElement, { attributeFilter: ['data-theme'] });
}

// ---- trailing pointer ring (replaces the native cursor) ----
if (fine && !reduced) {
  const host = document.createElement('div');
  host.id = 'cursor';
  host.setAttribute('aria-hidden', 'true');
  const ring = document.createElement('div');
  ring.id = 'cursor-ring';
  host.append(ring);
  document.body.appendChild(host);
  // the native cursor is hidden on the first real mouse move, never here: a touchscreen laptop
  // matches (pointer: fine) too, and hiding it at boot leaves the page cursorless until the
  // visitor happens to move something

  // the rules module is a static relative import, so the sweep is ready before the first
  // event: no site-root specifier to get wrong, no console error on a page served from a
  // subpath, and no window where the ring answers neutral for everything
  const usable = list => list.filter(sel => {            // one bad selector poisons a whole
    try { ring.matches(sel); return true; } catch { return false; }   // closest() list
  }).join(', ');
  const found = collectCursorSelectors(document.styleSheets);
  const hitPointer = usable([...found.pointer, SEMANTIC_POINTER]);
  const hitInert = usable(found.inert);
  const hitBlocked = usable([...found.blocked, SEMANTIC_BLOCKED]);

  const field = 'input[type="text"], input[type="search"], input[type="email"], input[type="password"], input[type="url"], input[type="tel"], input[type="number"], textarea, [contenteditable="true"]';
  const probe = document.createRange();
  // the caret promises "text under the pointer", so hit-test the glyph runs: a block-level
  // heading or span stretches to its container and most of its box is empty. only the hovered
  // element's own text nodes count, since a child's glyphs would have retargeted the event
  const overText = (el, x, y) => {
    if (el.matches(field)) return true;              // a field is text everywhere, empty or not
    for (const n of el.childNodes) {
      if (n.nodeType !== Node.TEXT_NODE || !n.textContent.trim()) continue;
      probe.selectNodeContents(n);
      for (const r of probe.getClientRects()) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
      }
    }
    return false;
  };

  // share of the gap closed per frame. The ring is the aim, so it settles in ~4 frames rather
  // than ~13, and it still trails on a sweep
  const LERP = 0.35;
  const pointer = { x: 0, y: 0 }, trail = { x: 0, y: 0 };
  let placed = false, proven = false, drawId = 0, applyQueued = false, queuedTarget = null;
  let rootRetries = 0;
  let caretSource = null, pressedOnTarget = false, detached = false, bailed = false;
  const pulses = new Set();   // in-flight ripples, re-spawned when a view transition swallows them

  // standing down for a finger is temporary; a ring that threw is not. Arming has to be
  // repeatable or the first stand-down is permanent: the ring keeps painting and the OS arrow
  // comes back for the life of the page, taking the dragstart guard with it
  const arm = () => { if (!bailed) document.documentElement.classList.add('custom-cursor'); };

  // the ring is written here and nowhere else, so a burst of moves costs one style write per
  // frame; the loop ends the frame it catches up, which is also why the trail can never sit
  // stranded behind a pointer that stopped moving
  function paint() {
    drawId = 0;
    // over text the ring IS the caret, and a caret lagging behind the pointer stands where the
    // click will NOT put it, so that state closes the gap in one frame
    const lerp = host.classList.contains('text') ? 1 : LERP;
    const dx = pointer.x - trail.x, dy = pointer.y - trail.y;
    if (lerp === 1 || (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1)) { trail.x = pointer.x; trail.y = pointer.y; }
    else { trail.x += dx * lerp; trail.y += dy * lerp; drawId = requestAnimationFrame(paint); }
    ring.style.transform = `translate3d(${trail.x}px, ${trail.y}px, 0) translate(-50%, -50%)`;
    // the native cursor hides only after this write painted a frame, so a ring that dies at
    // boot never leaves the page cursorless
    if (!proven) { proven = true; arm(); }
  }
  const draw = () => { if (!drawId) drawId = requestAnimationFrame(paint); };

  // if anything throws after the class went on, the native cursor comes back and stays back
  addEventListener('error', () => { bailed = true; document.documentElement.classList.remove('custom-cursor'); });

  function stateFor(el, x, y) {
    if (!el) return '';
    if (hitBlocked && el.closest(hitBlocked)) return 'blocked';
    const click = hitPointer && el.closest(hitPointer);
    if (click) {
      // a rule switching the pointer back off only outranks the clickable one from its own
      // element or below it
      const off = hitInert && el.closest(hitInert);
      if (!off || !(off === click || click.contains(off))) return 'hover';
    }
    return overText(el, x, y) ? 'text' : '';
  }

  // el === null means "work out what is under the pointer now", the only honest answer once
  // something other than the pointer moved
  function apply(el) {
    const target = el || document.elementFromPoint(pointer.x, pointer.y);
    // a root view transition answers the root element for every point while it
    // runs, and its animations lag the swap's first frame, so probing them here
    // can miss the transition entirely. The root answer is never a useful state
    // anyway: re-derive until hit testing names a real element again.
    if (!el && target === document.documentElement) {
      if (rootRetries++ < 5) setTimeout(() => schedule(null), 80);
      return;
    }
    rootRetries = 0;
    const state = stateFor(target, pointer.x, pointer.y);
    host.classList.toggle('hover', state === 'hover');
    host.classList.toggle('blocked', state === 'blocked');
    host.classList.toggle('text', state === 'text');
    if (state === 'text' && target && target !== caretSource) {
      caretSource = target;
      // the bar tracks the font only so far: past display sizes a proportional caret stops
      // reading as a cursor and starts reading as a rule drawn on the page, so it stops just
      // above the idle ring's own 26px
      const size = parseFloat(getComputedStyle(target).fontSize);
      if (size) host.style.setProperty('--caret-h', Math.min(Math.round(size * 1.2), 24) + 'px');
    } else if (state !== 'text') caretSource = null;
  }

  // overText reads client rects, which forces layout: once a frame, never once a move
  function schedule(el) {
    queuedTarget = el;
    if (applyQueued) return;
    applyQueued = true;
    requestAnimationFrame(() => { applyQueued = false; apply(queuedTarget); });
  }

  function pulse(x, y) {                             // placed by left/top, not a transform, so
    const p = document.createElement('div');         // the keyframe's scale has nothing to fight
    p.className = 'cursor-pulse';
    p.style.left = x + 'px';
    p.style.top = y + 'px';
    p.addEventListener('animationend', () => { p.remove(); pulses.delete(p); });
    pulses.add(p);
    host.appendChild(p);
  }

  addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    pointer.x = e.clientX; pointer.y = e.clientY;
    if (!placed || detached) {
      placed = true; detached = false;
      trail.x = pointer.x; trail.y = pointer.y;
      if (proven) arm();   // the mouse is back after a finger took over
    }
    host.classList.add('visible');
    schedule(e.target instanceof Element ? e.target : null);
    draw();
  }, { passive: true });

  document.documentElement.addEventListener('mouseleave', () => host.classList.remove('visible'));
  /* NOT WHILE A PRESS IS HELD. `schedule(null)` means "work out what is under the
     pointer now", and a held press is exactly when that is the wrong question: the
     pressed element owns the pointer through a capture, and the drag's own scroll
     fires every frame, so the captured target was overwritten and re-derived from
     the raw point. Dragging the drawn scrollbar 17px off its 6px lane therefore
     dropped `hover`, and `press` alone is pixel-identical to idle, so the ring
     went back to its resting size mid-drag with the page still scrolling. The next
     real move re-derives it either way. */
  addEventListener('scroll', () => {
    if (!host.classList.contains('press')) schedule(null);
  }, { passive: true, capture: true });

  // capture on the press pair: a handler that stops propagation must not strand the ring
  addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse') {                 // a finger took over: stand down and give
      detached = true;                               // the native cursor back
      host.classList.remove('visible');
      document.documentElement.classList.remove('custom-cursor');
      return;
    }
    pressedOnTarget = host.classList.contains('hover');
    host.classList.add('press');
  }, { capture: true });

  const release = () => host.classList.remove('press');
  addEventListener('pointerup', e => {
    release();
    if (pressedOnTarget && e.pointerType === 'mouse') pulse(e.clientX, e.clientY);
    pressedOnTarget = false;
    schedule(null);          // the click's handler may have removed or moved the target
  }, { capture: true });
  // A page view transition (the theme swap) crossfades the live page in, which
  // multiplies a pulse spawned at pointerup down to near-invisible for its first
  // 100ms, and the capture freezes it in the old snapshot at its first, smallest
  // frame. The cursor owes the ripple in every state, so one re-check after the
  // click: if a root transition is running, the in-flight pulses are re-spawned
  // into the live side, where the ramp has mostly run its course by the time
  // the ripple grows. No transition, no re-spawn: the check rides every click
  // but only acts while a pulse exists.
  const inViewTransition = () => document.getAnimations().some(a =>
    a.effect && a.effect.pseudoElement === '::view-transition-new(root)');
  document.addEventListener('click', () => {
    setTimeout(() => {
      if (!inViewTransition() || !pulses.size) return;
      pulses.forEach(p => { p.remove(); pulses.delete(p); });
      pulse(pointer.x, pointer.y);
    }, 50);
  }, { capture: true });
  addEventListener('pointercancel', release, { capture: true });
  // a native drag brings the OS cursor and a ghost image back, and no `cursor: none` outranks
  // either, so the drag has to not start. The cost is dragging a link or an image out of the
  // page; keep the class gate, because once a finger takes over there is no ring to protect.
  // Links and images start an HTML5 drag on press-move in every engine, and the
  // `-webkit-user-drag: none` CSS only reaches Blink: the first dragstart frame has already
  // painted the OS cursor. Mark them not draggable, the property the engine itself reads;
  // the dragstart guard below stays for dynamically added content and for engines that
  // ignore the attribute.
  document.querySelectorAll('a[href], img').forEach(el => { el.draggable = false; });
  addEventListener('dragstart', (e) => {
    release();
    if (document.documentElement.classList.contains('custom-cursor')) e.preventDefault();
  }, { capture: true });
  // NONE OF THE THREE GUARDS ABOVE RUNS FOR A LINK HELD STILL. A press on `a[href]` hands
  // the cursor to the browser's link-drag machinery before any dragstart exists to cancel,
  // so the platform pointer paints on top of the ring for as long as the button is held.
  // Measured against targets identical but for their tag: only `a[href]` does it; `a`
  // without href, `button` and a plain box stay clean, and the page-side state is untouched
  // throughout (class on, `press` on, no pointercancel, no blur, no dragstart).
  // REFUSING THE MOUSEDOWN DEFAULT IS TOO LATE, measured: the cursor is already taken by
  // then. `pointerdown` is the first event of the sequence, and its default action is what
  // produces the compatibility mouse events the drag hangs off. Click, activation and
  // navigation all survive it; focus and a selection STARTING inside the link do not, so
  // the focus is set by hand here.
  addEventListener('pointerdown', (e) => {
    // primary mouse only: touch scrolls with this default, the middle button opens the link
    // in a tab and the right button raises the context menu
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (!document.documentElement.classList.contains('custom-cursor')) return;
    const link = e.target instanceof Element && e.target.closest('a[href]');
    if (!link) return;
    e.preventDefault();
    // `focusVisible: false` or every click paints the keyboard ring: a script focus is
    // treated as one, and the refused default is what would have marked it as a mouse
    // focus. Tab still rings, and an engine that ignores the option only over-rings.
    link.focus({ preventScroll: true, focusVisible: false });
  }, { capture: true });
  addEventListener('blur', release);
}
