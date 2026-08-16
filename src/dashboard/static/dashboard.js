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
})();
