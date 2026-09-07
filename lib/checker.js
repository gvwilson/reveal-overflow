import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT = 30_000;

export async function checkPresentation(options) {
  const browser = await chromium.launch();

  try {
    const context = await browser.newContext({
      viewport: {
        width: options.width,
        height: options.height
      },
      deviceScaleFactor: 1
    });

    const page = await context.newPage();

    page.setDefaultTimeout(
      options.timeout ?? DEFAULT_TIMEOUT
    );

    const input = normalizeInput(options.input);

    await page.goto(input, {
      waitUntil: "load",
      timeout: options.timeout ?? DEFAULT_TIMEOUT
    });

    await waitForReveal(page, options.timeout);

    await installBrowserMeasurement(page);

    await waitForAssets(page);

    await disableAnimations(page);

    await page.evaluate(() => {
      window.Reveal.layout();
    });

    await waitForStableLayout(
      page,
      options.wait ?? 100
    );

    const browserInfo =
      await getBrowserInfo(page);

    const revealInfo =
      await getRevealInfo(page);

    const slides =
      await getSlides(page);

    const results = [];

    for (const slide of slides) {
      const result =
        await inspectSlide(
          page,
          slide,
          options
        );

      results.push(result);

      if (
        result.overflow &&
        options.screenshots
      ) {
        await saveScreenshot(
          page,
          result,
          options.screenshots
        );
      }
    }

    const overflowSlides =
      results.filter(
        slide => slide.overflow
      );

    return {
      input,

      browser: browserInfo,

      reveal: revealInfo,

      threshold: options.threshold,

      fragments: options.fragments,

      slideCount: results.length,

      overflowCount:
        overflowSlides.length,

      failed:
        overflowSlides.length > 0,

      slides: results
    };
  } finally {
    await browser.close();
  }
}

/**
 * Convert a local path into a file:// URL.
 * Leave HTTP(S) and file URLs untouched.
 */
function normalizeInput(input) {
  if (
    input.startsWith("http://") ||
    input.startsWith("https://") ||
    input.startsWith("file://")
  ) {
    return input;
  }

  return pathToFileURL(
    path.resolve(input)
  ).href;
}

/**
 * Wait for reveal.js itself to be available and ready.
 */
async function waitForReveal(
  page,
  timeout
) {
  const effectiveTimeout =
    timeout ?? DEFAULT_TIMEOUT;

  await page.waitForFunction(
    () => {
      return (
        window.Reveal &&
        typeof window.Reveal.getSlides ===
          "function"
      );
    },
    null,
    {
      timeout: effectiveTimeout
    }
  );

  await page.waitForFunction(
    () => {
      return (
        window.Reveal.isReady?.() === true ||
        document.querySelector(
          ".reveal.ready"
        ) !== null
      );
    },
    null,
    {
      timeout: effectiveTimeout
    }
  );
}

/**
 * Install all measurement code in the browser context.
 *
 * Nothing inside __revealOverflowMeasure relies on Node.js
 * functions.
 */
