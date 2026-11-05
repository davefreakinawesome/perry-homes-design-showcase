import * as pdfjsLib from "./vendor/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "./vendor/pdf.worker.min.mjs",
  import.meta.url
).href;

const PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const config = window.PERRY_FLIPBOOK_CONFIG || {};
const overrides = window.PERRY_FLIPBOOK_OVERRIDES?.[config.slug];
if (overrides?.pdfUrl) {
  config.pdfUrl = overrides.pdfUrl;
}

const spreadMaxWidthVw = config.spreadMaxWidthVw ?? 70;
const standaloneCoverWidthVw = config.standaloneCoverWidthVw ?? 50;
const renderPixelRatio = Math.min(config.renderPixelRatio ?? 2, 2.5);
const prefetchPages = config.prefetchPages ?? 4;
const standaloneCover = config.standaloneCover ?? true;
const standaloneBackCover = config.standaloneBackCover ?? true;
const coverPage = config.coverPage ?? 1;
const configBackCoverPage = config.backCoverPage ?? null;
const lastPage = config.lastPage ?? null;

const loadingEl = document.getElementById("loading");
const loadingTextEl = document.getElementById("loading-text");
const loadingBarEl = document.getElementById("loading-bar");
const bookEl = document.getElementById("book");
const bookWrapEl = document.getElementById("book-wrap");
const coverPanelEl = document.getElementById("cover-panel");
const coverOpenEl = document.getElementById("cover-open");
const coverImageEl = document.getElementById("cover-image");
const backCoverPanelEl = document.getElementById("back-cover-panel");
const backCoverImageEl = document.getElementById("back-cover-image");
const prevBtn = document.getElementById("prev-page");
const nextBtn = document.getElementById("next-page");
const pageLabelEl = document.getElementById("page-label");

let pageFlip = null;
let renderChain = Promise.resolve();
let view = "loading";
let flipbookReady = false;
let backCoverRendered = false;

const state = {
  pdf: null,
  totalPdfPages: 0,
  backCoverPage: null,
  interiorStart: coverPage + 1,
  interiorEnd: 0,
  images: [],
  layout: null,
  standaloneCoverLayout: null,
  renderScale: 1,
  standaloneRenderScale: 1,
  loading: new Set(),
  loaded: new Set(),
};

function setProgress(done, total, message) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  loadingBarEl.style.width = `${pct}%`;
  loadingTextEl.textContent = message;
}

function showError(message) {
  loadingEl.hidden = false;
  loadingTextEl.innerHTML = `<span class="viewer-loading__error">${message}</span>`;
  loadingBarEl.parentElement.hidden = true;
}

function computeLayout(pageWidthPt, pageHeightPt) {
  const topbarHeight = 52;
  const padding = 32;
  const maxHeight = window.innerHeight - topbarHeight - padding;
  const spreadWidth = Math.min(
    window.innerWidth * (spreadMaxWidthVw / 100),
    window.innerWidth - padding
  );
  const ratio = pageHeightPt / pageWidthPt;

  let pageWidth = Math.min(spreadWidth / 2, 900);
  let pageHeight = pageWidth * ratio;

  if (pageHeight > maxHeight) {
    pageHeight = maxHeight;
    pageWidth = pageHeight / ratio;
  }

  return {
    pageWidth,
    pageHeight,
    spreadWidth: pageWidth * 2,
  };
}

function computeStandaloneCoverLayout(pageWidthPt, pageHeightPt) {
  const topbarHeight = 52;
  const padding = 32;
  const openHintHeight = 42;
  const maxHeight = window.innerHeight - topbarHeight - padding - openHintHeight;
  const ratio = pageHeightPt / pageWidthPt;

  let width = Math.min(
    window.innerWidth * (standaloneCoverWidthVw / 100),
    window.innerWidth - padding
  );
  let height = width * ratio;

  if (height > maxHeight) {
    height = maxHeight;
    width = height / ratio;
  }

  return { width, height };
}

function computeRenderScale(pageWidthPt, layout) {
  return (layout.pageWidth / pageWidthPt) * renderPixelRatio;
}

function applyStandalonePanelSize() {
  if (!state.standaloneCoverLayout) return;

  const width = `${state.standaloneCoverLayout.width}px`;
  if (coverPanelEl) coverPanelEl.style.width = width;
  if (backCoverPanelEl) backCoverPanelEl.style.width = width;
}

