# reveal-overflow

Check reveal.js slides for overflow.

## Setup

-   `git clone`
-   `npm install`
-   `npx playwright install chromium`
-   `npm link`
-   `reveal-overflow /path/to/slides.html`

## Options

```
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
```
