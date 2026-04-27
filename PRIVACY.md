# Privacy Policy — Smart Auto Dark Mode

_Last updated: 2026-04-26_

## Summary

**Smart Auto Dark Mode does not collect, transmit, or store any personal information.** Everything the extension needs runs entirely in your browser, and no data ever leaves your device.

## What the extension stores

The extension uses Chrome's local storage (`chrome.storage.local`) to remember three things between sessions:

| Key | What it stores | Why |
|---|---|---|
| `enabled` | `true` / `false` | Whether the extension is globally on or off. |
| `darkness` | a number from 0 to 100 | Your chosen darkness slider position. |
| `whitelist` | a list of hostnames (e.g. `github.com`) | Sites where you've turned the extension off. |

This data is stored on your computer only. It is **not** synced to any server, **not** shared with the developer, and **not** shared with any third party. Uninstalling the extension removes all of it.

## What the extension does NOT do

- ❌ No analytics, telemetry, or usage tracking
- ❌ No remote code execution
- ❌ No reading or transmitting page content
- ❌ No reading or transmitting browsing history
- ❌ No advertising or third-party SDKs
- ❌ No data sale or transfer of any kind

## Permissions and why they're needed

The extension requests:

- **`storage`** — to save your settings (the three keys above) on your device.
- **`scripting`** — to inject the dark-mode CSS into pages.
- **Host permission `<all_urls>`** — required so the extension can run on every site you visit and apply (or skip) dark mode. Without this, the extension can't function.

The extension reads only what's needed to compute background luminance (computed CSS values from `<html>`, `<body>`, and major content roots) to decide whether a page is already dark. This computation happens locally in the page's context and produces only two numbers (`bgLum`, `textLum`) which are shown in the popup and never transmitted.

## Contact

If you have questions, please open an issue at https://github.com/dongt10/smart-auto-dark-mode/issues.