function applyBookWrapSize() {
  if (!bookWrapEl || !state.layout) return;
  bookWrapEl.style.width = `${Math.round(state.layout.spreadWidth)}px`;
  bookWrapEl.style.height = `${Math.round(state.layout.pageHeight)}px`;
}

function pdfToInteriorIndex(pdfPage) {
  return pdfPage - state.interiorStart;
}

function isInteriorPdfPage(pdfPage) {
  return pdfPage >= state.interiorStart && pdfPage <= state.interiorEnd;
}

async function renderPdfPage(pdfPage, scale = state.renderScale) {
  const page = await state.pdf.getPage(pdfPage);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);

  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;

  return canvas.toDataURL("image/jpeg", 0.92);
}

function updatePageLabel() {
  if (!pageLabelEl) return;

  if (view === "cover") {
    pageLabelEl.textContent = `${coverPage} / ${state.totalPdfPages}`;
    return;
  }

  if (view === "back") {
    pageLabelEl.textContent = `${state.backCoverPage} / ${state.totalPdfPages}`;
    return;
  }

  if (!pageFlip) return;

  const flipIndex = pageFlip.getCurrentPageIndex();
  const leftPdfPage = state.interiorStart + flipIndex;
  pageLabelEl.textContent = `${leftPdfPage} / ${state.totalPdfPages}`;
}

function setView(next) {
  view = next;

  if (coverPanelEl) {
    coverPanelEl.hidden = next !== "cover";
  }
  if (bookWrapEl) {
    bookWrapEl.hidden = next !== "interior";
  }
  if (backCoverPanelEl) {
    backCoverPanelEl.hidden = next !== "back";
  }

  updatePageLabel();
}

function isLastInteriorSpread() {
  if (!pageFlip) return false;
  return pageFlip.getCurrentPageIndex() >= state.images.length - 2;
}

function syncFlipbookImages() {
  if (!pageFlip) return;
  pageFlip.updateFromImages([...state.images]);
}

async function ensureInteriorPageRendered(pdfPage) {
  if (!isInteriorPdfPage(pdfPage)) return;

  const index = pdfToInteriorIndex(pdfPage);
  if (state.loaded.has(pdfPage)) return;
  if (state.loading.has(pdfPage)) return;

  state.loading.add(pdfPage);
  try {
    state.images[index] = await renderPdfPage(pdfPage);
    state.loaded.add(pdfPage);
    if (flipbookReady) {
      syncFlipbookImages();
    }
  } finally {
    state.loading.delete(pdfPage);
  }
}

async function ensureBackCoverRendered() {
  if (!standaloneBackCover || !state.backCoverPage || !backCoverImageEl) return;
  if (backCoverRendered) return;

  backCoverImageEl.src = await renderPdfPage(
    state.backCoverPage,
    state.standaloneRenderScale
  );
  backCoverRendered = true;
}

function pagesToPrefetch(flipPageIndex) {
  const centerPdf = state.interiorStart + flipPageIndex;
  const pages = new Set();

  for (
    let i = centerPdf;
    i <= Math.min(state.interiorEnd, centerPdf + prefetchPages);
    i++
  ) {
    pages.add(i);
  }
  for (
    let i = Math.max(state.interiorStart, centerPdf - prefetchPages);
    i < centerPdf;
    i++
  ) {
    pages.add(i);
  }

  return [...pages];
}

function queuePrefetch(flipPageIndex) {
  renderChain = renderChain.then(async () => {
    for (const pdfPage of pagesToPrefetch(flipPageIndex)) {
      await ensureInteriorPageRendered(pdfPage);
    }

    if (
      standaloneBackCover &&
      flipPageIndex >= state.images.length - 4
    ) {
      await ensureBackCoverRendered();
    }
  });
  return renderChain;
}

function initPageFlip() {
  if (flipbookReady) return;

  pageFlip = new St.PageFlip(bookEl, {
    width: state.layout.pageWidth,
    height: state.layout.pageHeight,
    size: "stretch",
    minWidth: 220,
    maxWidth: 900,
    minHeight: 300,
    maxHeight: 1400,
    showCover: false,
    usePortrait: true,
    mobileScrollSupport: true,
    drawShadow: true,
    flippingTime: 850,
    maxShadowOpacity: 0.45,
  });

  pageFlip.on("flip", (event) => {
    updatePageLabel();
    queuePrefetch(event.data);
  });
  pageFlip.on("changeState", updatePageLabel);
  pageFlip.loadFromImages(state.images);
  flipbookReady = true;

  bookEl.classList.add("is-ready");
  (
    document.getElementById("ph-flipbook-root") || document.body
  ).classList.add("flipbook-ready");

  queuePrefetch(pageFlip.getCurrentPageIndex());
}