async function installBrowserMeasurement(page) {
  await page.evaluate(() => {
    window.__revealOverflowMeasure =
      function (
        slide,
        threshold,
        mode = "normal"
      ) {
        /*
         * IMPORTANT:
         *
         * Use reveal.js's native slide size instead of the
         * transformed browser rectangle as our coordinate system.
         */
        const computed =
          window.Reveal.getComputedSlideSize();

        const slideWidth =
          Number(computed.width);

        const slideHeight =
          Number(computed.height);

        if (
          !Number.isFinite(slideWidth) ||
          !Number.isFinite(slideHeight) ||
          slideWidth <= 0 ||
          slideHeight <= 0
        ) {
          throw new Error(
            `Invalid reveal.js slide size: ` +
            `${computed.width} × ${computed.height}`
          );
        }

        const slideRect =
          slide.getBoundingClientRect();

        /*
         * Reveal.js scales the native slide to fit the
         * browser viewport.
         *
         * Convert browser coordinates back into native
         * reveal slide coordinates.
         */
        const scaleX =
          slideRect.width /
          slideWidth;

        const scaleY =
          slideRect.height /
          slideHeight;

        if (
          !Number.isFinite(scaleX) ||
          !Number.isFinite(scaleY) ||
          scaleX <= 0 ||
          scaleY <= 0
        ) {
          throw new Error(
            `Invalid reveal.js scale: ` +
            `${scaleX} × ${scaleY}`
          );
        }

        function round(value) {
          return Math.round(
            value * 10
          ) / 10;
        }

        function elementText(el) {
          const text =
            el.textContent
              ?.replace(/\s+/g, " ")
              .trim();

          if (!text) {
            return "";
          }

          return text.length > 120
            ? `${text.slice(0, 117)}...`
            : text;
        }

        function describeElement(el) {
          const tag =
            el.tagName.toLowerCase();

          if (el.id) {
            return (
              `${tag}#` +
              CSS.escape(el.id)
            );
          }

          const classes = [
            ...el.classList
          ]
            .filter(Boolean)
            .slice(0, 3)
            .map(
              c =>
                `.${CSS.escape(c)}`
            )
            .join("");

          let selector =
            `${tag}${classes}`;

          if (el.parentElement) {
            const siblings = [
              ...el.parentElement
                .children
            ];

            const index =
              siblings.indexOf(el) + 1;

            selector +=
              `:nth-child(${index})`;
          }

          return selector;
        }

        function isMeasurableElement(el) {
          if (
            !(el instanceof HTMLElement) &&
            !(el instanceof SVGElement)
          ) {
            return false;
          }

          /*
           * Do not measure reveal.js infrastructure.
           */
          if (
            el.matches(
              [
                ".backgrounds",
                ".background",
                ".speaker-notes",
                ".progress",
                ".controls"
              ].join(", ")
            )
          ) {
            return false;
          }

          const style =
            window.getComputedStyle(el);

          if (
            style.display === "none" ||
            style.visibility === "hidden"
          ) {
            return false;
          }

          /*
           * Elements inside hidden ancestors are also ignored.
           */
          if (
            el.closest(
              ".backgrounds, .speaker-notes"
            )
          ) {
            return false;
          }

          const rect =
            el.getBoundingClientRect();

          return (
            rect.width > 0 ||
            rect.height > 0
          );
        }

        /*
         * Convert an element's browser-space rectangle into
         * reveal's native slide coordinates.
         */
        function toSlideRect(el) {
          const rect =
            el.getBoundingClientRect();

          return {
            left:
              (
                rect.left -
                slideRect.left
              ) / scaleX,

            right:
              (
                rect.right -
                slideRect.left
              ) / scaleX,

            top:
              (
                rect.top -
                slideRect.top
              ) / scaleY,

            bottom:
              (
                rect.bottom -
                slideRect.top
              ) / scaleY,

            width:
              rect.width / scaleX,

            height:
              rect.height / scaleY
          };
        }

        let leftOverflow = 0;
        let rightOverflow = 0;
        let topOverflow = 0;
        let bottomOverflow = 0;

        const elements = [];

        /*
         * Check every rendered descendant.
         */
        for (
          const el of slide.querySelectorAll("*")
        ) {
          if (
            !isMeasurableElement(el)
          ) {
            continue;
          }

          const rect =
            toSlideRect(el);

          const left =
            Math.max(
              0,
              -rect.left
            );

          const right =
            Math.max(
              0,
              rect.right -
                slideWidth
            );

          const top =
            Math.max(
              0,
              -rect.top
            );

          const bottom =
            Math.max(
              0,
              rect.bottom -
                slideHeight
            );

          leftOverflow =
            Math.max(
              leftOverflow,
              left
            );

          rightOverflow =
            Math.max(
              rightOverflow,
              right
            );

          topOverflow =
            Math.max(
              topOverflow,
              top
            );

          bottomOverflow =
            Math.max(
              bottomOverflow,
              bottom
            );

          const horizontal =
            Math.max(
              left,
              right
            );

          const vertical =
            Math.max(
              top,
              bottom
            );

          if (
            horizontal > threshold ||
            vertical > threshold
          ) {
            elements.push({
              selector:
                describeElement(el),

              tag:
                el.tagName.toLowerCase(),

              id:
                el.id || null,

              className:
                typeof el.className ===
                  "string"
                  ? el.className
                  : null,

              text:
                elementText(el),

              left:
                round(rect.left),

              top:
                round(rect.top),

              width:
                round(rect.width),

              height:
                round(rect.height),

              horizontalOverflow:
                round(horizontal),

              verticalOverflow:
                round(vertical),

              mode
            });
          }
        }

        /*
         * scrollWidth / scrollHeight are also expressed in
         * the element's CSS coordinate system.
         *
         * Convert them into the same native slide coordinate
         * system.
         */
        const scrollWidth =
          slide.scrollWidth;

        const scrollHeight =
          slide.scrollHeight;

        const scrollWidthOverflow =
          Math.max(
            0,
            scrollWidth -
              slideWidth
          );

        const scrollHeightOverflow =
          Math.max(
            0,
            scrollHeight -
              slideHeight
          );

        const horizontalOverflow =
          Math.max(
            leftOverflow,
            rightOverflow,
            scrollWidthOverflow
          );

        const verticalOverflow =
          Math.max(
            topOverflow,
            bottomOverflow,
            scrollHeightOverflow
          );

        /*
         * Sort worst offenders first.
         */
        elements.sort(
          (a, b) => {
            const aMax =
              Math.max(
                a.horizontalOverflow,
                a.verticalOverflow
              );

            const bMax =
              Math.max(
                b.horizontalOverflow,
                b.verticalOverflow
              );

            return bMax - aMax;
          }
        );

        return {
          overflow:
            horizontalOverflow >
              threshold ||
            verticalOverflow >
              threshold,

          horizontalOverflow:
            round(
              horizontalOverflow
            ),

          verticalOverflow:
            round(
              verticalOverflow
            ),

          leftOverflow:
            round(leftOverflow),

          rightOverflow:
            round(rightOverflow),

          topOverflow:
            round(topOverflow),

          bottomOverflow:
            round(bottomOverflow),

          scrollWidth:
            round(scrollWidth),

          scrollHeight:
            round(scrollHeight),

          slideWidth:
            round(slideWidth),

          slideHeight:
            round(slideHeight),

          renderedWidth:
            round(
              slideRect.width
            ),

          renderedHeight:
            round(
              slideRect.height
            ),

          scaleX:
            round(scaleX),

          scaleY:
            round(scaleY),

          elements
        };
      };
  });
}

