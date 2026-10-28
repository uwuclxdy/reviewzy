// reviewzy dashboard behaviors. Loads as a module after htmx.min.js.
// The sidebar's rail and drawer, the selects, the tabs, the theme toggle, the toasts and the
// table header label boxes come from ui.js; initTables is re-run after every htmx swap so a
// freshly rendered table head gets its boxes and its selection state machine, and initDismiss
// re-wires a banner the swap replaced out of band.
import { initDismiss, initTables, initViewportWidth, showToast } from "./ui.js";

(() => {
  "use strict";

  // The shell is a sidebar shell, so the full-bleed sticky bar measures the page column, not the
  // viewport: --vp-w on the column keeps the stuck bar inside the capped page beside the sidebar.
  initViewportWidth(document.querySelector("main.page") ?? undefined);

  // --- Error toasts ---
  // A failed htmx round (HTTP error or network error) raises a transient toast carrying the
  // failure and a Retry button. The toast dies on its own timer; the durable way out is the
  // control the failed request came from, which the failure never removes: the filters form
  // re-renders the list, and the style guide form keeps the typed values.
  function wireRetry(toast, retry) {
    const body = toast.querySelector(".toast-body");
    if (!body) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-secondary btn-sm";
    button.textContent = "Retry";
    button.addEventListener("click", retry);
    body.appendChild(button);
  }

  function raiseErrorToast(title, message, retry) {
    const toast = showToast("danger", title, message);
    if (toast) wireRetry(toast, retry);
  }

  // htmx listens for submit directly on the form it processed, so a native requestSubmit
  // reaches it; the reload fallback covers the case where htmx did not load.
  function submitForm(form) {
    if (form && typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else {
      window.location.reload();
    }
  }

  const filtersForm = document.getElementById("filters");
  if (filtersForm) {
    const retryFilters = () => submitForm(document.getElementById("filters"));
    const raiseFilterError = () => raiseErrorToast("The list could not be loaded", "The filter request failed. Try it again.", retryFilters);
    filtersForm.addEventListener("htmx:responseError", raiseFilterError);
    filtersForm.addEventListener("htmx:sendError", raiseFilterError);
  }

  // Delegated on document: a successful swap replaces the style guide form, so listeners bound
  // to it would die. The event target names the form the failure came from.
  document.addEventListener("htmx:responseError", (event) => {
    if (!(event.target instanceof Element) || event.target.id !== "style-guide-form") return;
    raiseErrorToast("The guide could not be saved", "The save request failed. Try it again.", () => submitForm(document.getElementById("style-guide-form")));
  });
  document.addEventListener("htmx:sendError", (event) => {
    if (!(event.target instanceof Element) || event.target.id !== "style-guide-form") return;
    raiseErrorToast("The guide could not be saved", "The save request failed. Try it again.", () => submitForm(document.getElementById("style-guide-form")));
  });

  // --- Filter auto-submit ---
  // Changing a select or typing in the search fires the filter request itself. requestSubmit()
  // reaches htmx's submit listener on the form; the debounce collapses a burst of keystrokes
  // into one request. Only the change and input events below trigger a submit, and both fire on
  // user action alone, so a programmatic value reset (which sets .value directly and emits no
  // event) never re-fires.
  function submitFilters() {
    submitForm(document.getElementById("filters"));
  }

  let searchTimer;
  function scheduleSearchSubmit() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(submitFilters, 300);
  }

  // The hidden inputs ship disabled so a no-JS submit reads the noscript native selects instead
  // of a stale hidden value; with the widgets live they carry the picked value.
  for (const field of document.querySelectorAll('#filters input[data-filter-field]')) {
    field.disabled = false;
  }

  // ui.js's select controller commits the picked option onto the root before the change event;
  // the option's own data-value holds what the form submits.
  for (const root of document.querySelectorAll('#filters .select[data-filter]')) {
    root.addEventListener("change", () => {
      const field = root.dataset.filter ?? "";
      const picked = root.querySelector('.menu-item[aria-selected="true"]');
      const hidden = document.querySelector(`#filters input[data-filter-field="${field}"]`);
      if (hidden && picked) {
        hidden.value = picked.getAttribute("data-value") ?? "";
        submitFilters();
      }
    });
  }

  if (filtersForm) {
    const searchInput = document.getElementById("q");
    searchInput?.addEventListener("input", scheduleSearchSubmit);
  }

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
    const textNode = useButton.closest(".timeline-item")?.querySelector(".timeline-body");
    const textarea = document.getElementById("editor-text");
    if (!textNode || !textarea) return;
    textarea.value = textNode.textContent ?? "";
    refreshEditorMetrics();
    textarea.focus();
  });

  // --- Batch selection count ---
  // The boxes and the select-all state machine belong to ui.js's initTables (re-run after every
  // swap); this page only renders the count onto the approve button. All of it is progressive
  // enhancement — without JS the approve button keeps its static label, stays enabled, and the
  // native form still submits the checked rows.
  function updateApproveButton() {
    const button = document.querySelector('#batch-form .batch-bar button[type="submit"]');
    if (!button) return;
    const count = document.querySelectorAll('#batch-form input[type="checkbox"][name="id"]:checked').length;
    button.textContent = count === 0 ? "Approve selected" : `Approve ${count}`;
    button.disabled = count === 0;
  }

  document.addEventListener("table:selection", updateApproveButton);
  document.addEventListener("htmx:afterSwap", updateApproveButton);

  document.addEventListener("htmx:afterSwap", initTables);
  // The list fragment replaces the page banner out of band; a banner the swap brought in needs
  // its dismiss control wired, since ui.js's one sweep ran at boot.
  document.addEventListener("htmx:afterSwap", initDismiss);
})();