function openInterior() {
  setView("interior");
  if (!flipbookReady) {
    initPageFlip();
  }
}

function openBackCover() {
  renderChain = renderChain.then(async () => {
    await ensureBackCoverRendered();
    setView("back");
  });
}

function closeBackCover() {
  setView("interior");
  if (pageFlip) {
    pageFlip.turnToPage(Math.max(0, state.images.length - 2));
  }
}

function bindControls() {
  coverOpenEl?.addEventListener("click", () => {
    if (view === "cover") {
      openInterior();
    }
  });

  coverPanelEl?.addEventListener("click", (event) => {
    if (view !== "cover") return;
    if (event.target === coverOpenEl || coverOpenEl?.contains(event.target)) return;
    openInterior();
  });

  prevBtn?.addEventListener("click", () => {
    if (view === "cover") return;

    if (view === "back") {
      closeBackCover();
      return;
    }

    if (pageFlip && pageFlip.getCurrentPageIndex() === 0 && standaloneCover) {
      setView("cover");
      return;
    }

    pageFlip?.flipPrev("bottom");
  });

  nextBtn?.addEventListener("click", () => {
    if (view === "cover") {
      openInterior();
      return;
    }

    if (view === "back") return;

    if (standaloneBackCover && isLastInteriorSpread()) {
      openBackCover();
      return;
    }

    pageFlip?.flipNext("bottom");
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      prevBtn?.click();
    }
    if (event.key === "ArrowRight" || event.key === "PageDown") {
      event.preventDefault();
      nextBtn?.click();
    }
  });
}

async function main() {
  if (!config.pdfUrl) {
    showError("Brochure configuration is missing a PDF URL.");
    return;
  }

  bindControls();
  setProgress(0, 100, "Opening brochure…");

  try {
    // Fetch on the page so the PDF can live next to this file on GitHub Pages
    // or Cloudflare. A CDN-hosted PDF.js worker cannot always read that file itself.
    const response = await fetch(config.pdfUrl);
    if (!response.ok) {
      throw new Error(`PDF request failed (${response.status})`);
    }
    const data = await response.arrayBuffer();
    state.pdf = await pdfjsLib.getDocument({ data }).promise;
  } catch (error) {
    showError(
      "Could not load the PDF. Check that the file is uploaded and served from the same site as this page."
    );
    console.error(error);
    return;
  }

  state.totalPdfPages = lastPage
    ? Math.min(lastPage, state.pdf.numPages)
    : state.pdf.numPages;
  state.backCoverPage =
    configBackCoverPage ??
    (standaloneBackCover ? state.totalPdfPages : null);
  state.interiorEnd =
    standaloneBackCover && state.backCoverPage
      ? state.backCoverPage - 1
      : state.totalPdfPages;
  state.interiorStart = standaloneCover ? coverPage + 1 : coverPage;

  const interiorCount = state.interiorEnd - state.interiorStart + 1;
  state.images = Array.from({ length: interiorCount }, () => PLACEHOLDER);

  const firstPage = await state.pdf.getPage(coverPage);
  const baseViewport = firstPage.getViewport({ scale: 1 });
  state.layout = computeLayout(baseViewport.width, baseViewport.height);
  state.standaloneCoverLayout = computeStandaloneCoverLayout(
    baseViewport.width,
    baseViewport.height
  );
  state.renderScale = computeRenderScale(baseViewport.width, state.layout);
  state.standaloneRenderScale =
    (state.standaloneCoverLayout.width / baseViewport.width) * renderPixelRatio;
  applyStandalonePanelSize();
  applyBookWrapSize();

  if (standaloneCover && coverImageEl) {
    setProgress(1, 3, "Loading cover…");
    coverImageEl.src = await renderPdfPage(
      coverPage,
      state.standaloneRenderScale
    );
    setView("cover");
  } else if (bookWrapEl) {
    bookWrapEl.hidden = false;
    setView("interior");
  }

  setProgress(2, 3, "Loading brochure…");
  await ensureInteriorPageRendered(state.interiorStart);
  await ensureInteriorPageRendered(state.interiorStart + 1);

  if (!standaloneCover) {
    initPageFlip();
  }

  loadingEl.hidden = true;
  updatePageLabel();

  if (standaloneCover) {
    queuePrefetch(0);
  }
}

main().catch((error) => {
  showError("Something went wrong loading this brochure.");
  console.error(error);
});
