# Chrome Web Store — submission copy

Paste each section into the matching field on https://chrome.google.com/webstore/devconsole/.

---

## Item name (max 75 chars, current: 31)

```
Smart Auto Dark Mode
```

---

## Summary / short description (max 132 chars)

```
Auto-detects sites already in dark mode and skips them. Otherwise applies dark theme with a gray↔dark slider and per-site whitelist.
```

(132 chars — at the limit. If they reject for length, drop ", and per-site whitelist".)

---

## Detailed description

```
Most dark-mode extensions invert every page, including the ones that already look great in dark mode. Smart Auto Dark Mode is smarter:

1. It hints to the page that you prefer dark mode (color-scheme: dark + meta tag), so sites with their own dark theme switch on their own — exactly the way the site's designers intended.

2. If the site doesn't have a dark theme, it samples the rendered background and text luminance and decides if the page is already dark. If yes, it stays out of the way.

3. Only when the page is still light does it apply generated dark CSS for surfaces, text, borders, and controls while leaving images and video in their natural colors.

THE DARKNESS SLIDER
A single slider tunes the generated palette from soft charcoal to near-black. It changes real CSS colors instead of flipping the page, so text stays bright and images stay legible across the whole range.

WHITELIST WITH SUBDOMAIN MATCHING
Disable the extension on any site with one click. Adding github.com also covers gist.github.com, but suffix attacks like github.com.evil.com are correctly rejected.

LIVE READOUTS
The popup shows the live luminance values the detector measured (bg lum, text lum) so you can tell at a glance whether a misfire is the detector's fault or the site doing something unusual.

PRIVACY
No analytics. No telemetry. No remote code. The extension stores four settings in your browser's local storage (on/off toggle, slider value, whitelist, and per-site renderer mode) and never transmits anything anywhere. Open source — see the code at github.com/dongt10/smart-auto-dark-mode.

PERMISSIONS
- storage: to remember your settings.
- host permission <all_urls>: required so it can run on every site you visit. Without this, a dark-mode extension can't function.
```

---

## Category

```
Accessibility
```

(Alternative: "Productivity". Accessibility tends to fit dark-mode tools better and gets less competition.)

---

## Language

```
English
```

---

## Single purpose

```
Detect whether a website is already in dark mode and apply a dark theme to it if it isn't.
```

---

## Permission justifications

### `storage` permission
```
Used to persist four user settings on the local device: a global on/off toggle, the user's chosen darkness slider value (0–100), a list of hostnames the user has whitelisted to skip, and per-site renderer mode choices. No data leaves the device.
```

### Host permission `<all_urls>`
```
The extension's core function is to detect and apply dark mode on any website the user visits. Without permission to run on all URLs, a dark-mode extension can't function. The content script reads only computed CSS values (background-color, color) of <html>, <body>, and a small fixed list of content-root selectors, then optionally injects a <style> element. No page content is read or transmitted.
```

### Remote code use
```
No
```

(The extension contains no remote code. All scripts are bundled in the package.)

---

## Privacy practices — data handling

When asked which categories of user data are collected, **leave them all unchecked**. The extension does not collect:

- ❌ Personally identifiable information
- ❌ Health information
- ❌ Financial and payment information
- ❌ Authentication information
- ❌ Personal communications
- ❌ Location
- ❌ Web history
- ❌ User activity
- ❌ Website content

Then check the three required certifications:

- ✅ I do not sell or transfer user data to third parties, outside of the approved use cases.
- ✅ I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- ✅ I do not use or transfer user data to determine creditworthiness or for lending purposes.

---

## Privacy policy URL

```
https://dongt10.github.io/smart-auto-dark-mode/privacy.html
```

(Goes live once GitHub Pages finishes building — ~1 minute after the push.)

---

## Homepage URL (optional)

```
https://github.com/dongt10/smart-auto-dark-mode
```

---

## Support URL (optional)

```
https://github.com/dongt10/smart-auto-dark-mode/issues
```

---

## Screenshots

Upload all three from `store-assets/`:

1. `01-before-after.png` — primary (will be the first screenshot users see)
2. `02-slider-range.png`
3. `03-popup.png`

Recommended order: 01 → 03 → 02 (hooks with the value prop, shows the UI, then shows the customization).

---

## Distribution

- Visibility: **Public**
- Regions: **All regions** (unless you have a reason to restrict)
- Pricing: **Free**
