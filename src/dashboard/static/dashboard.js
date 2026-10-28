// reviewzy dashboard behaviors. Loads as a module after htmx.min.js.
// The sidebar's rail and drawer, the selects, the tabs, the theme toggle, the toasts and the
// table header label boxes come from ui.js; initTables, initTabs and initDismiss are re-run
// after every htmx swap so a freshly rendered table head gets its boxes and its selection state
// machine, the OOB tab strip gets its ink, and a banner the swap replaced out of band gets its
// dismiss control back.
import { initDismiss, initScrollFade, initTables, initTabs, initViewportWidth, showToast } from "./ui.js";

(() => {
  "use strict";

  // The shell is a sidebar shell, so the full-bleed sticky bar measures the page column, not the
  // viewport: --vp-w on the column keeps the stuck bar inside the page beside the sidebar.
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

  // The editor's and the list's own failures (save, reject, notes, images, row and batch actions):
  // htmx swaps nothing on an error, so without a toast the click reads as ignored. Retry re-fires
  // the control that failed; the title names which surface failed.
  for (const type of ["htmx:responseError", "htmx:sendError"]) {
    document.addEventListener(type, (event) => {
      const el = event.target instanceof Element ? event.target : null;
      if (!el) return;
      // A failed live diff is a preview miss, not a failed save: leave the marks and stay quiet.
      if (el.id === "editor-text") return;
      const inEditor = el.closest("#editor-view") !== null;
      const inList = el.closest("#batch-form") !== null;
      if (!inEditor && !inList) return;
      const form = el.closest("form");
      raiseErrorToast(
        inEditor ? "The change was not saved" : "The action did not finish",
        "The request failed. Try it again.",
        () => {
          if (el instanceof HTMLButtonElement) el.click();
          else if (form) submitForm(form);
        },
      );
    });
  }

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

  // With the widget path live, the hidden status field is the only status the form sends. A submit
  // button's own name would ride along otherwise, and on a submit with no submitter (requestSubmit,
  // or a native fallback when htmx did not load) the form's default button adds `status=""` ahead
  // of the hidden value, which hono reads first. No-JS keeps the names for its native path.
  for (const button of document.querySelectorAll('#filters button[type="submit"]')) {
    button.removeAttribute("name");
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
    // Enter in the search field would submit through the first tab button (Open) and silently
    // drop the chosen status; the debounced path already carries it from the hidden field, so
    // Enter takes that path too.
    searchInput?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      // An IME confirms a composition with Enter; that key belongs to the composition.
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      clearTimeout(searchTimer);
      submitFilters();
    });
  }

  // A status tab submits the form itself: the button carries the new value, the hidden field
  // mirrors it so every other submit path (the search debounce, the project select) keeps it, and
  // the enhanced path prevents the native submit whose name would duplicate it. Without JS the
  // buttons keep their names and the native path carries the status.
  let restoreStatusTabFocus = false;
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const tab = target ? target.closest("#filters .tab") : null;
    if (!tab) return;
    event.preventDefault();
    const hidden = document.querySelector('#filters input[data-filter-field="status"]');
    if (hidden) hidden.value = tab.value;
    restoreStatusTabFocus = true;
    submitFilters();
  });

  // --- Swap focus and announcements ---
  // An htmx swap replaces the node the user acted on, so focus falls to <body>; the tab strip's
  // out-of-band replacement does the same on the page's primary control. Put focus back where
  // the keyboard user left it, and announce the outcome through a persistent live region (an
  // out-of-band banner arrives already populated, which a live region does not reliably read).
  let editorFocusAfterSwap = null;
  let listActionFocus = false;
  let listActionRowHref = null;
  document.addEventListener("htmx:beforeRequest", (event) => {
    const el = event.target instanceof Element ? event.target : null;
    if (!el) return;
    // A row action or the batch submit is replaced by the list swap; the row the user acted on
    // (or the outcome banner) is where their focus belongs afterwards.
    if (el.closest("#batch-form")) {
      listActionFocus = true;
      listActionRowHref = el.closest("tr")?.querySelector('a[href^="/entries/"]')?.getAttribute("href") ?? null;
    }
    // The live diff is the textarea's own request: it swaps the current-text card, and focus and
    // announcements stay exactly where the typist left them.
    if (el.id === "editor-text") return;
    if (!el.closest("#editor-view")) return;
    // Any real editor action aborts a pending preview, or its late response would overwrite the
    // freshly saved marks with ones computed from older text.
    if (typeof htmx !== "undefined") {
      const pending = document.getElementById("editor-text");
      if (pending) htmx.trigger(pending, "htmx:abort");
    }
    if (el.id === "editor-form") editorFocusAfterSwap = "save";
    else if (el.id === "notes-form") editorFocusAfterSwap = "notes";
    else if (el.closest("#image-upload") !== null || el.closest('form[action*="/images"]') !== null) editorFocusAfterSwap = "image";
    else editorFocusAfterSwap = "transition";
  });

  function announceListOutcome() {
    const live = document.getElementById("list-live");
    if (!live) return;
    const banner = document.querySelector("#page-banner .banner");
    const meta = document.querySelector("#list-meta .pagination-count");
    const message = [banner?.textContent?.trim(), meta?.textContent?.trim()].filter(Boolean).join(". ");
    if (message !== "" && message !== live.textContent) live.textContent = message;
  }

  function announceEditorOutcome(action) {
    const live = document.getElementById("editor-live");
    if (!live) return;
    // Only a refusal speaks to the outcome; the read-only state callout is a standing fact.
    const refusal = document.querySelector("#editor-view .callout-danger");
    if (refusal) {
      const title = refusal.querySelector(".callout-title")?.textContent?.trim();
      const body = refusal.querySelector(".callout-body")?.textContent?.trim();
      live.textContent = [title, body].filter(Boolean).join(". ");
      return;
    }
    if (action === "notes") {
      live.textContent = "Notes saved.";
      return;
    }
    if (action === "image") {
      live.textContent = "Image updated.";
      return;
    }
    const status = document.querySelector("#entry-status .tag")?.textContent?.trim();
    if (status) live.textContent = `Entry is now ${status}.`;
  }

  // Keep the current tab inside its scroller on a deep link or after an out-of-band swap.
  function revealActiveTab() {
    for (const wrap of document.querySelectorAll(".status-scroll, .style-guide-projects")) {
      const active = wrap.querySelector(".tab.active");
      if (!active) continue;
      const box = wrap.getBoundingClientRect();
      const tab = active.getBoundingClientRect();
      if (tab.left < box.left || tab.right > box.right) {
        wrap.scrollLeft += tab.left - box.left - (box.width - tab.width) / 2;
      }
    }
  }

  // The live diff re-renders the current-text card on every pause; keep the reader's place in it.
  let currentPaneScroll = 0;
  document.addEventListener("htmx:beforeSwap", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.id !== "current-text") return;
    currentPaneScroll = target.querySelector(".editor-pane")?.scrollTop ?? 0;
  });

  document.addEventListener("htmx:afterSwap", (event) => {
    // The live diff swaps only the current-text card; editor focus and announcements belong to the
    // view and region swaps, so a preview must not consume a pending round's flag.
    const swapTarget = event.target instanceof Element ? event.target : null;
    const editorSwap = swapTarget !== null && (swapTarget.id === "editor-view" || swapTarget.id === "editor-region");
    if (swapTarget?.id === "current-text") {
      sizeComparisonPanes();
      const pane = document.querySelector("#current-text .editor-pane");
      if (pane) pane.scrollTop = currentPaneScroll;
    }
    if (restoreStatusTabFocus) {
      restoreStatusTabFocus = false;
      const active = document.querySelector("#status-tabs .tab.active") ?? document.querySelector("#status-tabs .tab");
      active?.focus();
    }
    if (listActionFocus) {
      listActionFocus = false;
      const rowLink = listActionRowHref === null ? null : document.querySelector(`#entries-list a[href="${listActionRowHref}"]`);
      listActionRowHref = null;
      const banner = document.querySelector("#page-banner .banner");
      const firstLink = document.querySelector("#entries-list .entry-link");
      (rowLink ?? banner ?? firstLink)?.focus();
    }
    if (editorFocusAfterSwap !== null && editorSwap) {
      const refused = document.querySelector("#editor-view .callout-danger") !== null;
      const target =
        editorFocusAfterSwap === "save"
          ? refused
            ? // A refusal names a fix in the text the user must edit; the caret goes back there.
              document.querySelector("#editor-text")
            : document.querySelector('#editor-form button[type="submit"]')
          : editorFocusAfterSwap === "notes"
            ? document.querySelector('#notes-form button[type="submit"]')
            : editorFocusAfterSwap === "image"
              ? document.querySelector("#image-upload button")
              : document.querySelector("#editor-region");
      target?.focus();
      const action = editorFocusAfterSwap;
      editorFocusAfterSwap = null;
      announceEditorOutcome(action);
    }
    announceListOutcome();
    revealActiveTab();
  });

  // A failed round swaps nothing, so a focus flag set for it must not steer the next, unrelated
  // swap's focus.
  for (const type of ["htmx:responseError", "htmx:sendError"]) {
    document.addEventListener(type, () => {
      restoreStatusTabFocus = false;
      listActionFocus = false;
      listActionRowHref = null;
      editorFocusAfterSwap = null;
    });
  }

  // --- Textareas ---
  // Every data-autosize field grows to its content, capped at 60% of the viewport so the actions
  // below a long text never leave the screen; only a genuinely long box scrolls. The page's CSS
  // sets the resting min-height per field and the autosizer's inline height rides over it.
  function autosizeTextareas() {
    const cap = Math.round(window.innerHeight * 0.6);
    for (const textarea of document.querySelectorAll("textarea[data-autosize]")) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight + 2, cap)}px`;
      textarea.style.overflowY = textarea.scrollHeight + 2 > cap ? "auto" : "hidden";
    }
  }

  // --- Comparison panes ---
  // Both panes of the editor pair take one height: the taller of the two contents, floored so a
  // short entry still has an edit box and capped so a long one scrolls in place. The current
  // card then stretches to the proposal card's height, so neither side towers alone.
  function sizeComparisonPanes() {
    const pane = document.querySelector("#current-text .editor-pane");
    const textarea = document.getElementById("editor-text");
    const settled = document.querySelector("#editor-region .editor-pane");
    if (pane === null || (textarea === null && settled === null)) return;
    const floor = 140;
    const cap = 320;
    const natural = (el) => {
      if (!el) return 0;
      const previous = el.style.height;
      el.style.height = "auto";
      const height = el.scrollHeight;
      el.style.height = previous;
      return height;
    };
    // Measuring sets a pane's height to auto, which clamps its scroll to the top; put the
    // reader's place back after the new height lands.
    const paneScroll = pane.scrollTop;
    const textareaScroll = textarea?.scrollTop ?? 0;
    const settledScroll = settled?.scrollTop ?? 0;
    const height = Math.min(cap, Math.max(floor, natural(textarea), natural(settled), natural(pane)));
    if (textarea) textarea.style.height = `${height}px`;
    if (settled) settled.style.height = `${height}px`;
    pane.style.height = `${height}px`;
    pane.scrollTop = paneScroll;
    if (textarea) textarea.scrollTop = textareaScroll;
    if (settled) settled.scrollTop = settledScroll;
  }

  // --- Editor live metrics ---
  // The constraint row lives inside the htmx swap region now, so it re-renders with the swap;
  // between swaps the char count and the placeholder checklist track the textarea as the user
  // types. This is a convenience preview only: the server store layer owns the refusal.
  function refreshEditorMetrics() {
    const textarea = document.getElementById("editor-text");
    if (!textarea) return;
    autosizeTextareas();
    sizeComparisonPanes();
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
          // The filed token may already carry its braces; the announcement shows one pair.
          const bare = placeholder.replace(/^\{+|\}+$/g, "");
          announcements.push(`Placeholder {${bare}} ${present ? "present" : "missing"}`);
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
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    if (target.id === "editor-text") {
      refreshEditorMetrics();
    } else if (target.matches("textarea[data-autosize]")) {
      autosizeTextareas();
    }
  });

  // A save swaps the editor region in; the textarea survives via hx-preserve, so one pass after
  // the swap keeps the panel and every autosized box in sync with what the server kept.
  document.addEventListener("htmx:afterSwap", refreshEditorMetrics);
  document.addEventListener("htmx:afterSwap", autosizeTextareas);
  // The cap is a share of the current viewport, so a resize or rotation re-derives it.
  addEventListener("resize", autosizeTextareas);
  addEventListener("resize", sizeComparisonPanes);

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
  // swap); this page only renders the count onto the approve button. It ships enabled so the no-JS
  // form can fire it; the boot call below disables it at first paint and each selection event
  // re-syncs it, so an empty selection reads as dead with JS.
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
  // The OOB swap replaces the status tab strip: the fresh row needs its ink placed.
  document.addEventListener("htmx:afterSwap", initTabs);
  // A swapped list brings fresh table wraps and textareas; the cue controller skips the ones it
  // has already dressed.
  document.addEventListener("htmx:afterSwap", initScrollFade);
  // The list fragment replaces the page banner out of band; a banner the swap brought in needs
  // its dismiss control wired, since ui.js's one sweep ran at boot.
  document.addEventListener("htmx:afterSwap", initDismiss);

  // First paint: the boxes take their content's height, the editor panel syncs with the prefill,
  // and the batch button reflects the (empty) selection before the viewer touches anything.
  autosizeTextareas();
  refreshEditorMetrics();
  updateApproveButton();
  revealActiveTab();
})();
