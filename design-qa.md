# Flowloud split edge-menu and expand-icon floating player — Design QA

## Source visual truth

- Selected visual language: `C:\Users\15300\.codex\generated_images\01a026f8-c5b9-7ec3-b7f1-903fb89c7c74\exec-3e4ad747-f09c-4625-bbf2-403185dec434.png`.
- Scoped user delta: playback and locate controls above the orb; expand below; the pointer path must remain interactive; the expanded card uses a button-matched outer radius and a smaller attached-edge radius; the ambiguous single chevron is replaced by standard maximize/restore icons.
- Implementation: `extension-wxt/components/FloatingPlayer.tsx`, `extension-wxt/styles/components.css`, `extension/content/reader.js`, and `extension/content/reader.css`.

## Capture normalization

- Browser implementation viewport: 1280 × 720 CSS px.
- Implementation screenshots: 1280 × 720 px at device scale factor 1.
- Source image: 1536 × 1024 px; contact sheets normalize both artifacts to equal comparison columns.
- State: right-edge half-hidden orb, hover-revealed split shortcuts, upper shortcut pointer path, lower expand pointer path, and expanded player.

## Evidence

- Full-view comparison: `docs/audits/floating-edge-split-menu/comparison-full.png`.
- Focused shortcut comparison: `docs/audits/floating-edge-split-menu/comparison-focused.png`.
- Focused expanded-card comparison: `docs/audits/floating-edge-split-menu/comparison-card.png`.
- Default capture: `docs/audits/floating-edge-split-menu/implementation-default.png`.
- Hover capture: `docs/audits/floating-edge-split-menu/implementation-hover-split.png`.
- Upper pointer-path capture: `docs/audits/floating-edge-split-menu/implementation-hover-upper.png`.
- Expanded capture: `docs/audits/floating-edge-split-menu/implementation-expanded.png`.
- Expand-icon full comparison: `docs/audits/floating-expand-icon/comparison-full.png`.
- Expand-icon focused comparison: `docs/audits/floating-expand-icon/comparison-focused.png`.
- Maximize hover capture: `docs/audits/floating-expand-icon/implementation-maximize-hover.png`.
- Minimize expanded capture: `docs/audits/floating-expand-icon/implementation-minimize-expanded.png`.

## Findings

- No remaining P0, P1, or P2 mismatch.
- Typography: existing Flowloud font stack, weights, sizes, truncation, and line heights are unchanged; no new wrapping or hierarchy drift was introduced.
- Spacing and layout: 40px orb, 44px hit target, 32px shortcuts, and 8px rhythm are preserved. Playback and locate now sit above; expand sits below. Transparent 8px padding bridges keep both pointer paths continuous.
- Colors and tokens: the neutral white/blue treatment and state colors remain mapped to existing tokens.
- Image and icon quality: the unclear chevron was replaced by Lucide `Maximize2` and `Minimize2`; exact library icons are used in React and packaged as SVG assets for the real extension. No placeholder, emoji, raster scaling, or handcrafted replacement asset was introduced.
- Copy: accessible labels explicitly distinguish the upper controls from the lower expand control; visible product copy is unchanged.
- Expanded edge: outer left corners are 9px to match control-button curvature; the attached right corners are 3px, so the two edges no longer look symmetrical.

## Primary interactions and console

- Moved from the revealed orb through the upper transparent bridge into the locate button: menu remained open.
- Returned to the orb and moved through the lower transparent bridge into the expand button: menu remained open.
- Clicked the lower expand button: the compact card opened correctly.
- Clicked the `Minimize2` control in the expanded card: the player returned to the half-hidden orb.
- Browser console checked after default, hover, upper-path, lower-path, and expanded states: no warnings or errors.

## Comparison history

1. Earlier P1: shortcuts were placed to the left and the 8px dead gap caused the menu to close before the pointer reached a control. Fixed by splitting the actions into `is-above` and `is-below` groups and turning their 8px padding into continuous hover bridges. Post-fix evidence: `implementation-hover-upper.png` and `implementation-expanded.png`.
2. Earlier P2: the expanded left edge used a larger arc that did not match the controls, while the attached edge treatment was inconsistent between Mock and production. Fixed both implementations to `9px 3px 3px 9px`. Post-fix evidence: `comparison-card.png`.
3. Latest P2: a lone upward chevron did not communicate whether the action expanded, collapsed, or moved the player. Replaced it with the paired `Maximize2`/`Minimize2` convention in Mock and production. Post-fix evidence: `docs/audits/floating-expand-icon/comparison-focused.png`.

## Verification

- Node extension suite: 422 passed, 0 failed.
- React/WXT TypeScript check: passed.
- Chrome MV3 build: passed.
- Edge MV3 build: passed.
- Chrome/Edge store gate: passed.

final result: passed
