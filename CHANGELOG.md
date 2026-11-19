# Changelog

## 0.4.2

- Fixed: a single image whose name contains `[ ]`, `{ }`, `*` or `?` (e.g. `plot[1].png`) was not refreshed when the file changed.
- Fixed: closing the list while it was still loading, or while the "+ Add" dialog was open, raised a "Webview is disposed" error.
- README: the "no limit" note meant images per row; up to 5000 images are loaded at a time.

## 0.4.1

- README: added Marketplace badges and a section on how this extension differs from other image extensions. No code changes.

## 0.4.0

- English UI. The extension follows VS Code's display language (English or Japanese).
- Published on the Visual Studio Marketplace (publisher `fatcorn753`).
- Added an icon.

## 0.3.0

- Opening an image adds it to the list even when no list is open (setting `imageListView.clickToAdd`).
- Drag & drop from the Explorer. Shift + drop adds a whole folder.

## 0.2.0

- Click to add, "+ Add", remove with ×, and restore removed images.

## 0.1.0

- First version: show images side by side, vertically or horizontally, with sorting and filtering.
