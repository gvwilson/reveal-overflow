#!/usr/bin/env node

import { checkPresentation } from "../lib/checker.js";

function usage() {
  console.log(`
reveal-overflow - detect overflowing content in reveal.js presentations

Usage:
  reveal-overflow <presentation.html> [options]
  reveal-overflow <url> [options]

Options:
  --threshold <px>       Allowed overflow in pixels (default: 1)
  --width <px>           Browser viewport width (default: 1280)
  --height <px>          Browser viewport height (default: 720)
  --timeout <ms>         Page/load timeout (default: 30000)
  --wait <ms>            Additional layout wait (default: 100)
  --fragments            Check with all fragments visible (default)
  --no-fragments         Do not check fragments
  --screenshots <dir>    Save screenshots of overflowing slides
  --json                 Output JSON
  --quiet                Only output failures
  --fail                 Exit 1 if overflow is found
  --help                 Show this help

Examples:

  reveal-overflow docs/intro/slides.html

  reveal-overflow docs/intro/slides.html --fail

  reveal-overflow docs/intro/slides.html \\
    --width 1536 \\
    --height 864 \\
    --threshold 2

  reveal-overflow docs/intro/slides.html \\
    --screenshots ./overflow

  reveal-overflow docs/intro/slides.html --json
`);
}

function parseArgs(argv) {
  const options = {
    input: null,

    threshold: 1,

    width: 1280,

    height: 720,

    timeout: 30_000,

    wait: 100,

    fragments: true,

    screenshots: null,

    json: false,

    quiet: false,

    fail: false
  };

  const valueOptions = new Set([
    "--threshold",
    "--width",
    "--height",
    "--timeout",
    "--wait",
    "--screenshots"
  ]);

  for (
    let i = 0;
    i < argv.length;
    i++
  ) {
    const arg = argv[i];

    if (
      arg === "--help" ||
      arg === "-h"
    ) {
      usage();
      process.exit(0);
    }

    if (arg === "--fragments") {
      options.fragments = true;
      continue;
    }

    if (
      arg === "--no-fragments"
    ) {
      options.fragments = false;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (
      arg === "--quiet" ||
      arg === "-q"
    ) {
      options.quiet = true;
      continue;
    }

    if (arg === "--fail") {
      options.fail = true;
      continue;
    }

    if (valueOptions.has(arg)) {
      const value =
        argv[++i];

      if (value === undefined) {
        throw new Error(
          `${arg} requires a value`
        );
      }

      if (
        arg === "--screenshots"
      ) {
        options.screenshots =
          value;

        continue;
      }

      const number =
        Number(value);

      if (
        !Number.isFinite(number) ||
        number < 0
      ) {
        throw new Error(
          `Invalid value for ${arg}: ${value}`
        );
      }

      const key = {
        "--threshold":
          "threshold",

        "--width":
          "width",

        "--height":
          "height",

        "--timeout":
          "timeout",

        "--wait":
          "wait"
      }[arg];

      options[key] =
        number;

      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(
        `Unknown option: ${arg}`
      );
    }

    if (options.input !== null) {
      throw new Error(
        `Unexpected argument: ${arg}`
      );
    }

    options.input = arg;
  }

  if (!options.input) {
    usage();
    process.exit(2);
  }

  return options;
}

function formatPx(value) {
  return `${Number(value).toFixed(1)}px`;
}

function printHuman(
  result,
  options
) {
  if (!options.quiet) {
    console.log("");
    console.log(
      "Reveal.js overflow check"
    );

    console.log(
      `Browser viewport: ` +
      `${result.browser.innerWidth} × ` +
      `${result.browser.innerHeight}px`
    );

    console.log(
      `Reveal slide:     ` +
      `${result.reveal.slideWidth} × ` +
      `${result.reveal.slideHeight}px`
    );

    console.log(
      `Reveal scale:     ` +
      `${Number(result.reveal.scale).toFixed(4)}`
    );

    console.log(
      `Threshold:        ` +
      `${options.threshold}px`
    );

    console.log("");
  }

  for (
    const slide of result.slides
  ) {
    if (!slide.overflow) {
      if (!options.quiet) {
        console.log(
          `✓ Slide ${slide.label}`
        );
      }

      continue;
    }

    const directions = [];

    if (
      slide.leftOverflow >
      options.threshold
    ) {
      directions.push(
        `left ${formatPx(
          slide.leftOverflow
        )}`
      );
    }

    if (
      slide.rightOverflow >
      options.threshold
    ) {
      directions.push(
        `right ${formatPx(
          slide.rightOverflow
        )}`
      );
    }

    if (
      slide.topOverflow >
      options.threshold
    ) {
      directions.push(
        `top ${formatPx(
          slide.topOverflow
        )}`
      );
    }

    if (
      slide.bottomOverflow >
      options.threshold
    ) {
      directions.push(
        `bottom ${formatPx(
          slide.bottomOverflow
        )}`
      );
    }

    console.log(
      `✗ Slide ${slide.label} — ` +
      directions.join(", ")
    );

    for (
      const element of slide.elements.slice(
        0,
        10
      )
    ) {
      const amount =
        Math.max(
          element.horizontalOverflow,
          element.verticalOverflow
        );

      console.log(
        `    ${element.selector}` +
        ` — ${formatPx(amount)}`
      );

      if (element.text) {
        console.log(
          `      "${element.text}"`
        );
      }
    }

    if (
      slide.elements.length > 10
    ) {
      console.log(
        `    … and ` +
        `${slide.elements.length - 10}` +
        ` more`
      );
    }
  }

  if (!options.quiet) {
    console.log("");

    if (result.failed) {
      console.log(
        `Found ${result.overflowCount} ` +
        `overflowing slide` +
        `${
          result.overflowCount === 1
            ? ""
            : "s"
        }.`
      );
    } else {
      console.log(
        "✓ No overflowing slides."
      );
    }
  }
}

async function main() {
  let options;

  try {
    options =
      parseArgs(
        process.argv.slice(2)
      );
  } catch (error) {
    console.error(
      `reveal-overflow: ${error.message}`
    );

    process.exit(2);
  }

  try {
    const result =
      await checkPresentation(
        options
      );

    if (options.json) {
      console.log(
        JSON.stringify(
          result,
          null,
          2
        )
      );
    } else {
      printHuman(
        result,
        options
      );
    }

    if (
      options.fail &&
      result.failed
    ) {
      process.exit(1);
    }

    process.exit(0);
  } catch (error) {
    if (options.json) {
      console.error(
        JSON.stringify(
          {
            error:
              error.message
          },
          null,
          2
        )
      );
    } else {
      console.error(
        `reveal-overflow: ` +
        `${error.message}`
      );
    }

    process.exit(2);
  }
}

main();
