// reviewzy dashboard behaviors. Load after htmx.min.js.
(() => {
  "use strict";

  // --- Navbar ink (cloudy-ui navbar component) ---
  // Positions the sliding underline under the active link; re-positions on resize without animating.
  const navbarNav = document.getElementById("navbar-nav");
  const navbarInk = document.getElementById("navbar-ink");

  function positionNavbarInk() {
    if (!navbarNav || !navbarInk) return;
    const active = navbarNav.querySelector(".navbar-link.active");
    if (!active) {
      navbarInk.style.opacity = "0";
      return;
    }
    const navRect = navbarNav.getBoundingClientRect();
    const linkRect = active.getBoundingClientRect();
    navbarInk.style.left = `${linkRect.left - navRect.left}px`;
    navbarInk.style.width = `${linkRect.width}px`;
    navbarInk.style.opacity = "1";
  }

  window.addEventListener("resize", () => {
    navbarInk.style.transition = "none";
    positionNavbarInk();
    requestAnimationFrame(() => {
      navbarInk.style.transition = "";
    });
  });
  requestAnimationFrame(positionNavbarInk);

  // --- Filter errors ---
  // A failed filter request (HTTP error or network error) replaces the list with the error box
  // from the page's #error-box template; the retry button re-submits the filter form.
  const form = document.getElementById("filters");
  const list = document.getElementById("entries-list");
  const errorTemplate = document.getElementById("error-box");

  function showFilterError() {
    if (!form || !list || !errorTemplate) return;
    const box = errorTemplate.content.cloneNode(true);
    const retry = box.querySelector("[data-retry]");
    if (retry) {
      retry.addEventListener("click", () => {
        // htmx listens for submit directly on the form it processed, so a native requestSubmit
        // reaches it; the reload fallback covers the case where htmx did not load.
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
        } else {
          window.location.reload();
        }
      });
    }
    list.replaceChildren(box);
  }

  if (form) {
    form.addEventListener("htmx:responseError", showFilterError);
    form.addEventListener("htmx:sendError", showFilterError);
  }

  // --- Style guide save errors ---
  // A failed save (HTTP error or network error) puts the error box from the page's
  // #style-guide-error-box template above the form; the retry button re-submits the save form.
  // Delegated on document: a successful swap replaces the form element, so listeners bound to it
  // would die.
  const styleGuideErrorTemplate = document.getElementById("style-guide-error-box");

  function showStyleGuideError(event) {
    if (!(event.target instanceof Element) || event.target.id !== "style-guide-form") return;
    const region = document.getElementById("style-guide-region");
    if (!region || !styleGuideErrorTemplate) return;
    // The box goes above the form, never replacing it: the retry re-submits the very form the
    // failed request came from, and a replacement would leave nothing to re-submit. A success or
    // refusal swap replaces the whole region and takes the box with it; a repeated error drops
    // the previous box first so the notices cannot stack.
    region.querySelector("[data-style-guide-error]")?.remove();
    const box = styleGuideErrorTemplate.content.cloneNode(true);
    box.querySelector(".callout")?.setAttribute("data-style-guide-error", "");
    const retry = box.querySelector("[data-retry]");
    if (retry) {
      retry.addEventListener("click", () => {
        // htmx listens for submit directly on the form it processed, so a native requestSubmit
        // reaches it; the reload fallback covers the case where htmx did not load.
        const target = document.getElementById("style-guide-form");
        if (target && typeof target.requestSubmit === "function") {
          target.requestSubmit();
        } else {
          window.location.reload();
        }
      });
    }
    region.prepend(box);
  }

  document.addEventListener("htmx:responseError", showStyleGuideError);
  document.addEventListener("htmx:sendError", showStyleGuideError);

  // --- Editor live metrics ---
  // The constraint panel lives outside the htmx swap region, so the char count and the placeholder
  // checklist track the textarea as the user types. This is a convenience preview only: the server
  // store layer owns the refusal, and the panel re-syncs on any swap.
  function refreshEditorMetrics() {
    const textarea = document.getElementById("editor-text");
    if (!textarea) return;
    const announcements = [];

    const charCount = document.getElementById("char-count");
    if (charCount) {
      const max = Number(charCount.dataset.maxLen);
      if (Number.isFinite(max)) {
        const length = textarea.value.length;
        const over = length > max;
        const wasOver = charCount.classList.contains("over");
        charCount.textContent = `${length} / ${max}`;
        charCount.classList.toggle("over", over);
        if (over !== wasOver) {
          announcements.push(
            over ? `Over the length limit of ${max} characters` : `Within the ${max} character limit`,
          );
        }
      }
    }

    for (const item of document.querySelectorAll(".placeholder-item")) {
      const placeholder = item.dataset.placeholder ?? "";
      const present = textarea.value.includes(placeholder);
      const state = item.querySelector(".placeholder-state");
      if (state) {
        const wasPresent = state.classList.contains("is-present");
        state.textContent = present ? "Present" : "Missing";
        state.classList.toggle("is-present", present);
        if (present !== wasPresent) {
          announcements.push(`Placeholder {${placeholder}} ${present ? "present" : "missing"}`);
        }
      }
    }

    // Announced flips only; the per-keystroke values themselves are never read aloud.
    const live = document.getElementById("editor-live");
    if (live && announcements.length > 0) {
      live.textContent = `${announcements.join(". ")}.`;
    }
  }

  document.addEventListener("input", (event) => {
    if (event.target instanceof HTMLTextAreaElement && event.target.id === "editor-text") {
      refreshEditorMetrics();
    }
  });

  // A save swaps the editor region in; the textarea survives via hx-preserve, so one pass after
  // the swap keeps the panel in sync with the value the server kept.
  document.addEventListener("htmx:afterSwap", refreshEditorMetrics);

  // "Use" on a revision loads its text into the editor and re-syncs the panel, ready to save.
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const useButton = target ? target.closest("[data-use-revision]") : null;
    if (!useButton) return;
    const textNode = useButton.closest(".revision")?.querySelector(".revision-text");
    const textarea = document.getElementById("editor-text");
    if (!textNode || !textarea) return;
    textarea.value = textNode.textContent ?? "";
    refreshEditorMetrics();
    textarea.focus();
  });
})();