/**
 * Wait for fonts, images, and browser layout.
 */
async function waitForAssets(page) {
  await page.evaluate(async () => {
    /*
     * Fonts.
     */
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }

    /*
     * Images.
     */
    const images = [
      ...document.images
    ];

    await Promise.all(
      images.map(async image => {
        if (image.complete) {
          try {
            await image.decode?.();
          } catch {
            // Broken images can still be measured.
          }

          return;
        }

        await new Promise(resolve => {
          const done = () => resolve();

          image.addEventListener(
            "load",
            done,
            { once: true }
          );

          image.addEventListener(
            "error",
            done,
            { once: true }
          );
        });

        try {
          await image.decode?.();
        } catch {
          // Ignore decode errors.
        }
      })
    );

    /*
     * Give browser layout two frames to settle.
     */
    await new Promise(resolve => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });
  });
}

/**
 * Disable animations/transitions so measurements are deterministic.
 */
async function disableAnimations(page) {
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation: none !important;
        transition: none !important;
        caret-color: transparent !important;
      }

      .reveal .slides section {
        scroll-behavior: auto !important;
      }
    `
  });

  await page.evaluate(() => {
    if (window.Reveal?.configure) {
      window.Reveal.configure({
        transition: "none",
        backgroundTransition: "none",
        controls: false,
        progress: false,
        slideNumber: false,
        keyboard: false,
        overview: false
      });
    }
  });
}

/**
 * Get actual browser viewport information.
 */
async function getBrowserInfo(page) {
  return page.evaluate(() => ({
    innerWidth:
      window.innerWidth,

    innerHeight:
      window.innerHeight,

    clientWidth:
      document.documentElement.clientWidth,

    clientHeight:
      document.documentElement.clientHeight,

    devicePixelRatio:
      window.devicePixelRatio
  }));
}

/**
 * Get reveal.js's current presentation geometry.
 */
async function getRevealInfo(page) {
  return page.evaluate(() => {
    const size =
      window.Reveal.getComputedSlideSize();

    return {
      slideWidth:
        Number(size.width),

      slideHeight:
        Number(size.height),

      scale:
        Number(
          window.Reveal.getScale()
        ),

      indices:
        window.Reveal.getIndices()
    };
  });
}

/**
 * Return all slides known to reveal.js.
 */
async function getSlides(page) {
  return page.evaluate(() => {
    return window.Reveal
      .getSlides()
      .map((slide, index) => {
        const indices =
          window.Reveal.getIndices(
            slide
          );

        return {
          index,

          h:
            indices.h,

          v:
            indices.v ?? 0,

          f:
            indices.f ?? 0,

          id:
            slide.id || null,

          dataId:
            slide.dataset?.id || null,

          notes:
            !!slide.querySelector(
              "aside.notes"
            )
        };
      });
  });
}

/**
 * Inspect one slide.
 */
async function inspectSlide(
  page,
  slideInfo,
  options
) {
  /*
   * Navigate using reveal.js.
   */
  await page.evaluate(
    ({ h, v }) => {
      window.Reveal.slide(
        h,
        v,
        -1
      );

      window.Reveal.layout();
    },
    slideInfo
  );

  await waitForStableLayout(
    page,
    options.wait ?? 100
  );

  /*
   * Measure ordinary slide state.
   */
  const normal =
    await measureCurrentSlide(
      page,
      options.threshold
    );

  /*
   * Measure with all fragments visible.
   */
  let fragmentState = null;

  if (options.fragments) {
    fragmentState =
      await measureWithAllFragments(
        page,
        options.threshold
      );
  }

  const combined =
    combineMeasurements(
      normal,
      fragmentState
    );

  return {
    index:
      slideInfo.index,

    h:
      slideInfo.h,

    v:
      slideInfo.v,

    label:
      slideLabel(slideInfo),

    id:
      slideInfo.id,

    dataId:
      slideInfo.dataId,

    overflow:
      combined.overflow,

    horizontalOverflow:
      combined.horizontalOverflow,

    verticalOverflow:
      combined.verticalOverflow,

    leftOverflow:
      combined.leftOverflow,

    rightOverflow:
      combined.rightOverflow,

    topOverflow:
      combined.topOverflow,

    bottomOverflow:
      combined.bottomOverflow,

    slideWidth:
      combined.slideWidth,

    slideHeight:
      combined.slideHeight,

    renderedWidth:
      combined.renderedWidth,

    renderedHeight:
      combined.renderedHeight,

    scaleX:
      combined.scaleX,

    scaleY:
      combined.scaleY,

    scrollWidth:
      combined.scrollWidth,

    scrollHeight:
      combined.scrollHeight,

    elements:
      combined.elements,

    fragmentOverflow:
      fragmentState?.overflow ?? false
  };
}

/**
 * Measure the current slide.
 */
async function measureCurrentSlide(
  page,
  threshold
) {
  return page.evaluate(
    ({ threshold }) => {
      const slide =
        window.Reveal.getCurrentSlide();

      if (!slide) {
        throw new Error(
          "Reveal.js has no current slide"
        );
      }

      if (
        typeof window
          .__revealOverflowMeasure !==
        "function"
      ) {
        throw new Error(
          "Overflow measurement function was not installed"
        );
      }

      return window
        .__revealOverflowMeasure(
          slide,
          threshold,
          "normal"
        );
    },
    { threshold }
  );
}

/**
 * Measure with all fragments visible.
 */
async function measureWithAllFragments(
  page,
  threshold
) {
  return page.evaluate(
    async ({ threshold }) => {
      const slide =
        window.Reveal.getCurrentSlide();

      if (!slide) {
        return null;
      }

      const fragments = [
        ...slide.querySelectorAll(
          ".fragment"
        )
      ];

      if (fragments.length === 0) {
        return {
          overflow: false,

          horizontalOverflow: 0,

          verticalOverflow: 0,

          leftOverflow: 0,

          rightOverflow: 0,

          topOverflow: 0,

          bottomOverflow: 0,

          slideWidth:
            window.Reveal
              .getComputedSlideSize()
              .width,

          slideHeight:
            window.Reveal
              .getComputedSlideSize()
              .height,

          renderedWidth:
            slide.getBoundingClientRect()
              .width,

          renderedHeight:
            slide.getBoundingClientRect()
              .height,

          scaleX:
            window.Reveal.getScale(),

          scaleY:
            window.Reveal.getScale(),

          scrollWidth:
            slide.scrollWidth,

          scrollHeight:
            slide.scrollHeight,

          elements: []
        };
      }

      /*
       * Save exact fragment state.
       */
      const original =
        fragments.map(el => ({
          className:
            el.className,

          style:
            el.getAttribute("style")
        }));

      /*
       * Force every fragment visible.
       */
      for (const el of fragments) {
        el.classList.remove(
          "visible",
          "current-fragment"
        );

        el.classList.add(
          "visible"
        );

        el.style.setProperty(
          "visibility",
          "visible",
          "important"
        );

        el.style.setProperty(
          "opacity",
          "1",
          "important"
        );
      }

      /*
       * Allow layout to settle.
       */
      await new Promise(resolve => {
        requestAnimationFrame(() => {
          requestAnimationFrame(resolve);
        });
      });

      let measurement;

      try {
        measurement =
          window
            .__revealOverflowMeasure(
              slide,
              threshold,
              "fragment"
            );
      } finally {
        /*
         * Always restore original state, even if measurement
         * throws.
         */
        fragments.forEach(
          (el, index) => {
            el.className =
              original[index]
                .className;

            if (
              original[index].style ===
              null
            ) {
              el.removeAttribute(
                "style"
              );
            } else {
              el.setAttribute(
                "style",
                original[index].style
              );
            }
          }
        );
      }

      return measurement;
    },
    { threshold }
  );
}

/**
 * Wait for reveal.js to perform layout and for browser rendering
 * to settle.
 */
async function waitForStableLayout(
  page,
  wait
) {
  await page.evaluate(() => {
    window.Reveal.layout();
  });

  await page.evaluate(() => {
    return new Promise(resolve => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });
  });

  if (wait > 0) {
    await sleep(wait);
  }
}

/**
 * Combine normal and fragment measurements.
 */
function combineMeasurements(
  normal,
  fragments
) {
  if (!fragments) {
    return normal;
  }

  return {
    overflow:
      normal.overflow ||
      fragments.overflow,

    horizontalOverflow:
      Math.max(
        normal.horizontalOverflow,
        fragments.horizontalOverflow
      ),

    verticalOverflow:
      Math.max(
        normal.verticalOverflow,
        fragments.verticalOverflow
      ),

    leftOverflow:
      Math.max(
        normal.leftOverflow,
        fragments.leftOverflow
      ),

    rightOverflow:
      Math.max(
        normal.rightOverflow,
        fragments.rightOverflow
      ),

    topOverflow:
      Math.max(
        normal.topOverflow,
        fragments.topOverflow
      ),

    bottomOverflow:
      Math.max(
        normal.bottomOverflow,
        fragments.bottomOverflow
      ),

    slideWidth:
      normal.slideWidth,

    slideHeight:
      normal.slideHeight,

    renderedWidth:
      normal.renderedWidth,

    renderedHeight:
      normal.renderedHeight,

    scaleX:
      normal.scaleX,

    scaleY:
      normal.scaleY,

    scrollWidth:
      Math.max(
        normal.scrollWidth,
        fragments.scrollWidth
      ),

    scrollHeight:
      Math.max(
        normal.scrollHeight,
        fragments.scrollHeight
      ),

    elements:
      dedupeElements([
        ...normal.elements,
        ...fragments.elements
      ])
  };
}

/**
 * Remove duplicate element reports.
 */
function dedupeElements(elements) {
  const seen = new Set();

  return elements.filter(element => {
    const key = [
      element.selector,
      element.horizontalOverflow,
      element.verticalOverflow,
      element.mode
    ].join("|");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

/**
 * Save a screenshot of an overflowing slide.
 */
async function saveScreenshot(
  page,
  result,
  directory
) {
  await fs.mkdir(
    directory,
    {
      recursive: true
    }
  );

  const filename =
    `slide-${String(result.h).padStart(3, "0")}` +
    `-${String(result.v).padStart(3, "0")}.png`;

  await page.screenshot({
    path:
      path.join(
        directory,
        filename
      )
  });
}

/**
 * Human-readable slide number.
 */
function slideLabel(slide) {
  if (slide.v > 0) {
    return `${slide.h + 1}.${slide.v}`;
  }

  return `${slide.h + 1}`;
}

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}
